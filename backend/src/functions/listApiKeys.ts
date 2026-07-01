import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// listApiKeys — list API keys (client sees own; admin sees all/pending)
// Also returns the public API base URL for the docs page.
// ═══════════════════════════════════════════════════════════════════════


export default async function listApiKeys(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json().catch(() => ({}));
    const isAdmin = user.role === 'admin';
    const svc = base44.asServiceRole;

    // Build the public functions base URL from the incoming request host.
    const host = req.headers.get('host') || '';
    const proto = (req.headers.get('x-forwarded-proto') || 'https');
    const apiBase = host ? `${proto}://${host}/functions` : '';

    let keys = [];
    if (isAdmin && body.scope === 'all') {
      keys = await svc.entities.ApiKey.list('-created_date', 200);
    } else if (isAdmin && body.scope === 'pending') {
      keys = await svc.entities.ApiKey.filter({ status: 'pending' }, '-created_date', 200);
    } else {
      // Client: only their own keys
      let clientId = null;
      const list = await base44.entities.Client.filter({ user_id: user.id });
      if (list.length) clientId = list[0].id;
      else if (user.client_id) clientId = user.client_id;
      if (!clientId) return c.json({ data: { success: true, keys: [], api_base: apiBase } });
      keys = await svc.entities.ApiKey.filter({ client_id: clientId }, '-created_date', 100);
    }

    // Never leak the hash
    const safe = keys.map(k => ({
      id: k.id,
      client_id: k.client_id,
      label: k.label,
      key_prefix: k.key_prefix,
      scopes: k.scopes || [],
      status: k.status,
      environment: k.environment,
      issued_by: k.issued_by,
      approved_by_email: k.approved_by_email || null,
      approved_at: k.approved_at || null,
      last_used_at: k.last_used_at || null,
      request_count: k.request_count || 0,
      request_ticket_id: k.request_ticket_id || null,
      // True when a one-time raw-key reveal is still available to the client.
      // The secret itself is NEVER sent here — only the boolean.
      has_reveal: !!(k.reveal_secret && k.reveal_until && new Date(k.reveal_until).getTime() > Date.now()),
      created_date: k.created_date
    }));

    return c.json({ data: { success: true, keys: safe, api_base: apiBase } });
  } catch (error) {
    console.error('listApiKeys error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};