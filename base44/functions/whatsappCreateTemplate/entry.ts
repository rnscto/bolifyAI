import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Creates a new WhatsApp template via Meta Cloud API and stores it locally.
// Meta will review the template (24-48 hours) — status will be PENDING initially.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const {
      client_id, name, language, category,
      header_type, header_text, header_media_url,
      body_text, body_examples, footer_text, buttons, linked_actions
    } = body;

    if (!client_id || !name || !body_text || !category) {
      return Response.json({ error: 'client_id, name, category, body_text are required' }, { status: 400 });
    }

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
      return Response.json({ error: 'Template creation is only supported for Meta Cloud API' }, { status: 400 });
    }
    if (!cfg.whatsapp_api_key || !cfg.whatsapp_business_id) {
      return Response.json({ error: 'WhatsApp Business Account ID and Access Token are required' }, { status: 400 });
    }

    // Build components for Meta API
    const components = [];

    // Header
    if (header_type && header_type !== 'NONE') {
      const header = { type: 'HEADER', format: header_type };
      if (header_type === 'TEXT' && header_text) {
        header.text = header_text;
      } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header_type) && header_media_url) {
        header.example = { header_handle: [header_media_url] };
      }
      components.push(header);
    }

    // Body (required)
    const bodyComp = { type: 'BODY', text: body_text };
    if (body_examples && body_examples.length > 0) {
      bodyComp.example = { body_text: [body_examples] };
    }
    components.push(bodyComp);

    // Footer
    if (footer_text) {
      components.push({ type: 'FOOTER', text: footer_text });
    }

    // Buttons
    if (buttons && buttons.length > 0) {
      const btns = buttons.map(b => {
        const btn = { type: b.type, text: b.text };
        if (b.type === 'URL' && b.url) btn.url = b.url;
        if (b.type === 'PHONE_NUMBER' && b.phone_number) btn.phone_number = b.phone_number;
        return btn;
      });
      components.push({ type: 'BUTTONS', buttons: btns });
    }

    // Submit to Meta
    const url = `https://graph.facebook.com/v20.0/${cfg.whatsapp_business_id}/message_templates`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.whatsapp_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        language: language || 'en',
        category,
        components
      })
    });

    const data = await res.json();
    if (!res.ok) {
      return Response.json({
        error: data.error?.error_user_msg || data.error?.message || 'Meta API rejected the template',
        details: data
      }, { status: 400 });
    }

    // Save locally
    const created = await svc.entities.WhatsAppTemplate.create({
      client_id,
      meta_template_id: data.id,
      name: name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      language: language || 'en',
      category,
      status: data.status || 'PENDING',
      header_type: header_type || 'NONE',
      header_text: header_text || '',
      header_media_url: header_media_url || '',
      body_text,
      body_examples: body_examples || [],
      footer_text: footer_text || '',
      buttons: buttons || [],
      linked_actions: linked_actions || [],
      last_synced: new Date().toISOString()
    });

    return Response.json({ success: true, template: created, meta_response: data });
  } catch (e) {
    console.error('[whatsappCreateTemplate]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});