import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Fetches WhatsApp templates from Meta Cloud API and syncs them to the WhatsAppTemplate entity.
// Only supports Meta Cloud API (other providers don't have a unified template API).
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { client_id } = await req.json();
    if (!client_id) return Response.json({ error: 'client_id required' }, { status: 400 });

    // Ownership check
    if (user.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (!clients.find(c => c.id === client_id)) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const svc = base44.asServiceRole;
    const configs = await svc.entities.ClientMessagingConfig.filter({ client_id });
    if (configs.length === 0) return Response.json({ error: 'No messaging config' }, { status: 404 });
    const cfg = configs[0];

    if (cfg.whatsapp_provider !== 'meta_cloud') {
      return Response.json({
        error: 'Templates are only supported for Meta Cloud API. Your current provider: ' + (cfg.whatsapp_provider || 'none')
      }, { status: 400 });
    }

    if (!cfg.whatsapp_api_key || !cfg.whatsapp_business_id) {
      return Response.json({ error: 'WhatsApp Business Account ID and Access Token are required' }, { status: 400 });
    }

    // Fetch templates from Meta
    const url = `https://graph.facebook.com/v20.0/${cfg.whatsapp_business_id}/message_templates?limit=200`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${cfg.whatsapp_api_key}` }
    });
    const data = await res.json();
    if (!res.ok) {
      return Response.json({ error: data.error?.message || 'Meta API error', details: data }, { status: 400 });
    }

    const metaTemplates = data.data || [];
    const existing = await svc.entities.WhatsAppTemplate.filter({ client_id }, '-created_date', 500);
    const existingByName = {};
    existing.forEach(t => { existingByName[`${t.name}_${t.language}`] = t; });

    let synced = 0, created = 0, updated = 0;
    for (const t of metaTemplates) {
      const components = t.components || [];
      const header = components.find(c => c.type === 'HEADER');
      const body = components.find(c => c.type === 'BODY');
      const footer = components.find(c => c.type === 'FOOTER');
      const buttonComp = components.find(c => c.type === 'BUTTONS');

      const record = {
        client_id,
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
          type: b.type,
          text: b.text || '',
          url: b.url || '',
          phone_number: b.phone_number || ''
        })),
        last_synced: new Date().toISOString()
      };

      const key = `${t.name}_${t.language}`;
      if (existingByName[key]) {
        // Preserve linked_actions from local copy
        await svc.entities.WhatsAppTemplate.update(existingByName[key].id, record);
        updated++;
      } else {
        await svc.entities.WhatsAppTemplate.create({ ...record, linked_actions: [] });
        created++;
      }
      synced++;
    }

    return Response.json({ success: true, synced, created, updated, total_meta: metaTemplates.length });
  } catch (e) {
    console.error('[whatsappListTemplates]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});