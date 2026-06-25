import { Context } from "hono";
import { base44ORM } from "../db/orm.ts";
import { SMTPClient } from "emailjs";

// ─── Platform default: raw SMTP via PLATFORM_SMTP_* secrets (zero integration credits) ───
async function sendViaPlatformSMTP({ to, subject, html, fromName }: any) {
  const displayName = fromName || 'Bolify AI';
  const host = Deno.env.get('PLATFORM_SMTP_HOST');
  const port = parseInt(Deno.env.get('PLATFORM_SMTP_PORT') || '587');
  const user = Deno.env.get('PLATFORM_SMTP_USER');
  const pass = Deno.env.get('PLATFORM_SMTP_PASS');
  const fromAddress = Deno.env.get('PLATFORM_SMTP_FROM') || user;
  
  if (!host || !user || !pass) {
    throw new Error('Platform SMTP secrets (PLATFORM_SMTP_HOST/USER/PASS) are not configured');
  }

  const client = new SMTPClient({
    user,
    password: pass,
    host,
    port,
    ssl: port === 465,
    tls: port !== 465,
    timeout: 15000
  });

  await client.sendAsync({
    from: `${displayName} <${fromAddress}>`,
    to,
    subject,
    attachment: [{ data: html, alternative: true }]
  });

  return { provider: 'platform_smtp', status: 'sent', from: fromAddress };
}

// ─── Client provider: SMTP ───
async function sendViaSMTP({ to, subject, html, fromAddress, fromName, config }: any) {
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
  
  const message = await client.sendAsync({
    from: `${fromName} <${fromAddress}>`,
    to,
    subject,
    attachment: [{ data: html, alternative: true }]
  });
  return { provider: 'client_smtp', status: 'sent', message_id: (message?.header as any)?.['message-id'] || null };
}

// ─── Client provider: Resend ───
async function sendViaResend({ to, subject, html, fromAddress, fromName, config }: any) {
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
  if (!resp.ok) throw new Error(`Resend error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return { provider: 'client_resend', status: 'sent', id: data.id };
}

// ─── Client provider: SendGrid ───
async function sendViaSendGrid({ to, subject, html, fromAddress, fromName, config }: any) {
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
  if (!resp.ok && resp.status !== 202) throw new Error(`SendGrid error: ${resp.status} ${await resp.text()}`);
  return { provider: 'client_sendgrid', status: 'sent' };
}

// ─── Client provider: Mailgun ───
async function sendViaMailgun({ to, subject, html, fromAddress, fromName, config }: any) {
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
  
  if (!resp.ok) throw new Error(`Mailgun error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return { provider: 'client_mailgun', status: 'sent', id: data.id };
}

// ─── Client provider: Postmark ───
async function sendViaPostmark({ to, subject, html, fromAddress, fromName, config }: any) {
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
  if (!resp.ok) throw new Error(`Postmark error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return { provider: 'client_postmark', status: 'sent', message_id: data.MessageID };
}

export async function sendClientEmailLogic({ client_id, to, subject, html, from_name }: any) {
  if (!to || !subject || !html) {
    throw new Error('Missing required fields: to, subject, html');
  }

  // If no client_id, use platform default SMTP
  if (!client_id) {
    return await sendViaPlatformSMTP({ to, subject, html, fromName: from_name });
  }

  // Look up client's messaging config
  let msgConfig = null;
  try {
    const configs = await base44ORM.entities.ClientMessagingConfig.filter({ client_id });
    if (configs.length > 0) msgConfig = configs[0];
  } catch (e: any) {
    console.log(`[sendClientEmail] No messaging config for client ${client_id}: ${e.message}`);
  }

  // Look up client for company name fallback
  let client = null;
  try {
    client = await base44ORM.entities.Client.get(client_id);
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
        case 'smtp': result = await sendViaSMTP(emailParams); break;
        case 'resend': result = await sendViaResend(emailParams); break;
        case 'sendgrid': result = await sendViaSendGrid(emailParams); break;
        case 'mailgun': result = await sendViaMailgun(emailParams); break;
        case 'postmark': result = await sendViaPostmark(emailParams); break;
        default:
          console.log(`[sendClientEmail] Unknown provider ${msgConfig.email_provider}, falling back to platform SMTP`);
          result = await sendViaPlatformSMTP({ to, subject, html, fromName: displayName });
      }
      return { ...result, from_address: fromAddress };
    } catch (clientErr: any) {
      // Fall back to platform SMTP
      console.error(`[sendClientEmail] Client provider ${msgConfig.email_provider} failed: ${clientErr.message}. Falling back to platform SMTP.`);
      const fallbackResult = await sendViaPlatformSMTP({ to, subject, html, fromName: displayName });
      return { ...fallbackResult, fallback: true, original_error: clientErr.message };
    }
  }

  // No config -> Platform SMTP
  console.log(`[sendClientEmail] No client email config for ${client_id}, using platform SMTP`);
  return await sendViaPlatformSMTP({ to, subject, html, fromName: displayName });
}

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const result = await sendClientEmailLogic(payload);
    return c.json({ data: { success: true, ...result } });

  } catch (error: any) {
    console.error('[sendClientEmail] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
