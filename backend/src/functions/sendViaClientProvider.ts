import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// sendViaClientProvider — Internal email dispatcher that routes through
// the CLIENT's configured email provider (SMTP / Resend / SendGrid /
// Mailgun / Postmark / SES-SMTP). Falls back to Azure ACS only when the
// client has no provider configured.
//
// Invoked by sendEmailFromTemplate (and any future client-branded sender).
//
// Payload: {
//   client_id,                        // required - for picking client provider
//   to,                               // string or [string]
//   subject,
//   html,
//   from_address?, from_name?,        // optional override
//   cc?: [], bcc?: [],
//   attachments?: [{ name, contentType, contentInBase64 }]
// }
// Returns: { success, provider_used, message_id?, error? }
// ═══════════════════════════════════════════════════════════════════


import { EmailClient } from 'npm:@azure/communication-email@1.0.0';

const acsConnStr = `endpoint=${Deno.env.get('AZURE_COMM_ENDPOINT')};accesskey=${Deno.env.get('AZURE_COMM_KEY')}`;

function toArr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

async function sendViaACS({ to, cc, bcc, subject, html, fromAddr, fromName, attachments }) {
  const emailClient = new EmailClient(acsConnStr);
  const message = {
    senderAddress: fromAddr || 'DoNotReply@vaaniai.io',
    displayName: fromName || 'VaaniAI',
    content: { subject, html },
    recipients: {
      to: toArr(to).map(a => ({ address: a })),
      cc: toArr(cc).map(a => ({ address: a })),
      bcc: toArr(bcc).map(a => ({ address: a }))
    },
    ...(attachments?.length ? { attachments } : {})
  };
  const poller = await emailClient.beginSend(message);
  const result = await poller.pollUntilDone();
  if (result.status !== 'Succeeded') throw new Error(`ACS error: ${result.error?.message || result.status}`);
  return { provider_used: 'azure_acs', message_id: result.id || null };
}

async function sendViaResend({ to, cc, bcc, subject, html, fromAddr, fromName, attachments, apiKey, headers }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${fromName || 'VaaniAI'} <${fromAddr}>`,
      to: toArr(to), cc: toArr(cc), bcc: toArr(bcc),
      subject, html,
      ...(headers ? { headers } : {}),
      ...(attachments?.length ? {
        attachments: attachments.map(a => ({ filename: a.name, content: a.contentInBase64 }))
      } : {})
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend error: ${data.message || res.status}`);
  return { provider_used: 'resend', message_id: data.id || null };
}

async function sendViaSendGrid({ to, cc, bcc, subject, html, fromAddr, fromName, attachments, apiKey }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{
        to: toArr(to).map(a => ({ email: a })),
        ...(cc?.length ? { cc: toArr(cc).map(a => ({ email: a })) } : {}),
        ...(bcc?.length ? { bcc: toArr(bcc).map(a => ({ email: a })) } : {})
      }],
      from: { email: fromAddr, name: fromName || 'VaaniAI' },
      subject,
      content: [{ type: 'text/html', value: html }],
      ...(attachments?.length ? {
        attachments: attachments.map(a => ({
          filename: a.name, type: a.contentType, content: a.contentInBase64, disposition: 'attachment'
        }))
      } : {})
    })
  });
  if (res.status === 202 || res.ok) return { provider_used: 'sendgrid', message_id: res.headers.get('x-message-id') };
  const errText = await res.text();
  throw new Error(`SendGrid error: ${errText}`);
}

async function sendViaMailgun({ to, cc, bcc, subject, html, fromAddr, fromName, apiKey, domain }) {
  const form = new FormData();
  form.append('from', `${fromName || 'VaaniAI'} <${fromAddr}>`);
  toArr(to).forEach(a => form.append('to', a));
  toArr(cc).forEach(a => form.append('cc', a));
  toArr(bcc).forEach(a => form.append('bcc', a));
  form.append('subject', subject);
  form.append('html', html);
  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + btoa(`api:${apiKey}`) },
    body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mailgun error: ${data.message || res.status}`);
  return { provider_used: 'mailgun', message_id: data.id || null };
}

async function sendViaPostmark({ to, cc, bcc, subject, html, fromAddr, fromName, apiKey }) {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { 'X-Postmark-Server-Token': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      From: `${fromName || 'VaaniAI'} <${fromAddr}>`,
      To: toArr(to).join(','),
      Cc: toArr(cc).join(',') || undefined,
      Bcc: toArr(bcc).join(',') || undefined,
      Subject: subject,
      HtmlBody: html
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.MessageID) throw new Error(`Postmark error: ${data.Message || res.status}`);
  return { provider_used: 'postmark', message_id: data.MessageID };
}

async function sendViaSMTP({ to, cc, bcc, subject, html, fromAddr, fromName, attachments, smtpHost, smtpPort, smtpUser, smtpPass }) {
  const { SMTPClient } = await import('npm:denomailer@1.6.0');
  const port = parseInt(smtpPort) || 587;
  const smtpClient = new SMTPClient({
    connection: {
      hostname: smtpHost,
      port,
      tls: port === 465,
      auth: { username: smtpUser, password: smtpPass }
    }
  });
  try {
    await smtpClient.send({
      from: `${fromName || 'VaaniAI'} <${fromAddr}>`,
      to: toArr(to),
      cc: toArr(cc),
      bcc: toArr(bcc),
      subject,
      content: 'This email requires an HTML-capable client.',
      html,
      ...(attachments?.length ? {
        attachments: attachments.map(a => ({
          filename: a.name,
          content: a.contentInBase64,
          encoding: 'base64',
          contentType: a.contentType
        }))
      } : {})
    });
    return { provider_used: 'smtp', message_id: null };
  } finally {
    await smtpClient.close().catch(() => {});
  }
}

export default async function sendViaClientProvider(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const base44 = client.asServiceRole;
    const payload = await c.req.json();
    const { client_id, to, subject, html, from_address, from_name, cc = [], bcc = [], attachments = [], headers = null, require_client_provider = false } = payload;

    if (!to || !subject || !html) {
      return c.json({ data: { success: false, error: 'to, subject, html required' } }, 400);
    }

    // Load client's messaging config
    const cfgList = client_id ? await base44.entities.ClientMessagingConfig.filter({ client_id }).catch(() => []) : [];
    const cfg = cfgList[0] || null;
    const provider = cfg?.email_provider || 'none';

    const fromAddr = from_address || cfg?.email_from_address || 'DoNotReply@vaaniai.io';
    const fromName = from_name || cfg?.email_from_name || 'VaaniAI';
    const base = { to, cc, bcc, subject, html, fromAddr, fromName, attachments };

    try {
      let result;
      if (provider === 'resend' && cfg?.email_api_key) {
        result = await sendViaResend({ ...base, apiKey: cfg.email_api_key, headers });
      } else if (provider === 'sendgrid' && cfg?.email_api_key) {
        result = await sendViaSendGrid({ ...base, apiKey: cfg.email_api_key });
      } else if (provider === 'mailgun' && cfg?.email_api_key && cfg?.email_domain) {
        result = await sendViaMailgun({ ...base, apiKey: cfg.email_api_key, domain: cfg.email_domain });
      } else if (provider === 'postmark' && cfg?.email_api_key) {
        result = await sendViaPostmark({ ...base, apiKey: cfg.email_api_key });
      } else if ((provider === 'smtp' || provider === 'ses') && cfg?.email_smtp_host && cfg?.email_smtp_user && cfg?.email_smtp_pass) {
        result = await sendViaSMTP({
          ...base,
          smtpHost: cfg.email_smtp_host, smtpPort: cfg.email_smtp_port,
          smtpUser: cfg.email_smtp_user, smtpPass: cfg.email_smtp_pass
        });
      } else if (provider === 'zoho' && cfg?.email_smtp_user && cfg?.email_smtp_pass) {
        // Zoho Mail = SMTP with a preset host derived from the chosen region.
        const region = cfg.zoho_region || 'in';
        result = await sendViaSMTP({
          ...base,
          smtpHost: `smtp.zoho.${region}`, smtpPort: cfg.email_smtp_port || 465,
          smtpUser: cfg.email_smtp_user, smtpPass: cfg.email_smtp_pass
        });
        result.provider_used = 'zoho';
      } else {
        // Strict mode: bulk Email Campaigns must use the client's own provider — no platform fallback
        if (require_client_provider) {
          return c.json({ data: {
            success: false,
            provider_attempted: provider,
            error: `Client email provider not configured (provider=${provider}). Configure your email provider under Integrations to send campaigns.`
          } }, 400);
        }
        // Fallback to Vaani's ACS (platform-branded) for transactional sends only
        result = await sendViaACS(base);
      }

      // Mark client config as connected on first successful send
      if (cfg && cfg.email_status !== 'connected' && result.provider_used !== 'azure_acs') {
        await base44.entities.ClientMessagingConfig.update(cfg.id, {
          email_status: 'connected', email_last_tested: new Date().toISOString()
        }).catch(() => {});
      }

      return c.json({ data: { success: true, ...result } });
    } catch (sendErr) {
      // Mark client config as error if it was the chosen provider that failed
      if (cfg && provider !== 'none') {
        await base44.entities.ClientMessagingConfig.update(cfg.id, { email_status: 'error' }).catch(() => {});
      }
      return c.json({ data: { success: false, provider_attempted: provider, error: sendErr.message } }, 500);
    }
  } catch (e) {
    console.error('[sendViaClientProvider] fatal:', e);
    return c.json({ data: { success: false, error: e.message } }, 500);
  }

};