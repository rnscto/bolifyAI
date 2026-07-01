import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Send email via Azure Communication Services REST API (Email).
// Uses HTTPS — works on serverless runtimes that block SMTP ports.
// Auth: HMAC-SHA256 signing with AZURE_COMM_KEY (access key from ACS resource).
//
// Required env:
//   AZURE_COMM_ENDPOINT  e.g. https://edvice-email-service.<region>.communication.azure.com
//   AZURE_COMM_KEY       primary access key from ACS resource → Settings → Keys
//   ACS_SMTP_FROM        verified MailFrom address e.g. support@vaaniai.io
//
// Admin-only direct invocation. Other support functions call it via base44.asServiceRole.functions.invoke.



const API_VERSION = '2023-03-31';

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function sha256B64(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64(hash);
}

async function hmacSha256B64(keyB64, text) {
  const keyBytes = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(text));
  return b64(sig);
}

async function signedFetch(method, fullUrl, bodyStr, accessKey) {
  const url = new URL(fullUrl);
  const dateStr = new Date().toUTCString();
  const contentHash = await sha256B64(bodyStr || '');
  const pathAndQuery = url.pathname + url.search;
  const stringToSign = `${method}\n${pathAndQuery}\n${dateStr};${url.host};${contentHash}`;
  const signature = await hmacSha256B64(accessKey, stringToSign);

  return fetch(fullUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-ms-date': dateStr,
      'x-ms-content-sha256': contentHash,
      'Authorization': `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`
    },
    body: bodyStr
  });
}

export default async function sendAcsSmtpEmail(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload').catch(() => null);
    if (user && user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    const { to, subject, html, text, headers = {}, from_name, attachments = [] } = await c.req.json();
    if (!to || !subject || (!html && !text)) {
      return c.json({ data: { error: 'to, subject, and html/text required' } }, 400);
    }

    const endpoint = (Deno.env.get('AZURE_COMM_ENDPOINT') || '').replace(/\/+$/, '');
    const accessKey = Deno.env.get('AZURE_COMM_KEY');
    const fromAddr = Deno.env.get('ACS_SMTP_FROM');
    if (!endpoint || !accessKey || !fromAddr) {
      return c.json({ data: { error: 'AZURE_COMM_ENDPOINT / AZURE_COMM_KEY / ACS_SMTP_FROM not set' } }, 500);
    }

    const recipients = (Array.isArray(to) ? to : [to]).map(addr => ({ address: addr }));

    const message = {
      senderAddress: fromAddr,
      content: {
        subject,
        ...(html ? { html } : {}),
        ...(text ? { plainText: text } : {})
      },
      recipients: { to: recipients },
      ...(from_name ? { replyTo: [{ address: fromAddr, displayName: from_name }] } : {})
    };

    // Custom headers (Message-ID / In-Reply-To / References) for threading
    const customHeaders = [];
    for (const [k, v] of Object.entries(headers || {})) {
      if (v) customHeaders.push({ name: k, value: String(v) });
    }
    if (customHeaders.length) message.headers = customHeaders;

    // Attachments (base64-encoded content + contentType + filename)
    if (Array.isArray(attachments) && attachments.length) {
      message.attachments = attachments
        .filter(a => a?.filename && a?.content)
        .map(a => ({
          name: a.filename,
          contentType: a.contentType || 'application/octet-stream',
          contentInBase64: a.content
        }));
    }

    const bodyStr = JSON.stringify(message);
    const url = `${endpoint}/emails:send?api-version=${API_VERSION}`;
    const res = await signedFetch('POST', url, bodyStr, accessKey);

    if (!res.ok && res.status !== 202) {
      const errText = await res.text();
      console.error('ACS REST error:', res.status, errText);
      return c.json({ data: { error: `ACS ${res.status}: ${errText.substring(0, 500)}` } }, 500);
    }

    // ACS returns 202 Accepted with operation-location header; message id is in body or header
    const opLocation = res.headers.get('operation-location') || '';
    const data = await res.json().catch(() => ({}));
    return c.json({ data: {
      success: true,
      message_id: data.id || opLocation.split('/').pop()?.split('?')[0] || '',
      status: data.status || 'queued'
    } });
  } catch (error) {
    console.error('sendAcsSmtpEmail error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};