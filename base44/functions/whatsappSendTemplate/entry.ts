import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Sends an approved WhatsApp template message via Meta Cloud API.
// Used both for manual sends from the UI and for automated linked-action sends.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { template_id, recipient, variables } = await req.json();
    if (!template_id || !recipient) {
      return Response.json({ error: 'template_id and recipient are required' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const template = await svc.entities.WhatsAppTemplate.get(template_id);
    if (!template) return Response.json({ error: 'Template not found' }, { status: 404 });

    // Ownership check
    if (user.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (!clients.find(c => c.id === template.client_id)) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    if (template.status !== 'APPROVED') {
      return Response.json({ error: `Template is ${template.status}, not APPROVED. Cannot send.` }, { status: 400 });
    }

    const configs = await svc.entities.ClientMessagingConfig.filter({ client_id: template.client_id });
    if (configs.length === 0) return Response.json({ error: 'No messaging config' }, { status: 404 });
    const cfg = configs[0];

    if (cfg.whatsapp_provider !== 'meta_cloud') {
      return Response.json({ error: 'Only Meta Cloud API supported for sending templates' }, { status: 400 });
    }

    // Build components with variables
    const components = [];
    const vars = variables || [];
    if (vars.length > 0) {
      components.push({
        type: 'body',
        parameters: vars.map(v => ({ type: 'text', text: String(v) }))
      });
    }

    const cleanRecipient = String(recipient).replace(/[^0-9]/g, '');

    const url = `https://graph.facebook.com/v20.0/${cfg.whatsapp_phone_number_id}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.whatsapp_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanRecipient,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language || 'en' },
          ...(components.length > 0 ? { components } : {})
        }
      })
    });

    const data = await res.json();
    if (!res.ok) {
      return Response.json({
        error: data.error?.error_user_msg || data.error?.message || 'Send failed',
        details: data
      }, { status: 400 });
    }

    // Increment send count
    await svc.entities.WhatsAppTemplate.update(template_id, {
      send_count: (template.send_count || 0) + 1
    });

    return Response.json({ success: true, message_id: data.messages?.[0]?.id, details: data });
  } catch (e) {
    console.error('[whatsappSendTemplate]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});