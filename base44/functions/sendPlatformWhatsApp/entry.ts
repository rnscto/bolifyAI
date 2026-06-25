import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.31';

// Send a WhatsApp template using the PLATFORM (admin) RCS Digital / Meta Cloud connection.
// Used for lifecycle nudges and admin broadcasts.
// Service-role: callable from automations and admin UI.
//
// Payload: { template_id, to, variables: [string], lead_id?, client_id?, outreach_type? }
//   - template_id: ID of a WhatsAppTemplate with client_id='PLATFORM' AND status='APPROVED'
//   - to: recipient phone (any format — auto-normalized to E.164 without +)
//   - variables: values for {{1}}, {{2}}... in template body
//   - client_id (optional): the recipient client (used for OutreachLog tracking)
Deno.serve(async (req) => {
  try {
    // Allow either authenticated admin or service role / cron
    let svc;
    const cronApiKey = req.headers.get('x-cron-key') || new URL(req.url).searchParams.get('api_key');
    const expectedCronKey = Deno.env.get('CRON_API_KEY');
    if (cronApiKey && cronApiKey === expectedCronKey) {
      const appId = Deno.env.get('BASE44_APP_ID');
      svc = createClient({ appId, asServiceRole: true });
    } else {
      const base44 = createClientFromRequest(req);
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
      svc = base44.asServiceRole;
    }

    const { template_id, to, variables, lead_id, client_id, outreach_type } = await req.json();
    if (!template_id || !to) {
      return Response.json({ error: 'template_id and to are required' }, { status: 400 });
    }

    // Load platform config (singleton — first record)
    const cfgs = await svc.entities.PlatformMessagingConfig.list('-created_at', 1);
    if (cfgs.length === 0) return Response.json({ error: 'Platform messaging not configured' }, { status: 404 });
    const cfg = cfgs[0];

    if (cfg.whatsapp_status !== 'connected') {
      return Response.json({ error: `Platform WhatsApp not connected (status: ${cfg.whatsapp_status})` }, { status: 400 });
    }
    if (!cfg.whatsapp_api_key || !cfg.whatsapp_phone_number_id) {
      return Response.json({ error: 'Platform WhatsApp credentials missing' }, { status: 400 });
    }

    const template = await svc.entities.WhatsAppTemplate.get(template_id);
    if (!template) return Response.json({ error: 'Template not found' }, { status: 404 });
    if (template.status !== 'APPROVED') {
      return Response.json({ error: `Template is ${template.status}, not APPROVED` }, { status: 400 });
    }

    // Phone normalization: India default
    let cleanTo = String(to).replace(/[^0-9]/g, '');
    if (cleanTo.length === 10) cleanTo = '91' + cleanTo;
    else if (cleanTo.length === 11 && cleanTo.startsWith('0')) cleanTo = '91' + cleanTo.slice(1);

    const components = [];
    const vars = variables || [];
    if (vars.length > 0) {
      components.push({
        type: 'body',
        parameters: vars.map(v => ({ type: 'text', text: String(v) }))
      });
    }

    const baseHost = cfg.whatsapp_provider === 'rcs_digital'
      ? `https://rcsdigital.in/v23.0`
      : `https://graph.facebook.com/v20.0`;
    const url = `${baseHost}/${cfg.whatsapp_phone_number_id}/messages`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.whatsapp_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanTo,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language || 'en' },
          ...(components.length > 0 ? { components } : {})
        }
      })
    });
    const data = await res.json();
    const messageId = data.messages?.[0]?.id;

    // Log outreach (use client_id if provided, else PLATFORM)
    try {
      await svc.entities.OutreachLog.create({
        client_id: client_id || 'PLATFORM',
        lead_id: lead_id || null,
        channel: 'whatsapp',
        direction: 'outbound',
        vendor: cfg.whatsapp_provider,
        vendor_message_id: messageId || null,
        template_id,
        template_name: template.name,
        recipient_phone: cleanTo,
        body: template.body_text || '',
        outreach_type: outreach_type || 'broadcast',
        status: res.ok ? 'sent' : 'failed',
        error_message: res.ok ? '' : (data.error?.error_user_msg || data.error?.message || JSON.stringify(data))
      });
    } catch (_) {}

    if (!res.ok) {
      return Response.json({ error: data.error?.error_user_msg || data.error?.message || 'Send failed', details: data }, { status: 400 });
    }

    await svc.entities.WhatsAppTemplate.update(template_id, { send_count: (template.send_count || 0) + 1 });
    return Response.json({ success: true, message_id: messageId });
  } catch (e) {
    console.error('[sendPlatformWhatsApp]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});