import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Pull approved/pending templates from the platform (admin) RCS Digital connection.
// Stores them as WhatsAppTemplate records with client_id='PLATFORM' so admin lifecycle
// flows can use them while keeping client templates separate.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }
    const svc = base44.asServiceRole;

    const cfgs = await svc.entities.PlatformMessagingConfig.list('-created_date', 1);
    if (cfgs.length === 0) return Response.json({ error: 'Platform messaging not configured' }, { status: 404 });
    const cfg = cfgs[0];
    if (!cfg.whatsapp_api_key || !cfg.whatsapp_business_id) {
      return Response.json({ error: 'Platform WABA ID and access token required' }, { status: 400 });
    }

    const baseHost = cfg.whatsapp_provider === 'rcs_digital'
      ? 'https://rcsdigital.in/v23.0'
      : 'https://graph.facebook.com/v20.0';
    const url = `${baseHost}/${cfg.whatsapp_business_id}/message_templates?limit=200`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfg.whatsapp_api_key}` } });
    const data = await res.json();
    if (!res.ok) return Response.json({ error: data.error?.message || 'Vendor API error', details: data }, { status: 400 });

    const remoteTemplates = data.data || [];
    const existing = await svc.entities.WhatsAppTemplate.filter({ client_id: 'PLATFORM' }, '-created_date', 500);
    const existingByKey = {};
    existing.forEach(t => { existingByKey[`${t.name}_${t.language}`] = t; });

    let created = 0, updated = 0;
    for (const t of remoteTemplates) {
      const components = t.components || [];
      const header = components.find(c => c.type === 'HEADER');
      const body = components.find(c => c.type === 'BODY');
      const footer = components.find(c => c.type === 'FOOTER');
      const buttonComp = components.find(c => c.type === 'BUTTONS');

      const record = {
        client_id: 'PLATFORM',
        vendor: cfg.whatsapp_provider,
        meta_template_id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        rejected_reason: t.rejected_reason || '',
        header_type: header?.format || 'NONE',
        header_text: header?.format === 'TEXT' ? (header.text || '') : '',
        body_text: body?.text || '',
        body_examples: body?.example?.body_text?.[0] || [],
        footer_text: footer?.text || '',
        buttons: (buttonComp?.buttons || []).map(b => ({
          type: b.type, text: b.text || '', url: b.url || '', phone_number: b.phone_number || ''
        })),
        last_synced: new Date().toISOString()
      };

      const key = `${t.name}_${t.language}`;
      if (existingByKey[key]) {
        await svc.entities.WhatsAppTemplate.update(existingByKey[key].id, record);
        updated++;
      } else {
        await svc.entities.WhatsAppTemplate.create({ ...record, linked_actions: [] });
        created++;
      }
    }

    return Response.json({ success: true, synced: remoteTemplates.length, created, updated });
  } catch (e) {
    console.error('[syncPlatformTemplates]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});