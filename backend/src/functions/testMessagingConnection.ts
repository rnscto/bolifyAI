import { Context } from "hono";
import { SMTPClient } from "emailjs";

export default async function (c: Context) {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id' }
    });
  }

  try {
    const payload = await c.req.json();
    const { channel, config, test_recipient, template_name, template_language } = payload;

    if (!channel || !config) {
      return c.json({ data: { success: false, error: 'channel and config are required' } });
    }

    // ===== WHATSAPP TEST =====
    if (channel === 'whatsapp') {
      const provider = config.whatsapp_provider;
      const apiKey = String(config.whatsapp_api_key || '').trim().replace(/^Bearer\s+/i, '');
      const phoneNumberId = String(config.whatsapp_phone_number_id || '').trim();

      if (!apiKey) return c.json({ data: { success: false, error: 'API key is required' } });

      if (provider === 'rcs_digital') {
        if (!phoneNumberId) return c.json({ data: { success: false, error: 'Phone Number ID required' } });
        const rawEndpoint = String(config.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
        let baseHost = rawEndpoint || 'https://rcsdigital.in';
        if (rawEndpoint) {
          try { baseHost = new URL(rawEndpoint).origin; } catch (_) { baseHost = rawEndpoint.replace(/\/v\d+\.\d+\/.*$/i, ''); }
        }
        const fullUrl = `${baseHost}/v23.0/${phoneNumberId}?fields=verified_name,display_phone_number`;
        console.log(`[testMessagingConnection/rcs_digital] GET ${fullUrl}`);
        const validateRes = await fetch(fullUrl, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const rawText = await validateRes.text();
        let validateData: any;
        try { validateData = JSON.parse(rawText); } catch (_) { validateData = { raw: rawText }; }
        
        const isErrorEnvelope = validateData?.isValid === false;
        if (validateRes.ok && !isErrorEnvelope) {
          return c.json({ data: {
            success: true,
            message: `RCS Digital connected — phone ${validateData.display_phone_number || phoneNumberId}`,
            details: validateData
          } });
        }
        const errMsg = isErrorEnvelope
          ? (validateData.response?.[0]?.message || 'RCS Digital rejected the request')
          : (validateData.error?.message || validateData.response?.[0]?.message || JSON.stringify(validateData));
        return c.json({ data: { success: false, error: errMsg } });
      }

      if (provider === 'meta_cloud') {
        const testPhone = test_recipient || phoneNumberId;
        const templateName = template_name;
        const templateLang = template_language || 'en_US';

        if (templateName) {
          const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: testPhone,
              type: 'template',
              template: { name: templateName, language: { code: templateLang } }
            })
          });
          const data = await res.json();
          if (res.ok && data.messages) {
            return c.json({ data: { success: true, message: `WhatsApp (Meta Cloud) connected! Template "${templateName}" sent.`, details: data } });
          }
          return c.json({ data: { success: false, error: data.error?.error_user_msg || data.error?.message || JSON.stringify(data) } });
        }

        const validateRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const validateData = await validateRes.json();
        if (validateRes.ok && validateData.id) {
          return c.json({ data: {
            success: true,
            message: `Credentials valid — verified phone: ${validateData.display_phone_number || phoneNumberId} (${validateData.verified_name || 'unverified'})`,
            details: validateData,
            requires_template: true
          } });
        }
        return c.json({ data: { success: false, error: validateData.error?.message || 'Invalid credentials. Check Access Token and Phone Number ID.' } });
      }

      if (provider === 'gupshup') {
        const endpoint = config.whatsapp_api_endpoint || 'https://api.gupshup.io/wa/api/v1/msg';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'apikey': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            channel: 'whatsapp',
            source: phoneNumberId || '',
            destination: test_recipient || phoneNumberId || '',
            message: JSON.stringify({ type: 'text', text: '✅ Bolify AI WhatsApp connection test successful!' }),
            'src.name': config.whatsapp_business_id || 'Bolify AI'
          })
        });
        const data = await res.json();
        if (data.status === 'submitted' || res.ok) {
          return c.json({ data: { success: true, message: 'WhatsApp (Gupshup) connected! Test message sent.', details: data } });
        }
        return c.json({ data: { success: false, error: data.message || JSON.stringify(data) } });
      }

      if (provider === 'interakt') {
        let baseHost = String(config.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
        if (!baseHost || !/^https?:\/\/api\.interakt\.ai/i.test(baseHost)) baseHost = 'https://api.interakt.ai';
        const url = `${baseHost}/v1/public/message/`;
        const templateName = template_name;
        const templateLang = template_language || 'en';

        if (!templateName) {
          return c.json({ data: { success: false, error: 'Interakt requires an approved template to test sending. Select a template, or sync your Interakt templates first.' } });
        }
        if (!test_recipient) {
          return c.json({ data: { success: false, error: 'A test recipient phone number is required for Interakt.' } });
        }

        let digits = String(test_recipient).replace(/[^0-9]/g, '');
        if (digits.length === 10) digits = '91' + digits;
        else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
        const countryCode = '+' + digits.slice(0, digits.length - 10);
        const phoneNumber = digits.slice(-10);

        const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(apiKey) && apiKey.length % 4 === 0;
        let interaktBasic = apiKey;
        if (looksBase64) {
          try {
            const decoded = atob(apiKey);
            interaktBasic = decoded.includes(':') ? apiKey : btoa(apiKey + ':');
          } catch (_) { interaktBasic = btoa(apiKey + ':'); }
        } else {
          interaktBasic = btoa(apiKey + ':');
        }
        
        console.log(`[testMessagingConnection/interakt] POST ${url}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${interaktBasic}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            countryCode,
            phoneNumber,
            type: 'Template',
            template: { name: templateName, languageCode: templateLang }
          })
        });
        const rawText = await res.text();
        let data: any; try { data = JSON.parse(rawText); } catch (_) { data = { raw: rawText }; }
        
        if (res.ok && data.result === true) {
          return c.json({ data: { success: true, message: `WhatsApp (Interakt) connected! Template "${templateName}" sent.`, details: data } });
        }
        if (res.status === 401) {
          return c.json({ data: { success: false, error: 'Interakt authentication failed — invalid API Key.' } });
        }
        return c.json({ data: { success: false, error: data.message || rawText || `Interakt rejected the request (HTTP ${res.status})` } });
      }

      if (provider === 'aisensy' || provider === 'wati') {
        const endpoint = config.whatsapp_api_endpoint;
        if (!endpoint) return c.json({ data: { success: false, error: 'API endpoint URL is required for this provider' } });

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: test_recipient || phoneNumberId,
            type: 'text',
            text: { body: '✅ Bolify AI WhatsApp connection test successful!' }
          })
        });
        const data = await res.text();
        if (res.ok) {
          return c.json({ data: { success: true, message: `WhatsApp (${provider}) connected!`, details: data } });
        }
        return c.json({ data: { success: false, error: data } });
      }

      if (provider === 'twilio') {
        const accountSid = config.whatsapp_business_id;
        const authToken = apiKey;
        const from = `whatsapp:${phoneNumberId}`;
        const to = `whatsapp:${test_recipient || phoneNumberId}`;

        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ From: from, To: to, Body: '✅ Bolify AI WhatsApp connection test successful!' })
        });
        const data = await res.json();
        if (res.ok && data.sid) {
          return c.json({ data: { success: true, message: 'WhatsApp (Twilio) connected!', details: { sid: data.sid } } });
        }
        return c.json({ data: { success: false, error: data.message || JSON.stringify(data) } });
      }

      if (provider === 'valuefirst') {
        const endpoint = config.whatsapp_api_endpoint || 'https://api.valuefirst.com/servlet/psms/JsonEncoder';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: test_recipient || phoneNumberId,
            body: '✅ Bolify AI WhatsApp connection test successful!'
          })
        });
        if (res.ok) {
          return c.json({ data: { success: true, message: 'WhatsApp (ValueFirst) connected!' } });
        }
        const errText = await res.text();
        return c.json({ data: { success: false, error: errText } });
      }

      return c.json({ data: { success: false, error: `Unsupported WhatsApp provider: ${provider}` } });
    }

    // ===== RCS / SMS TEST =====
    if (channel === 'rcs') {
      const provider = config.rcs_provider;
      const apiKey = config.rcs_api_key;

      if (!apiKey) return c.json({ data: { success: false, error: 'API key is required' } });

      if (provider === 'gupshup') {
        const endpoint = config.rcs_api_endpoint || 'https://enterprise.smsgupshup.com/GatewayAPI/rest';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            method: 'SendMessage',
            userid: config.rcs_sender_id || '',
            password: apiKey,
            msg: '✅ Bolify AI RCS test message',
            send_to: test_recipient || '',
            msg_type: 'TEXT',
            auth_scheme: 'plain'
          })
        });
        const data = await res.text();
        if (res.ok && (data.includes('success') || data.includes('sent'))) {
          return c.json({ data: { success: true, message: 'RCS (Gupshup) connected!' } });
        }
        return c.json({ data: { success: false, error: data } });
      }

      if (provider === 'kaleyra' || provider === 'route_mobile' || provider === 'smartflo') {
        const endpoint = config.rcs_api_endpoint;
        if (!endpoint) return c.json({ data: { success: false, error: 'API endpoint URL is required' } });

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: test_recipient || '',
            sender: config.rcs_sender_id || 'Bolify AI',
            type: 'rcs',
            body: '✅ Bolify AI RCS/SMS test message',
            fallback: 'sms'
          })
        });
        if (res.ok) {
          return c.json({ data: { success: true, message: `RCS (${provider}) connected!` } });
        }
        const errText = await res.text();
        return c.json({ data: { success: false, error: errText } });
      }

      if (provider === 'twilio') {
        const accountSid = config.rcs_sender_id;
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${accountSid}:${apiKey}`),
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ From: config.rcs_sender_id, To: test_recipient || '', Body: '✅ Bolify AI SMS test' })
        });
        const data = await res.json();
        if (res.ok && data.sid) {
          return c.json({ data: { success: true, message: 'SMS (Twilio) connected!' } });
        }
        return c.json({ data: { success: false, error: data.message || JSON.stringify(data) } });
      }

      return c.json({ data: { success: false, error: `Unsupported RCS provider: ${provider}` } });
    }

    // ===== EMAIL TEST =====
    if (channel === 'email') {
      const provider = config.email_provider;
      const testTo = test_recipient;
      const fromAddr = config.email_from_address || 'noreply@getway.ai';
      const fromName = config.email_from_name || 'Bolify AI';

      if (provider === 'smtp' || provider === 'ses') {
        if (!config.email_smtp_host || !config.email_smtp_user || !config.email_smtp_pass) {
          return c.json({ data: { success: false, error: 'SMTP host, username, and password are required' } });
        }
        if (!testTo) {
          return c.json({ data: { success: false, error: 'Test recipient email is required to verify the SMTP connection' } });
        }
        try {
          const port = parseInt(config.email_smtp_port) || 587;
          const useSSL = port === 465;
          const client = new SMTPClient({
            user: config.email_smtp_user,
            password: config.email_smtp_pass,
            host: config.email_smtp_host,
            port,
            ssl: useSSL,
            tls: !useSSL,
            timeout: 15000
          });
          const html = '<div style="font-family:Arial;padding:20px;"><h2>SMTP Connection Successful! ✅</h2><p>Your SMTP email integration with Bolify AI is configured correctly.</p><p style="color:#666;font-size:12px;">— Bolify AI Platform</p></div>';
          const message = await client.sendAsync({
            from: `${fromName} <${fromAddr || config.email_smtp_user}>`,
            to: testTo,
            subject: '✅ Bolify AI SMTP Connection Test',
            attachment: [{ data: html, alternative: true }]
          });
          return c.json({ data: {
            success: true,
            message: `SMTP connected! Test email sent to ${testTo}`,
            message_id: message?.header?.['message-id'] || null
          } });
        } catch (smtpErr: any) {
          console.error('[testMessagingConnection/smtp] SMTP error:', smtpErr?.message);
          let hint = '';
          const msg = (smtpErr?.message || '').toLowerCase();
          if (msg.includes('auth') || msg.includes('535') || msg.includes('credential')) hint = ' (Check username/password)';
          else if (msg.includes('connect') || msg.includes('timeout') || msg.includes('econn')) hint = ' (Cannot reach SMTP host)';
          else if (msg.includes('tls') || msg.includes('ssl')) hint = ' (TLS mismatch)';
          return c.json({ data: { success: false, error: `SMTP test failed: ${smtpErr?.message || smtpErr}${hint}` } });
        }
      }

      if (provider === 'resend') {
        if (!config.email_api_key) return c.json({ data: { success: false, error: 'Resend API key is required' } });
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.email_api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `${fromName} <${fromAddr}>`,
            to: testTo,
            subject: '✅ Bolify AI Email Test — Resend Connected',
            html: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your Resend email integration with Bolify AI is working perfectly.</p></div>'
          })
        });
        const data = await res.json();
        if (res.ok && data.id) {
          return c.json({ data: { success: true, message: `Email (Resend) connected! Test sent to ${testTo}` } });
        }
        return c.json({ data: { success: false, error: data.message || JSON.stringify(data) } });
      }

      if (provider === 'sendgrid') {
        if (!config.email_api_key) return c.json({ data: { success: false, error: 'SendGrid API key is required' } });
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.email_api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: testTo }] }],
            from: { email: fromAddr, name: fromName },
            subject: '✅ Bolify AI Email Test — SendGrid Connected',
            content: [{ type: 'text/html', value: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your SendGrid email integration with Bolify AI is working perfectly.</p></div>' }]
          })
        });
        if (res.status === 202 || res.ok) {
          return c.json({ data: { success: true, message: `Email (SendGrid) connected! Test sent to ${testTo}` } });
        }
        const errData = await res.text();
        return c.json({ data: { success: false, error: errData } });
      }

      if (provider === 'mailgun') {
        if (!config.email_api_key || !config.email_domain) return c.json({ data: { success: false, error: 'Mailgun API key and domain are required' } });
        
        const formData = new FormData();
        formData.append('from', `${fromName} <${fromAddr}>`);
        formData.append('to', testTo);
        formData.append('subject', '✅ Bolify AI Email Test — Mailgun Connected');
        formData.append('html', '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your Mailgun integration with Bolify AI is working.</p></div>');
        
        const res = await fetch(`https://api.mailgun.net/v3/${config.email_domain}/messages`, {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + btoa(`api:${config.email_api_key}`) },
          body: formData
        });
        const data = await res.json();
        if (res.ok) {
          return c.json({ data: { success: true, message: `Email (Mailgun) connected! Test sent to ${testTo}` } });
        }
        return c.json({ data: { success: false, error: data.message || JSON.stringify(data) } });
      }

      if (provider === 'postmark') {
        if (!config.email_api_key) return c.json({ data: { success: false, error: 'Postmark Server Token is required' } });
        const res = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: { 'X-Postmark-Server-Token': config.email_api_key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            From: `${fromName} <${fromAddr}>`,
            To: testTo,
            Subject: '✅ Bolify AI Email Test — Postmark Connected',
            HtmlBody: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your Postmark integration with Bolify AI is working.</p></div>'
          })
        });
        const data = await res.json();
        if (res.ok && data.MessageID) {
          return c.json({ data: { success: true, message: `Email (Postmark) connected! Test sent to ${testTo}` } });
        }
        return c.json({ data: { success: false, error: data.Message || JSON.stringify(data) } });
      }

      return c.json({ data: { success: false, error: `Unsupported email provider: ${provider}` } });
    }

    return c.json({ data: { success: false, error: 'Invalid channel. Use whatsapp, rcs, or email' } });

  } catch (error: any) {
    console.error('[testMessagingConnection] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
