import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// manageWebhook — register / rotate / pause / delete a client's outbound webhook
// ═══════════════════════════════════════════════════════════════════════
// Authenticated (logged-in client or admin). Lets a client register the URL
// their CRM should receive signed status_complete events at, and rotate the
// HMAC signing secret. The signing_secret is returned ONLY at create/rotate.
//
// Actions (POST body { action }):
//   • register — create/replace the client's webhook (returns signing_secret once)
//   • rotate   — generate a new signing_secret (returns it once)
//   • get      — return the endpoint metadata (NO secret)
//   • pause / resume / delete
// ═══════════════════════════════════════════════════════════════════════


function genSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'whsec_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type'
};

export default async function manageWebhook(c: any) {
  const req = c.req.raw || c.req;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));
    const action = body.action;

    // ── Auth: accept EITHER a logged-in user/admin OR a CRM API key ──
    // CRMs (Postman, Salesforce, etc.) call this with Authorization: Bearer vaani_live_xxx.
    let clientId = null;
    let isAdmin = false;

    const user = c.get('jwtPayload').catch(() => null);
    if (user) {
      isAdmin = user.role === 'admin';
      if (isAdmin && body.client_id) {
        clientId = body.client_id;
      } else {
        const list = await base44.entities.Client.filter({ user_id: user.id });
        clientId = list[0]?.id || user.client_id || null;
      }
    } else {
      // API-key path — validate bearer token against ApiKey entity (same as public CRM endpoints)
      const auth = req.headers.get('authorization') || '';
      const rawKey = auth.replace(/^Bearer\s+/i, '').trim();
      if (!rawKey) return c.json({ data: { error: 'Unauthorized — provide a logged-in session or API key' } }, 401);
      const hash = await sha256Hex(rawKey);
      const keys = await svc.entities.ApiKey.filter({ key_hash: hash });
      const key = keys[0];
      if (!key) return c.json({ data: { error: 'Invalid API key' } }, 401);
      if (key.status !== 'active') return c.json({ data: { error: `API key is ${key.status}` } }, 403);
      clientId = key.client_id;
      svc.entities.ApiKey.update(key.id, {
        last_used_at: new Date().toISOString(),
        request_count: (key.request_count || 0) + 1
      }).catch(() => {});
    }

    if (!clientId) return c.json({ data: { error: 'No client account found' } }, 400);

    const existing = (await svc.entities.WebhookEndpoint.filter({ client_id: clientId }))[0] || null;

    if (action === 'register') {
      const url = (body.target_url || '').toString().trim();
      if (!/^https:\/\//i.test(url)) return c.json({ data: { error: 'target_url must be an https:// URL' } }, 400);
      const secret = genSecret();
      let ep;
      if (existing) {
        ep = await svc.entities.WebhookEndpoint.update(existing.id, {
          target_url: url, signing_secret: secret, status: 'active', consecutive_failures: 0
        });
      } else {
        ep = await svc.entities.WebhookEndpoint.create({
          client_id: clientId, target_url: url, signing_secret: secret,
          events: ['status_complete'], status: 'active'
        });
      }
      return c.json({ data: {
        success: true, id: ep.id, target_url: url,
        signing_secret: secret,
        note: 'Store this signing_secret securely — it is shown only once. Verify X-Vaani-Signature (sha256=HMAC-SHA256(secret, rawBody)).'
      } });
    }

    if (!existing) return c.json({ data: { error: 'No webhook registered for this client' } }, 404);

    if (action === 'rotate') {
      const secret = genSecret();
      await svc.entities.WebhookEndpoint.update(existing.id, { signing_secret: secret });
      return c.json({ data: { success: true, signing_secret: secret, note: 'Shown only once. Update your verifier.' } });
    }
    if (action === 'get') {
      return c.json({ data: {
        success: true,
        id: existing.id,
        target_url: existing.target_url,
        status: existing.status,
        events: existing.events || ['status_complete'],
        last_delivery_at: existing.last_delivery_at || null,
        last_delivery_status: existing.last_delivery_status || null,
        delivery_count: existing.delivery_count || 0,
        consecutive_failures: existing.consecutive_failures || 0
      } });
    }
    if (action === 'pause') { await svc.entities.WebhookEndpoint.update(existing.id, { status: 'paused' }); return c.json({ data: { success: true, status: 'paused' } }); }
    if (action === 'resume') { await svc.entities.WebhookEndpoint.update(existing.id, { status: 'active', consecutive_failures: 0 }); return c.json({ data: { success: true, status: 'active' } }); }
    if (action === 'delete') { await svc.entities.WebhookEndpoint.delete(existing.id); return c.json({ data: { success: true, deleted: true } }); }

    return c.json({ data: { error: 'Unknown action' } }, 400);
  } catch (error) {
    console.error('manageWebhook error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};