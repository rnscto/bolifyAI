import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function testMessagingConnection(c: any) {
  const req = c.req.raw || c.req;
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id' }
    });
  }

  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const { channel, config, test_recipient } = body;

    if (!channel || !config) {
      return c.json({ data: { error: 'channel and config are required' } }, 400);
    }

    // ===== WHATSAPP TEST =====
    if (channel === 'whatsapp') {
      const provider = config.whatsapp_provider;
      const apiKey = config.whatsapp_api_key;
      const phoneNumberId = config.whatsapp_phone_number_id;

      if (!apiKey) return c.json({ data: { success: false, error: 'API key is required' } });

      if (provider === 'meta_cloud') {
        // Meta Cloud API — send a test template message
        const testPhone = test_recipient || phoneNumberId;
        const res = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: testPhone,
            type: 'text',
            text: { body: '✅ VaaniAI WhatsApp connection test successful!' }
          })
        });
        const data = await res.json();
        if (res.ok && data.messages) {
          return c.json({ data: { success: true, message: 'WhatsApp (Meta Cloud) connected! Test message sent.', details: data } });
        }
        return c.json({ data: { success: false, error: data.error?.message || JSON.stringify(data) } });
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
          return c.json({ data: { success: true, message: 'WhatsApp (Gupshup) connected! Test message sent.', details: data } });
        }
        return c.json({ data: { success: false, error: data.message || JSON.stringify(data) } });
      }

      if (provider === 'aisensy' || provider === 'wati' || provider === 'interakt') {
        // Generic API-key based providers
        const endpoint = config.whatsapp_api_endpoint;
        if (!endpoint) return c.json({ data: { success: false, error: 'API endpoint URL is required for this provider' } });

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
          body: new URLSearchParams({ From: from, To: to, Body: '✅ VaaniAI WhatsApp connection test successful!' })
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
            body: '✅ VaaniAI WhatsApp connection test successful!'
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
            msg: '✅ VaaniAI RCS test message',
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
            sender: config.rcs_sender_id || 'VaaniAI',
            type: 'rcs',
            body: '✅ VaaniAI RCS/SMS test message',
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
          body: new URLSearchParams({ From: config.rcs_sender_id, To: test_recipient || '', Body: '✅ VaaniAI SMS test' })
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
      const testTo = test_recipient || user.email;
      const fromAddr = config.email_from_address || 'noreply@vaaniai.io';
      const fromName = config.email_from_name || 'VaaniAI';

      if (provider === 'smtp' || provider === 'ses' || provider === 'zoho') {
        // Zoho derives its host from the region; classic SMTP needs an explicit host.
        const isZoho = provider === 'zoho';
        const host = isZoho ? `smtp.zoho.${config.zoho_region || 'in'}` : config.email_smtp_host;
        if (!host || !config.email_smtp_user || !config.email_smtp_pass) {
          return c.json({ data: { success: false, error: isZoho ? 'Zoho email and app password are required' : 'SMTP host, username, and password are required' } });
        }
        // Actually test SMTP by sending a real email via denomailer
        try {
          const { SMTPClient } = await import('npm:denomailer@1.6.0');
          const port = parseInt(config.email_smtp_port) || (isZoho ? 465 : 587);
          const smtpClient = new SMTPClient({
            connection: {
              hostname: host,
              port,
              tls: port === 465,
              auth: { username: config.email_smtp_user, password: config.email_smtp_pass }
            }
          });
          await smtpClient.send({
            from: `${fromName} <${fromAddr}>`,
            to: testTo,
            subject: '✅ VaaniAI Email Test — Connected',
            content: 'Your email integration with VaaniAI is working.',
            html: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your email integration with VaaniAI is working perfectly.</p></div>'
          });
          await smtpClient.close();
          const label = isZoho ? 'Zoho Mail' : 'SMTP';
          return c.json({ data: { success: true, message: `Email (${label}) connected! Test sent to ${testTo}` } });
        } catch (e) {
          return c.json({ data: { success: false, error: `SMTP connection failed: ${e.message}` } });
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
            subject: '✅ VaaniAI Email Test — Resend Connected',
            html: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your Resend email integration with VaaniAI is working perfectly.</p><p style="color:#666;font-size:12px;">— VaaniAI Platform</p></div>'
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
            subject: '✅ VaaniAI Email Test — SendGrid Connected',
            content: [{ type: 'text/html', value: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your SendGrid email integration with VaaniAI is working perfectly.</p></div>' }]
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
            Subject: '✅ VaaniAI Email Test — Postmark Connected',
            HtmlBody: '<div style="font-family:Arial;padding:20px;"><h2>Connection Successful!</h2><p>Your Postmark integration with VaaniAI is working.</p></div>'
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

    return c.json({ data: { error: 'Invalid channel. Use whatsapp, rcs, or email' } }, 400);

  } catch (error) {
    console.error('[testMessagingConnection] Error:', error);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};