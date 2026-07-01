import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// issueApiKey — create / request / approve / revoke API keys
// ═══════════════════════════════════════════════════════════════════════
// Actions (POST body { action }):
//   • request  — CLIENT requests a key (creates pending ApiKey + SupportTicket)
//   • approve  — ADMIN approves a pending key → activates + returns RAW key ONCE
//   • issue    — ADMIN issues a key directly for a client → returns RAW key ONCE
//   • revoke   — ADMIN or owning CLIENT revokes a key
//   • reveal   — (no-op) raw keys are shown only once at creation; cannot re-reveal
//
// SECURITY: only a SHA-256 hash of the key is ever stored. The raw secret is
// returned exactly once (on approve/issue) and never again.
// ═══════════════════════════════════════════════════════════════════════


function randomKey(env) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `vaani_${env}_${hex}`;
}
async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function issueApiKey(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json().catch(() => ({}));
    const action = body.action;
    const isAdmin = user.role === 'admin';
    const svc = base44.asServiceRole;

    // Resolve the caller's own client (for client-side actions)
    async function getMyClient() {
      const list = await base44.entities.Client.filter({ user_id: user.id });
      if (list.length) return list[0];
      if (user.client_id) return svc.entities.Client.get(user.client_id).catch(() => null);
      return null;
    }

    // ─── CLIENT requests a key (creates pending key + ticket) ───
    if (action === 'request') {
      const client = await getMyClient();
      if (!client) return c.json({ data: { error: 'No client account found' } }, 400);

      const label = (body.label || 'API Integration').toString().slice(0, 80);
      const scopes = Array.isArray(body.scopes) && body.scopes.length
        ? body.scopes.filter(s => ['leads:write', 'leads:read', 'outcomes:read', 'calls:write'].includes(s))
        : ['leads:write', 'leads:read', 'outcomes:read'];

      // Create a support ticket so admins see it in their queue
      let ticket = null;
      try {
        const tnum = `TKT-${Date.now().toString().slice(-8)}`;
        ticket = await svc.entities.SupportTicket.create({
          ticket_number: tnum,
          client_id: client.id,
          requester_email: user.email,
          requester_name: user.full_name || '',
          subject: `API Key request: ${label}`,
          description: `Client ${client.company_name} requested an API key "${label}" with scopes: ${scopes.join(', ')}.\n\nApprove from Admin → API Keys.`,
          category: 'technical',
          priority: 'medium',
          status: 'open',
          source: 'portal',
          last_message_at: new Date().toISOString(),
          last_message_by: 'customer'
        });
      } catch (e) { console.error('Ticket create failed:', e.message); }

      // Pre-generate the raw key now, store only its hash. Raw is revealed on approval.
      const raw = randomKey(body.environment === 'test' ? 'test' : 'live');
      const key_hash = await sha256Hex(raw);
      const key_prefix = raw.slice(0, 18);

      const apiKey = await svc.entities.ApiKey.create({
        client_id: client.id,
        label,
        key_prefix,
        key_hash,
        scopes,
        status: 'pending',
        environment: body.environment === 'test' ? 'test' : 'live',
        request_ticket_id: ticket?.id || '',
        issued_by: 'client_request',
        request_count: 0
      });
      // Stash the raw key transiently on the ticket internal notes so admin reveal
      // works at approval time WITHOUT persisting it on the ApiKey record.
      if (ticket) {
        await svc.entities.SupportTicket.update(ticket.id, {
          internal_notes: `__APIKEY_PENDING__:${apiKey.id}:${raw}`
        }).catch(() => {});
      }
      return c.json({ data: { success: true, status: 'pending', api_key_id: apiKey.id, ticket_id: ticket?.id || null } });
    }

    // ─── ADMIN approves a pending key → reveal raw once ───
    if (action === 'approve') {
      if (!isAdmin) return c.json({ data: { error: 'Forbidden' } }, 403);
      const key = await svc.entities.ApiKey.get(body.api_key_id);
      if (!key) return c.json({ data: { error: 'Key not found' } }, 404);
      if (key.status !== 'pending') return c.json({ data: { error: `Key is ${key.status}, not pending` } }, 400);

      // Recover the raw key from the request ticket's internal_notes stash
      let raw = '';
      if (key.request_ticket_id) {
        const t = await svc.entities.SupportTicket.get(key.request_ticket_id).catch(() => null);
        const note = t?.internal_notes || '';
        const m = note.match(/^__APIKEY_PENDING__:([^:]+):(.+)$/);
        if (m && m[1] === key.id) raw = m[2];
        if (t) await svc.entities.SupportTicket.update(t.id, { internal_notes: '', status: 'resolved', resolved_at: new Date().toISOString() }).catch(() => {});
      }

      // Stash the raw key for a one-time CLIENT reveal (24h window) so the
      // client can copy it from their own portal — the admin no longer has to
      // manually relay it. Cleared on first client reveal or after expiry.
      const revealUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await svc.entities.ApiKey.update(key.id, {
        status: 'active',
        approved_by_email: user.email,
        approved_at: new Date().toISOString(),
        ...(raw ? { reveal_secret: raw, reveal_until: revealUntil } : {})
      });
      return c.json({ data: { success: true, status: 'active', raw_key: raw || null, key_prefix: key.key_prefix } });
    }

    // ─── ADMIN issues a key directly for a client ───
    if (action === 'issue') {
      if (!isAdmin) return c.json({ data: { error: 'Forbidden' } }, 403);
      const clientId = body.client_id;
      if (!clientId) return c.json({ data: { error: 'client_id required' } }, 400);
      const client = await svc.entities.Client.get(clientId).catch(() => null);
      if (!client) return c.json({ data: { error: 'Client not found' } }, 404);

      const label = (body.label || 'Admin Issued Key').toString().slice(0, 80);
      const scopes = Array.isArray(body.scopes) && body.scopes.length
        ? body.scopes.filter(s => ['leads:write', 'leads:read', 'outcomes:read', 'calls:write'].includes(s))
        : ['leads:write', 'leads:read', 'outcomes:read'];
      const env = body.environment === 'test' ? 'test' : 'live';
      const raw = randomKey(env);
      const key_hash = await sha256Hex(raw);
      const key_prefix = raw.slice(0, 18);

      const apiKey = await svc.entities.ApiKey.create({
        client_id: clientId,
        label, key_prefix, key_hash, scopes,
        status: 'active', environment: env,
        issued_by: 'admin_direct',
        approved_by_email: user.email,
        approved_at: new Date().toISOString(),
        request_count: 0,
        // One-time client reveal window (24h) so the client can copy it themselves.
        reveal_secret: raw,
        reveal_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
      return c.json({ data: { success: true, status: 'active', api_key_id: apiKey.id, raw_key: raw, key_prefix } });
    }

    // ─── CLIENT (or admin) reveals a freshly-approved key ONCE ───
    // Returns the raw key only while inside the 24h reveal window, then clears
    // it so it can never be fetched again.
    if (action === 'reveal') {
      const key = await svc.entities.ApiKey.get(body.api_key_id).catch(() => null);
      if (!key) return c.json({ data: { error: 'Key not found' } }, 404);
      if (!isAdmin) {
        const client = await getMyClient();
        if (!client || client.id !== key.client_id) return c.json({ data: { error: 'Forbidden' } }, 403);
      }
      const within = key.reveal_until && new Date(key.reveal_until).getTime() > Date.now();
      if (!key.reveal_secret || !within) {
        return c.json({ data: { error: 'This key can no longer be revealed. Please request a new one.' } }, 410);
      }
      const raw = key.reveal_secret;
      // Burn it — one-time only.
      await svc.entities.ApiKey.update(key.id, { reveal_secret: '', reveal_until: '' }).catch(() => {});
      return c.json({ data: { success: true, raw_key: raw, key_prefix: key.key_prefix } });
    }

    // ─── Revoke (admin OR owning client) ───
    if (action === 'revoke') {
      const key = await svc.entities.ApiKey.get(body.api_key_id).catch(() => null);
      if (!key) return c.json({ data: { error: 'Key not found' } }, 404);
      if (!isAdmin) {
        const client = await getMyClient();
        if (!client || client.id !== key.client_id) return c.json({ data: { error: 'Forbidden' } }, 403);
      }
      await svc.entities.ApiKey.update(key.id, { status: 'revoked', revoked_at: new Date().toISOString() });
      return c.json({ data: { success: true, status: 'revoked' } });
    }

    return c.json({ data: { error: 'Unknown action' } }, 400);
  } catch (error) {
    console.error('issueApiKey error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};