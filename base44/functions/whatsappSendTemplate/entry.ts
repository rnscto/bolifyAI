import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Sends an approved WhatsApp template message via Meta Cloud API.
// Used both for manual sends from the UI and for automated linked-action sends.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const reqBody = await req.json();
    const { template_id, recipient, variables, lead_id, call_log_id, outreach_type } = reqBody;
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

    if (!['meta_cloud', 'rcs_digital'].includes(cfg.whatsapp_provider)) {
      return Response.json({ error: 'Only Meta Cloud / RCS Digital supported for template sends' }, { status: 400 });
    }

    // Phone normalization helper — handles 10-digit Indian, leading-0, and already-prefixed formats
    const normalizePhone = (p) => {
      let n = String(p || '').replace(/[^0-9]/g, '');
      if (n.length === 10) n = '91' + n;
      else if (n.length === 11 && n.startsWith('0')) n = '91' + n.slice(1);
      return n;
    };

    // Build components with variables (interpolate {{name}} {{company}} {{phone}} {{email}} from lead if provided)
    let lead = null;
    if (lead_id) {
      try { lead = await svc.entities.Lead.get(lead_id); } catch (_) {}
    }
    if (!lead && template.client_id && template.client_id !== 'PLATFORM') {
      // recipient may be a lead phone — try multiple formats since DB may store +91/91/raw 10-digit
      const normalized = normalizePhone(recipient);
      const last10 = normalized.slice(-10);
      const candidates = [recipient, normalized, last10, '+' + normalized, '91' + last10];
      try {
        const allLeads = await svc.entities.Lead.filter({ client_id: template.client_id });
        lead = allLeads.find(l => {
          const lp = String(l.phone || '').replace(/[^0-9]/g, '');
          return candidates.some(c => String(c).replace(/[^0-9]/g, '') === lp || lp.endsWith(last10));
        }) || null;
      } catch (_) {}
    }
    const interpolate = (val) => {
      if (!lead) return String(val);
      return String(val)
        .replace(/\{\{name\}\}/gi, lead.name || '')
        .replace(/\{\{company\}\}/gi, lead.company || '')
        .replace(/\{\{phone\}\}/gi, lead.phone || '')
        .replace(/\{\{email\}\}/gi, lead.email || '');
    };

    const components = [];
    const vars = variables || [];
    if (vars.length > 0) {
      components.push({
        type: 'body',
        parameters: vars.map(v => ({ type: 'text', text: interpolate(v) }))
      });
    }

    // Normalize the recipient to the actual number we'll send to
    const cleanRecipient = normalizePhone(recipient);
    if (cleanRecipient.length < 11 || cleanRecipient.length > 15) {
      return Response.json({ error: `Invalid phone number after normalization: ${cleanRecipient}` }, { status: 400 });
    }

    const baseUrl = cfg.whatsapp_provider === 'rcs_digital'
      ? `https://rcsdigital.in/v23.0/${cfg.whatsapp_phone_number_id}/messages`
      : `https://graph.facebook.com/v20.0/${cfg.whatsapp_phone_number_id}/messages`;
    const url = baseUrl;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.whatsapp_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
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
    const messageId = data.messages?.[0]?.id;

    // Always log outreach
    try {
      await svc.entities.OutreachLog.create({
        client_id: template.client_id,
        lead_id: lead_id || lead?.id || null,
        call_log_id: call_log_id || null,
        channel: 'whatsapp',
        direction: 'outbound',
        vendor: cfg.whatsapp_provider,
        vendor_message_id: messageId || null,
        template_id: template_id,
        template_name: template.name,
        recipient_phone: cleanRecipient,
        body: template.body_text || '',
        outreach_type: outreach_type || 'lead_followup',
        status: res.ok ? 'sent' : 'failed',
        error_message: res.ok ? '' : (data.error?.error_user_msg || data.error?.message || JSON.stringify(data))
      });
    } catch (_) {}

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

    return Response.json({ success: true, message_id: messageId, details: data });
  } catch (e) {
    console.error('[whatsappSendTemplate]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
});