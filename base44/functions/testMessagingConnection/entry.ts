import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id' }
    });
  }

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { channel, config, test_recipient } = body;

    if (!channel || !config) {
      return Response.json({ error: 'channel and config are required' }, { status: 400 });
    }

    // ===== WHATSAPP TEST =====
    if (channel === 'whatsapp') {
      const provider = config.whatsapp_provider;
      // Sanitize: strip whitespace + accidental "Bearer " prefix users paste
      const apiKey = String(config.whatsapp_api_key || '').trim().replace(/^Bearer\s+/i, '');
      const phoneNumberId = String(config.whatsapp_phone_number_id || '').trim();

      if (!apiKey) return Response.json({ success: false, error: 'API key is required' });

      if (provider === 'rcs_digital') {
        // RCS Digital is Meta-compatible. Default host is rcsdigital.in, but some tenants
        // (e.g. icpaas.in) use a different base URL — allow override via whatsapp_api_endpoint.
        if (!phoneNumberId) return Response.json({ success: false, error: 'Phone Number ID required' });
        const customHost = String(config.whatsapp_api_endpoint || '').trim().replace(/\/+$/, '');
        const baseHost = customHost || 'https://rcsdigital.in';
        const tokenPreview = apiKey.length > 12 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)} (len=${apiKey.length})` : `(len=${apiKey.length})`;
        const fullUrl = `${baseHost}/v23.0/${phoneNumberId}?fields=verified_name,display_phone_number`;
        console.log(`[testMessagingConnection/rcs_digital] → GET ${fullUrl}`);
        console.log(`[testMessagingConnection/rcs_digital] → Phone Number ID: "${phoneNumberId}", Token: ${tokenPreview}`);
        const validateRes = await fetch(fullUrl, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const rawText = await validateRes.text();
        let validateData;
        try { validateData = JSON.parse(rawText); } catch (_) { validateData = { raw: rawText }; }
        console.log(`[testMessagingConnection/rcs_digital] ← HTTP ${validateRes.status} ${validateRes.statusText}`);
        console.log(`[testMessagingConnection/rcs_digital] ← Response body: ${rawText.substring(0, 1500)}`);
        // RCS Digital sometimes returns HTTP 200 with an error envelope { isValid: false, response: [...] }
        const isErrorEnvelope = validateData?.isValid === false;
        if (validateRes.ok && !isErrorEnvelope) {
          return Response.json({
            success: true,
            message: `RCS Digital connected — phone ${validateData.display_phone_number || phoneNumberId}`,
            details: validateData
          });
        }
        const errMsg = isErrorEnvelope
          ? (validateData.response?.[0]?.message || 'RCS Digital rejected the request')
          : (validateData.error?.message || validateData.response?.[0]?.message || JSON.stringify(validateData));
        return Response.json({ success: false, error: errMsg });
      }

      if (provider === 'meta_cloud') {
        // Meta Cloud API requires templates for first-time recipient outside 24h window.
        // If template_name is provided, send via template; otherwise validate creds via /me.
        const testPhone = test_recipient || phoneNumberId;
        const templateName = body.template_name;
        const templateLang = body.template_language || 'en_US';

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
            return Response.json({ success: true, message: `WhatsApp (Meta Cloud) connected! Template "${templateName}" sent.`, details: data });
          }
          return Response.json({ success: false, error: data.error?.error_user_msg || data.error?.message || JSON.stringify(data) });
        }

        // No template selected — validate credentials by hitting the WABA endpoint
        const validateRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const validateData = await validateRes.json();
        if (validateRes.ok && validateData.id) {
          return Response.json({
            success: true,
            message: `Credentials valid — verified phone: ${validateData.display_phone_number || phoneNumberId} (${validateData.verified_name || 'unverified'})`,
            details: validateData,
            requires_template: true
          });
        }
        return Response.json({ success: false, error: validateData.error?.message || 'Invalid credentials. Check Access Token and Phone Number ID.' });
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
            message: JSON.stringify({ type: 'text', text: '✅ VaaniAI WhatsApp connection test successful!' }),
            'src.name': config.whatsapp_business_id || 'VaaniAI'
          })
        });
        const data = await res.json();
        if (data.status === 'submitted' || res.ok) {
          return Response.json({ success: true, message: 'WhatsApp (Gupshup) connected! Test message sent.', details: data });
        }
        return Response.json({ success: false, error: data.message || JSON.stringify(data) });
      }

      if (provider === 'aisensy' || provider === 'wati' || provider === 'interakt') {
        // Generic API-key based providers
        const endpoint = config.whatsapp_api_endpoint;
        if (!endpoint) return Response.json({ success: false, error: 'API endpoint URL is required for this provider' });

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: test_recipient || phoneNumberId,
            type: 'text',
            text: { body: '✅ VaaniAI WhatsApp connection test successful!' }
          })
        });
        const data = await res.text();
        if (res.ok) {
          return Response.json({ success: true, message: `WhatsApp (${provider}) connected!`, details: data });
        }
        return Response.json({ success: false, error: data });
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
          body: new URLSearchParams({ From: from, To: to, Body: '✅ VaaniAI WhatsApp connection test successful!' })
        });
        const data = await res.json();
        if (res.ok && data.sid) {
          return Response.json({ success: true, message: 'WhatsApp (Twilio) connected!', details: { sid: data.sid } });
        }
        return Response.json({ success: false, error: data.message || JSON.stringify(data) });
      }

      if (provider === 'valuefirst') {
        const endpoint = config.whatsapp_api_endpoint || 'https://api.valuefirst.com/servlet/psms/JsonEncoder';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: test_recipient || phoneNumberId,
            body: '✅ VaaniAI WhatsApp connection test successful!'
          })
        });
        if (res.ok) {
          return Response.json({ success: true, message: 'WhatsApp (ValueFirst) connected!' });
        }
        const errText = await res.text();
        return Response.json({ success: false, error: errText });
      }

      return Response.json({ success: false, error: `Unsupported WhatsApp provider: ${provider}` });
    }

    // ===== RCS / SMS TEST =====
    if (channel === 'rcs') {
      const provider = config.rcs_provider;
      const apiKey = config.rcs_api_key;

      if (!apiKey) return Response.json({ success: false, error: 'API key is required' });

      if (provider === 'gupshup') {
        const endpoint = config.rcs_api_endpoint || 'https://enterprise.smsgupshup.com/GatewayAPI/rest';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            method: 'SendMessage',
            userid: config.rcs_sender_id || '',
            password: apiKey,
            msg: '✅ VaaniAI RCS test message',
            send_to: test_recipient || '',
            msg_type: 'TEXT',
            auth_scheme: 'plain'
          })
        });
        const data = await res.text();
        if (res.ok && (data.includes('success') || data.includes('sent'))) {
          return Response.json({ success: true, message: 'RCS (Gupshup) connected!' });
        }
        return Response.json({ success: false, error: data });
      }

      if (provider === 'kaleyra' || provider === 'route_mobile' || provider === 'smartflo') {
        const endpoint = config.rcs_api_endpoint;
        if (!endpoint) return Response.json({ success: false, error: 'API endpoint URL is required' });

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: test_recipient || '',
            sender: config.rcs_sender_id || 'VaaniAI',
            type: 'rcs',
            body: '✅ VaaniAI RCS/SMS test message',
            fallback: 'sms'
          })
        });
        if (res.ok) {
          return Response.json({ success: true, message: `RCS (${provider}) connected!` });
        }
        const errText = await res.text();
        return Response.json({ success: false, error: errText });
      }

      if (provider === 'twilio') {
        const accountSid = config.rcs_sender_id;
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${accountSid}:${apiKey}`),
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ From: config.rcs_sender_id, To: test_recipient || '', Body: '✅ VaaniAI SMS test' })
        });
        const data = await res.json();
        if (res.ok && data.sid) {
          return Response.json({ success: true, message: 'SMS (Twilio) connected!' });
        }
        return Response.json({ success: false, error: data.message || JSON.stringify(data) });
      }

      return Response.json({ success: false, error: `Unsupported RCS provider: ${provider}` });
    }

    // ===== EMAIL TEST =====
    if (channel === 'email') {
      const provider = config.email_provider;
      const testTo = test_recipient || user.email;
      const fromAddr = config.email_from_address || 'noreply@vaaniai.io';
      const fromName = config.email_from_name || 'VaaniAI';

      if (provider === 'smtp' || provider === 'ses') {
        // Actually test the SMTP connection by sending a real test email via the emailjs library
        if (!config.email_smtp_host || !config.email_smtp_user || !config.email_smtp_pass) {
          return Response.json({ success: false, error: 'SMTP host, username, and password are required' });
        }
        if (!testTo) {
          return Response.json({ success: false, error: 'Test recipient email is required to verify the SMTP connection' });
        }
        try {
          const { SMTPClient } = await import('npm:emailjs@4.0.3');
          const port = parseInt(config.email_smtp_port) || 587;
          // Port 465 = implicit SSL; 587/25 = STARTTLS
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
          return Response.json({
            success: true,
            message: `SMTP connected! Test email sent to ${testTo}`,
            message_id: message?.header?.['message-id'] || null
          });
        } catch (smtpErr) {
          console.error('[testMessagingConnection/smtp] SMTP error:', smtpErr?.message, smtpErr?.code, smtpErr?.smtp);
          let hint = '';
          const msg = (smtpErr?.message || '').toLowerCase();
          if (msg.includes('auth') || msg.includes('535') || msg.includes('credential')) hint = ' (Check username/password — for Gmail use an App Password, not your account password.)';
          else if (msg.includes('connect') || msg.includes('timeout') || msg.includes('econn')) hint = ' (Cannot reach SMTP host — verify host & port. Try 587 for STARTTLS or 465 for SSL.)';
          else if (msg.includes('tls') || msg.includes('ssl')) hint = ' (TLS mismatch — port 465 needs SSL, port 587 needs STARTTLS.)';
          return Response.json({ success: false, error: `SMTP test failed: ${smtpErr?.message || smtpErr}${hint}` });
        }
      }

      if (provider === 'resend') {
        if (!config.email_api_key) return Response.json({ success: false, error: 'Resend API key is required' });
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.email_api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `${fromName} <${fromAddr}>`,
            to: testTo,
            subject: '✅ VaaniAI Email Test — Resend Connected',
            html: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your Resend email integration with VaaniAI is working perfectly.</p><p style="color:#666;font-size:12px;">— VaaniAI Platform</p></div>'
          })
        });
        const data = await res.json();
        if (res.ok && data.id) {
          return Response.json({ success: true, message: `Email (Resend) connected! Test sent to ${testTo}` });
        }
        return Response.json({ success: false, error: data.message || JSON.stringify(data) });
      }

      if (provider === 'sendgrid') {
        if (!config.email_api_key) return Response.json({ success: false, error: 'SendGrid API key is required' });
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.email_api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: testTo }] }],
            from: { email: fromAddr, name: fromName },
            subject: '✅ VaaniAI Email Test — SendGrid Connected',
            content: [{ type: 'text/html', value: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your SendGrid email integration with VaaniAI is working perfectly.</p></div>' }]
          })
        });
        if (res.status === 202 || res.ok) {
          return Response.json({ success: true, message: `Email (SendGrid) connected! Test sent to ${testTo}` });
        }
        const errData = await res.text();
        return Response.json({ success: false, error: errData });
      }

      if (provider === 'mailgun') {
        if (!config.email_api_key || !config.email_domain) return Response.json({ success: false, error: 'Mailgun API key and domain are required' });
        const res = await fetch(`https://api.mailgun.net/v3/${config.email_domain}/messages`, {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + btoa(`api:${config.email_api_key}`), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            from: `${fromName} <${fromAddr}>`,
            to: testTo,
            subject: '✅ VaaniAI Email Test — Mailgun Connected',
            html: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your Mailgun integration with VaaniAI is working.</p></div>'
          })
        });
        const data = await res.json();
        if (res.ok) {
          return Response.json({ success: true, message: `Email (Mailgun) connected! Test sent to ${testTo}` });
        }
        return Response.json({ success: false, error: data.message || JSON.stringify(data) });
      }

      if (provider === 'postmark') {
        if (!config.email_api_key) return Response.json({ success: false, error: 'Postmark Server Token is required' });
        const res = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: { 'X-Postmark-Server-Token': config.email_api_key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            From: `${fromName} <${fromAddr}>`,
            To: testTo,
            Subject: '✅ VaaniAI Email Test — Postmark Connected',
            HtmlBody: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your Postmark integration with VaaniAI is working.</p></div>'
          })
        });
        const data = await res.json();
        if (res.ok && data.MessageID) {
          return Response.json({ success: true, message: `Email (Postmark) connected! Test sent to ${testTo}` });
        }
        return Response.json({ success: false, error: data.Message || JSON.stringify(data) });
      }

      return Response.json({ success: false, error: `Unsupported email provider: ${provider}` });
    }

    return Response.json({ error: 'Invalid channel. Use whatsapp, rcs, or email' }, { status: 400 });

  } catch (error) {
    console.error('[testMessagingConnection] Error:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});