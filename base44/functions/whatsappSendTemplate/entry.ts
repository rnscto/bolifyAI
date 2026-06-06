import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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

    if (!['meta_cloud', 'rcs_digital', 'interakt'].includes(cfg.whatsapp_provider)) {
      return Response.json({ error: 'Only Meta Cloud / RCS Digital / Interakt supported for template sends' }, { status: 400 });
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

    // Sanitize API key (shared by all providers): strip whitespace + accidental prefix
    const apiKeyRaw = String(cfg.whatsapp_api_key || '').trim().replace(/^(Bearer|Basic)\s+/i, '');

    // Interakt Basic-auth value = base64(secretKey + ':'). If the user already pasted a
    // base64-encoded value (decodes to something containing ":"), use it verbatim.
    const buildInteraktBasic = (rawKey) => {
      const key = String(rawKey || '').trim();
      if (!key) return '';
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(key) && key.length % 4 === 0) {
        try { if (atob(key).includes(':')) return key; } catch (_) {}
      }
      return btoa(key.endsWith(':') ? key : key + ':');
    };

    // ===== INTERAKT BRANCH =====
    // Interakt has a distinct API: Basic auth, /v1/public/message/, split countryCode+phoneNumber,
    // and headerValues/bodyValues/buttonValues arrays instead of Meta's components structure.
    if (cfg.whatsapp_provider === 'interakt') {
      let baseHost = String(cfg.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
      if (!baseHost || !/^https?:\/\/api\.interakt\.ai/i.test(baseHost)) baseHost = 'https://api.interakt.ai';
      const url = `${baseHost}/v1/public/message/`;

      // Split recipient into countryCode + phoneNumber (no leading 0, no country code in phoneNumber)
      let digits = normalizePhone(recipient);
      if (digits.length < 11 || digits.length > 15) {
        return Response.json({ error: `Invalid phone number after normalization: ${digits}` }, { status: 400 });
      }
      const countryCode = '+' + digits.slice(0, digits.length - 10);
      const phoneNumber = digits.slice(-10);

      const bodyValues = (variables || []).map(v => interpolate(v));
      const tmpl = { name: template.name, languageCode: template.language || 'en' };
      if (bodyValues.length > 0) tmpl.bodyValues = bodyValues;

      // Media header → headerValues holds the media URL
      const hType = (template.header_type || 'NONE').toUpperCase();
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(hType)) {
        if (!template.header_media_url) {
          return Response.json({ error: `Template "${template.name}" has a ${hType} header but no header_media_url is set.` }, { status: 400 });
        }
        tmpl.headerValues = [template.header_media_url];
        if (hType === 'DOCUMENT') tmpl.fileName = (template.name || 'document') + '.pdf';
      }

      const interaktBasic = buildInteraktBasic(apiKeyRaw);
      console.log(`[whatsappSendTemplate/interakt] → POST ${url} (cc=${countryCode}, phone=${phoneNumber}, template=${template.name})`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${interaktBasic}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryCode, phoneNumber, type: 'Template', callbackData: call_log_id || lead_id || '', template: tmpl })
      });
      const rawText = await res.text();
      let data; try { data = JSON.parse(rawText); } catch (_) { data = { raw: rawText }; }
      console.log(`[whatsappSendTemplate/interakt] ← HTTP ${res.status}: ${rawText.substring(0, 400)}`);

      const ok = res.ok && data.result === true;
      const messageId = data.id || null;

      try {
        await svc.entities.OutreachLog.create({
          client_id: template.client_id,
          lead_id: lead_id || lead?.id || null,
          call_log_id: call_log_id || null,
          channel: 'whatsapp', direction: 'outbound', vendor: 'interakt',
          vendor_message_id: messageId, template_id, template_name: template.name,
          recipient_phone: phoneNumber, body: template.body_text || '',
          outreach_type: outreach_type || 'lead_followup',
          status: ok ? 'sent' : 'failed',
          error_message: ok ? '' : (data.message || rawText)
        });
      } catch (_) {}

      if (!ok) {
        let friendly = data.message || rawText || 'Interakt send failed';
        if (res.status === 401) friendly = 'Interakt authentication failed — invalid API Key. Get the raw key from app.interakt.ai → Settings → Developer Settings.';
        else if (res.status === 429) friendly = 'Interakt rate limit exceeded. Please retry shortly.';
        return Response.json({ error: friendly, details: data }, { status: 400 });
      }

      await svc.entities.WhatsAppTemplate.update(template_id, { send_count: (template.send_count || 0) + 1 });
      return Response.json({ success: true, message_id: messageId, details: data });
    }

    const components = [];

    // Header component: required when template has IMAGE/VIDEO/DOCUMENT header
    const headerType = (template.header_type || 'NONE').toUpperCase();
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType)) {
      const mediaUrl = template.header_media_url;
      if (mediaUrl) {
        const mediaKey = headerType.toLowerCase(); // image | video | document
        components.push({
          type: 'header',
          parameters: [{ type: mediaKey, [mediaKey]: { link: mediaUrl } }]
        });
      } else {
        return Response.json({
          error: `Template "${template.name}" has a ${headerType} header but no header_media_url is set. Please edit the template and add a media URL.`
        }, { status: 400 });
      }
    }

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

    // Sanitize: strip whitespace + remove accidental "Bearer " prefix
    const apiKey = apiKeyRaw;
    const phoneNumberId = String(cfg.whatsapp_phone_number_id || '').trim();
    if (!phoneNumberId) {
      return Response.json({ error: 'Phone Number ID is not configured. Please add it in Integrations.' }, { status: 400 });
    }
    // RCS Digital tenants vary by host (rcsdigital.in, icpaas.in, etc.) — honor the
    // configured whatsapp_api_endpoint when provided, otherwise fall back to defaults.
    const customHost = String(cfg.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
    const baseUrl = cfg.whatsapp_provider === 'rcs_digital'
      ? `${customHost || 'https://rcsdigital.in'}/v23.0/${phoneNumberId}/messages`
      : `${customHost || 'https://graph.facebook.com/v20.0'}/${phoneNumberId}/messages`.replace('/v20.0//', '/v20.0/');
    const url = baseUrl;
    console.log(`[whatsappSendTemplate] → POST ${url} (to=${cleanRecipient}, template=${template.name})`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
    console.log(`[whatsappSendTemplate] ← HTTP ${res.status}: ${JSON.stringify(data).substring(0, 400)}`);
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
      const metaErr = data.error || {};
      let friendly = metaErr.error_user_msg || metaErr.message || 'Send failed';
      if (metaErr.code === 190 || res.status === 401) {
        friendly = `Authentication failed (Meta error 190). Access Token is invalid or expired. Regenerate your System User Token at business.facebook.com.`;
      } else if (metaErr.code === 131026) {
        friendly = `Recipient hasn't opted-in or 24-hour window expired. Template messages require a valid phone number registered with WhatsApp.`;
      } else if (metaErr.code === 132000 || metaErr.code === 132001) {
        friendly = `Template "${template.name}" not found or wrong language. Sync templates first from the Templates page.`;
      }
      return Response.json({ error: friendly, details: data }, { status: 400 });
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