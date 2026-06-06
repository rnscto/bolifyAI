import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Centralized email sender that uses the CLIENT'S configured email provider
 * from ClientMessagingConfig when available, falling back to the platform
 * default SMTP (configured via PLATFORM_SMTP_* secrets with custom domain).
 *
 * POST /functions/sendClientEmail
 * Body: {
 *   client_id: string (required - to look up their email config)
 *   to: string (recipient email)
 *   subject: string
 *   html: string (email body HTML)
 *   from_name: string (display name, defaults to client company name)
 * }
 */

// ─── Platform default: native email integration (noreply@bolifyai.com) ───
async function sendViaPlatformSMTP({ to, subject, html, fromName }) {
  const displayName = fromName || 'Bolify AI';
  const appId = Deno.env.get('BASE44_APP_ID');
  const svc = createClient({ appId, asServiceRole: true });
  await svc.integrations.Core.SendEmail({
    from_name: displayName,
    to, subject, body: html
  });
  return { provider: 'platform_integration', status: 'sent', from: 'noreply@bolifyai.com' };
}

// ─── Client provider: SMTP ───
async function sendViaSMTP({ to, subject, html, fromAddress, fromName, config }) {
  // Use Deno-compatible SMTP via raw SMTP socket or a lightweight library
  // For now, we use the smtp npm package
  const { SMTPClient } = await import('npm:emailjs@4.0.3');
  const port = parseInt(config.email_smtp_port) || 587;
  const useSSL = port === 465; // 465 = implicit SSL; 587/25 = STARTTLS
  const client = new SMTPClient({
    user: config.email_smtp_user,
    password: config.email_smtp_pass,
    host: config.email_smtp_host,
    port,
    ssl: useSSL,
    tls: !useSSL,
    timeout: 15000
  });
  const message = await client.sendAsync({
    from: `${fromName} <${fromAddress}>`,
    to,
    subject,
    attachment: [{ data: html, alternative: true }]
  });
  return { provider: 'client_smtp', status: 'sent', message_id: message?.header?.['message-id'] || null };
}

// ─── Client provider: Resend ───
async function sendViaResend({ to, subject, html, fromAddress, fromName, config }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.email_api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `${fromName} <${fromAddress}>`,
      to: [to],
      subject,
      html
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend error: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return { provider: 'client_resend', status: 'sent', id: data.id };
}

// ─── Client provider: SendGrid ───
async function sendViaSendGrid({ to, subject, html, fromAddress, fromName, config }) {
  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.email_api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromAddress, name: fromName },
      subject,
      content: [{ type: 'text/html', value: html }]
    })
  });
  if (!resp.ok && resp.status !== 202) {
    const err = await resp.text();
    throw new Error(`SendGrid error: ${resp.status} ${err}`);
  }
  return { provider: 'client_sendgrid', status: 'sent' };
}

// ─── Client provider: Mailgun ───
async function sendViaMailgun({ to, subject, html, fromAddress, fromName, config }) {
  const domain = config.email_domain;
  if (!domain) throw new Error('Mailgun requires email_domain in config');
  const formData = new FormData();
  formData.append('from', `${fromName} <${fromAddress}>`);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);
  const resp = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`api:${config.email_api_key}`)
    },
    body: formData
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Mailgun error: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return { provider: 'client_mailgun', status: 'sent', id: data.id };
}

// ─── Client provider: Postmark ───
async function sendViaPostmark({ to, subject, html, fromAddress, fromName, config }) {
  const resp = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': config.email_api_key
    },
    body: JSON.stringify({
      From: `${fromName} <${fromAddress}>`,
      To: to,
      Subject: subject,
      HtmlBody: html
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Postmark error: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return { provider: 'client_postmark', status: 'sent', message_id: data.MessageID };
}

Deno.serve(async (req) => {
  try {
    let base44;
    try {
      const reqClient = createClientFromRequest(req);
      base44 = reqClient.asServiceRole;
    } catch (_) {
      const appId = Deno.env.get('BASE44_APP_ID');
      base44 = createClient({ appId, asServiceRole: true });
    }

    const { client_id, to, subject, html, from_name } = await req.json();

    if (!to || !subject || !html) {
      return Response.json({ error: 'Missing required fields: to, subject, html' }, { status: 400 });
    }

    // If no client_id, use platform default SMTP
    if (!client_id) {
      const result = await sendViaPlatformSMTP({ to, subject, html, fromName: from_name });
      return Response.json({ success: true, ...result });
    }

    // Look up client's messaging config
    let msgConfig = null;
    try {
      const configs = await base44.entities.ClientMessagingConfig.filter({ client_id });
      if (configs.length > 0) msgConfig = configs[0];
    } catch (e) {
      console.log(`[sendClientEmail] No messaging config for client ${client_id}: ${e.message}`);
    }

    // Look up client for company name fallback
    let client = null;
    try {
      client = await base44.entities.Client.get(client_id);
    } catch (_) {}

    const displayName = from_name || msgConfig?.email_from_name || client?.company_name || 'Bolify AI';

    // Check if client has a connected email provider
    if (msgConfig && msgConfig.email_provider && msgConfig.email_provider !== 'none' && msgConfig.email_status === 'connected') {
      const fromAddress = msgConfig.email_from_address || `noreply@${msgConfig.email_domain || 'getway.ai'}`;
      const emailParams = { to, subject, html, fromAddress, fromName: displayName, config: msgConfig };
      
      console.log(`[sendClientEmail] Using client email provider: ${msgConfig.email_provider} (${fromAddress}) for client ${client_id}`);

      try {
        let result;
        switch (msgConfig.email_provider) {
          case 'smtp':
            result = await sendViaSMTP(emailParams);
            break;
          case 'resend':
            result = await sendViaResend(emailParams);
            break;
          case 'sendgrid':
            result = await sendViaSendGrid(emailParams);
            break;
          case 'mailgun':
            result = await sendViaMailgun(emailParams);
            break;
          case 'postmark':
            result = await sendViaPostmark(emailParams);
            break;
          default:
            console.log(`[sendClientEmail] Unknown provider ${msgConfig.email_provider}, falling back to platform SMTP`);
            result = await sendViaPlatformSMTP({ to, subject, html, fromName: displayName });
        }
        return Response.json({ success: true, ...result, from_address: fromAddress });
      } catch (clientErr) {
        // If client provider fails, fall back to platform SMTP
        console.error(`[sendClientEmail] Client provider ${msgConfig.email_provider} failed: ${clientErr.message}. Falling back to platform SMTP.`);
        const fallbackResult = await sendViaPlatformSMTP({ to, subject, html, fromName: displayName });
        return Response.json({ success: true, ...fallbackResult, fallback: true, original_error: clientErr.message });
      }
    }

    // No client email config or not connected — use platform SMTP
    console.log(`[sendClientEmail] No client email config for ${client_id}, using platform SMTP`);
    const result = await sendViaPlatformSMTP({ to, subject, html, fromName: displayName });
    return Response.json({ success: true, ...result });

  } catch (error) {
    console.error('[sendClientEmail] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});