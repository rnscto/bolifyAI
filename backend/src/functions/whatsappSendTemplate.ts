import { Context } from "hono";
import { base44ORM } from "../db/orm.ts";

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const { template_id, recipient, variables, lead_id, call_log_id, outreach_type, internal_service } = payload;
    
    if (!template_id || !recipient) {
      return c.json({ data: { success: false, error: 'template_id and recipient are required' } });
    }

    const template = await base44ORM.entities.WhatsAppTemplate.get(template_id);
    if (!template) {
      return c.json({ data: { success: false, error: 'Template not found' } });
    }

    if (template.status !== 'APPROVED') {
      return c.json({ data: { success: false, error: `Template is ${template.status}, not APPROVED. Cannot send.` } });
    }

    const configs = await base44ORM.entities.ClientMessagingConfig.filter({ client_id: template.client_id });
    if (configs.length === 0) {
      return c.json({ data: { success: false, error: 'No messaging config found for this client.' } });
    }
    const cfg = configs[0];

    if (!['meta_cloud', 'rcs_digital', 'interakt'].includes(cfg.whatsapp_provider)) {
      return c.json({ data: { success: false, error: 'Only Meta Cloud / RCS Digital / Interakt supported for template sends' } });
    }

    const normalizePhone = (p: string) => {
      let n = String(p || '').replace(/[^0-9]/g, '');
      if (n.length === 10) n = '91' + n;
      else if (n.length === 11 && n.startsWith('0')) n = '91' + n.slice(1);
      return n;
    };

    let lead: any = null;
    if (lead_id) {
      try { lead = await base44ORM.entities.Lead.get(lead_id); } catch (_) {}
    }

    const needsLeadLookup = /\{\{(name|company|phone|email)\}\}/i.test(template.body_text || '');
    if (!lead && needsLeadLookup && template.client_id && template.client_id !== 'PLATFORM') {
      const normalized = normalizePhone(recipient);
      try {
        const matches = await base44ORM.entities.Lead.filter({ client_id: template.client_id, phone: recipient }, '-updated_date', 1);
        lead = matches[0] || null;
      } catch (_) {}
    }

    const interpolate = (val: string) => {
      if (!lead) return String(val);
      return String(val)
        .replace(/\{\{name\}\}/gi, lead.name || '')
        .replace(/\{\{company\}\}/gi, lead.company || '')
        .replace(/\{\{phone\}\}/gi, lead.phone || '')
        .replace(/\{\{email\}\}/gi, lead.email || '');
    };

    const apiKeyRaw = String(cfg.whatsapp_api_key || '').trim().replace(/^(Bearer|Basic)\s+/i, '');

    const interaktBasicCredential = (rawKey: string) => {
      const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(rawKey) && rawKey.length % 4 === 0;
      if (looksBase64) {
        try {
          const decoded = atob(rawKey);
          return decoded.includes(':') ? rawKey : btoa(rawKey + ':');
        } catch (_) { return btoa(rawKey + ':'); }
      }
      return btoa(rawKey + ':');
    };

    // ===== INTERAKT BRANCH =====
    if (cfg.whatsapp_provider === 'interakt') {
      let baseHost = String(cfg.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
      if (!baseHost || !/^https?:\/\/api\.interakt\.ai/i.test(baseHost)) baseHost = 'https://api.interakt.ai';
      const url = `${baseHost}/v1/public/message/`;

      let digits = normalizePhone(recipient);
      if (digits.length < 11 || digits.length > 15) {
        return c.json({ data: { success: false, error: `Invalid phone number after normalization: ${digits}` } });
      }
      const countryCode = '+' + digits.slice(0, digits.length - 10);
      const phoneNumber = digits.slice(-10);

      const bodyValues = (variables || []).map((v: string) => interpolate(v));
      const tmpl: any = { name: template.name, languageCode: template.language || 'en' };
      if (bodyValues.length > 0) tmpl.bodyValues = bodyValues;

      const hType = (template.header_type || 'NONE').toUpperCase();
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(hType)) {
        if (!template.header_media_url) {
          return c.json({ data: { success: false, error: `Template "${template.name}" has a ${hType} header but no media URL set.` } });
        }
        tmpl.headerValues = [template.header_media_url];
        if (hType === 'DOCUMENT') tmpl.fileName = (template.name || 'document') + '.pdf';
      }

      console.log(`[whatsappSendTemplate/interakt] POST ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${interaktBasicCredential(apiKeyRaw)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryCode, phoneNumber, type: 'Template', callbackData: call_log_id || lead_id || '', template: tmpl })
      });
      const rawText = await res.text();
      let data: any; try { data = JSON.parse(rawText); } catch (_) { data = { raw: rawText }; }

      const ok = res.ok && data.result === true;
      const messageId = data.id || null;

      try {
        await base44ORM.entities.OutreachLog.create({
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
        if (res.status === 401) friendly = 'Interakt authentication failed.';
        else if (res.status === 429) friendly = 'Interakt rate limit exceeded.';
        return c.json({ data: { success: false, error: friendly, details: data } });
      }

      try { await base44ORM.entities.WhatsAppTemplate.update(template_id, { send_count: (template.send_count || 0) + 1 }); } catch (_) {}
      return c.json({ data: { success: true, message_id: messageId, details: data } });
    }

    // ===== META CLOUD / RCS DIGITAL BRANCH =====
    const components: any[] = [];
    const headerType = (template.header_type || 'NONE').toUpperCase();
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType)) {
      const mediaUrl = template.header_media_url;
      if (mediaUrl) {
        const mediaKey = headerType.toLowerCase();
        components.push({
          type: 'header',
          parameters: [{ type: mediaKey, [mediaKey]: { link: mediaUrl } }]
        });
      } else {
        const errMsg = `Template "${template.name}" has a ${headerType} header but no media URL set.`;
        try {
          await base44ORM.entities.OutreachLog.create({
            client_id: template.client_id,
            lead_id: lead_id || lead?.id || null,
            call_log_id: call_log_id || null,
            channel: 'whatsapp', direction: 'outbound', vendor: cfg.whatsapp_provider,
            template_id, template_name: template.name,
            recipient_phone: normalizePhone(recipient),
            body: template.body_text || '',
            outreach_type: outreach_type || 'lead_followup',
            status: 'failed', error_message: errMsg
          });
        } catch (_) {}
        return c.json({ data: { success: false, error: errMsg } });
      }
    }

    const vars = variables || [];
    if (vars.length > 0) {
      components.push({
        type: 'body',
        parameters: vars.map((v: string) => ({ type: 'text', text: interpolate(v) }))
      });
    }

    const cleanRecipient = normalizePhone(recipient);
    if (cleanRecipient.length < 11 || cleanRecipient.length > 15) {
      return c.json({ data: { success: false, error: `Invalid phone number after normalization: ${cleanRecipient}` } });
    }

    const apiKey = apiKeyRaw;
    const phoneNumberId = String(cfg.whatsapp_phone_number_id || '').trim();
    if (!phoneNumberId) {
      return c.json({ data: { success: false, error: 'Phone Number ID is not configured.' } });
    }

    const rawEndpoint = String(cfg.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
    let rcsHost = rawEndpoint;
    if (cfg.whatsapp_provider === 'rcs_digital' && rawEndpoint) {
      try { rcsHost = new URL(rawEndpoint).origin; } catch (_) { rcsHost = rawEndpoint.replace(/\/v\d+\.\d+\/.*$/i, ''); }
    }
    const customHost = rawEndpoint;
    const baseUrl = cfg.whatsapp_provider === 'rcs_digital'
      ? `${rcsHost || 'https://rcsdigital.in'}/v23.0/${phoneNumberId}/messages`
      : `${customHost || 'https://graph.facebook.com/v20.0'}/${phoneNumberId}/messages`.replace('/v20.0//', '/v20.0/');
      
    console.log(`[whatsappSendTemplate] POST ${baseUrl}`);
    
    const res = await fetch(baseUrl, {
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
    console.log(`[whatsappSendTemplate] HTTP ${res.status}`);
    const messageId = data.messages?.[0]?.id;

    try {
      await base44ORM.entities.OutreachLog.create({
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
        friendly = `Authentication failed. Access Token is invalid or expired.`;
      } else if (metaErr.code === 131026) {
        friendly = `Recipient hasn't opted-in or 24-hour window expired.`;
      } else if (metaErr.code === 132000 || metaErr.code === 132001) {
        friendly = `Template "${template.name}" not found.`;
      }
      return c.json({ data: { success: false, error: friendly, details: data } });
    }

    try {
      await base44ORM.entities.WhatsAppTemplate.update(template_id, {
        send_count: (template.send_count || 0) + 1
      });
    } catch (_) {}

    return c.json({ data: { success: true, message_id: messageId, details: data } });

  } catch (error: any) {
    console.error('[whatsappSendTemplate] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
