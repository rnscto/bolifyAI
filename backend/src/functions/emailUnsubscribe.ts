import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// emailUnsubscribe — Public endpoint. Handles unsubscribe link clicks
// (GET with ?token=...) and one-click List-Unsubscribe-Post (POST).
//
// Token format (URL-safe base64): client_id:email:campaign_id  (campaign_id optional)
//
// Adds EmailUnsubscribe row if not already present and returns a simple
// confirmation HTML page.
// ═══════════════════════════════════════════════════════════════════



function decodeToken(token) {
  try {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(padded + '=='.substring(0, (4 - (padded.length % 4)) % 4));
    const [client_id, email, campaign_id] = decoded.split(':');
    if (!client_id || !email) return null;
    return { client_id, email: email.toLowerCase(), campaign_id: campaign_id || null };
  } catch (_) {
    return null;
  }
}

function htmlPage(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f3f4f6;margin:0;padding:40px 20px;color:#1f2937}
  .card{max-width:480px;margin:60px auto;background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 12px rgba(0,0,0,.06);text-align:center}
  h1{margin:0 0 12px;font-size:22px;color:#059669}p{margin:0;color:#4b5563;line-height:1.6;font-size:15px}
  .err h1{color:#dc2626}</style></head>
  <body><div class="card ${title.toLowerCase().includes('error')?'err':''}"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

async function processUnsubscribe(svc, decoded) {
  const existing = await svc.entities.EmailUnsubscribe.filter({
    client_id: decoded.client_id,
    recipient_email: decoded.email
  }).catch(() => []);

  if (existing.length === 0) {
    await svc.entities.EmailUnsubscribe.create({
      client_id: decoded.client_id,
      recipient_email: decoded.email,
      reason: 'user_unsubscribe',
      source_campaign_id: decoded.campaign_id || null,
      unsubscribe_token: 'consumed'
    });
  }

  // Cancel any pending campaign sends for this address
  const queued = await svc.entities.EmailCampaignRecipient.filter({
    client_id: decoded.client_id,
    recipient_email: decoded.email,
    status: 'queued'
  }).catch(() => []);
  await Promise.all(queued.map(r =>
    svc.entities.EmailCampaignRecipient.update(r.id, {
      status: 'skipped_unsubscribed',
      error_message: 'Unsubscribed after enrollment'
    }).catch(() => {})
  ));
}

export default async function emailUnsubscribe(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const svc = client.asServiceRole;
    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return new Response(htmlPage('Invalid Link', 'No unsubscribe token was provided.'), {
        status: 400, headers: { 'Content-Type': 'text/html' }
      });
    }

    const decoded = decodeToken(token);
    if (!decoded) {
      return new Response(htmlPage('Invalid Link', 'This unsubscribe link is malformed or expired.'), {
        status: 400, headers: { 'Content-Type': 'text/html' }
      });
    }

    await processUnsubscribe(svc, decoded);

    // For POST (List-Unsubscribe-Post one-click), return 200 plain
    if (req.method === 'POST') {
      return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    return new Response(
      htmlPage('Unsubscribed', `You've been removed from this mailing list (${decoded.email}). You will no longer receive marketing emails from this sender.`),
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error) {
    console.error('[emailUnsubscribe] Fatal:', error);
    return new Response(htmlPage('Error', error.message), {
      status: 500, headers: { 'Content-Type': 'text/html' }
    });
  }

};