import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// publicLeadsIngest — PUBLIC inbound endpoint for third-party CRMs
// ═══════════════════════════════════════════════════════════════════════
// Auth: Authorization: Bearer vaani_live_xxx  (scope: leads:write)
// Pushes lead(s) into our CRM. Supports lead group assignment by NAME
// (auto-created if missing) and arbitrary custom_fields.
//
// Body (single or batch):
//   {
//     "leads": [
//       {
//         "name": "...", "phone": "+9199...", "email": "...",
//         "company": "...", "source": "Salesforce", "status": "new",
//         "notes": "...", "tags": ["vip"], "crm_id": "EXT-123",
//         "group": "Webinar Jan 2026",          // by name (auto-created)
//         "custom_fields": { "deal_size": "50k" }
//       }
//     ]
//   }
// Idempotency: if crm_id is provided and a lead with that crm_id already
// exists for the client, it is UPDATED instead of duplicated.
// ═══════════════════════════════════════════════════════════════════════


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

export default async function publicLeadsIngest(c: any) {
  const req = c.req.raw || c.req;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return c.json({ data: { error: 'Method not allowed' } }, 405);

  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // ─── API-key auth ───
    const auth = req.headers.get('authorization') || '';
    const raw = auth.replace(/^Bearer\s+/i, '').trim();
    if (!raw) return c.json({ data: { error: 'Missing API key' } }, 401);
    const hash = await sha256Hex(raw);
    const keys = await svc.entities.ApiKey.filter({ key_hash: hash });
    const key = keys[0];
    if (!key) return c.json({ data: { error: 'Invalid API key' } }, 401);
    if (key.status !== 'active') return c.json({ data: { error: `API key is ${key.status}` } }, 403);
    if (!(key.scopes || []).includes('leads:write')) return c.json({ data: { error: 'Key lacks leads:write scope' } }, 403);

    // ── RATE LIMIT (fixed 1-minute window, per API key) ──
    // Prevents a leaked key from hammering the ingest endpoint. 60 req/min/key.
    const RATE_LIMIT_PER_MIN = 60;
    try {
      const windowStart = new Date();
      windowStart.setSeconds(0, 0);
      const bucketKey = `apikey:${key.id}:ingest:${windowStart.toISOString()}`;
      const existing = await svc.entities.RateBucket.filter({ bucket_key: bucketKey });
      const bucket = existing[0];
      if (bucket) {
        if ((bucket.count || 0) >= RATE_LIMIT_PER_MIN) {
          return c.json({ data: { error: 'Rate limit exceeded (60 requests/min). Slow down.' } }, 429);
        }
        await svc.entities.RateBucket.update(bucket.id, { count: (bucket.count || 0) + 1 });
      } else {
        await svc.entities.RateBucket.create({
          bucket_key: bucketKey, identity: key.id, endpoint: 'leads_ingest',
          window_start: windowStart.toISOString(), count: 1
        });
      }
    } catch (rlErr) {
      // Fail-open on limiter errors — never block legitimate ingest on a counter glitch.
      console.error('publicLeadsIngest rate-limit check failed (allowing):', rlErr.message);
    }

    const clientId = key.client_id;

    // ── Resolve the client's industry blueprint (for custom_fields coercion) ──
    // Best-effort: if none found, custom_fields pass through as-is.
    let blueprintFields = null;
    try {
      const client = await svc.entities.Client.get(clientId).catch(() => null);
      const bpKey = client?.blueprint_key || client?.industry;
      if (bpKey) {
        const norm = String(bpKey).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        let bps = await svc.entities.IndustryBlueprint.filter({ industry_key: norm, status: 'active' });
        if (!bps[0]) {
          const all = await svc.entities.IndustryBlueprint.filter({ status: 'active' });
          const label = String(bpKey).trim().toLowerCase();
          bps = [all.find(bp => (bp.aliases || []).some(a => String(a).trim().toLowerCase() === label))].filter(Boolean);
        }
        if (bps[0]?.custom_fields?.length) blueprintFields = bps[0].custom_fields;
      }
    } catch (_) { /* ignore — passthrough */ }

    // Coerce incoming custom_fields values to the blueprint field types.
    const coerceCustomFields = (cf) => {
      if (!blueprintFields) return cf;
      const out = { ...cf };
      for (const f of blueprintFields) {
        if (out[f.key] === undefined || out[f.key] === null || out[f.key] === '') continue;
        const raw = String(out[f.key]).trim();
        if (f.type === 'number') {
          const n = Number(raw);
          if (!Number.isNaN(n)) out[f.key] = n;
        } else if (f.type === 'boolean') {
          out[f.key] = /^(true|yes|1|y)$/i.test(raw);
        } else if (f.type === 'select' && Array.isArray(f.options) && f.options.length) {
          // Snap to the matching option (case-insensitive); leave as-is if no match.
          const match = f.options.find(o => String(o).toLowerCase() === raw.toLowerCase());
          if (match) out[f.key] = match;
        }
      }
      return out;
    };

    const body = await c.req.json().catch(() => ({}));
    const incoming = Array.isArray(body.leads) ? body.leads : (body.phone ? [body] : []);
    if (!incoming.length) return c.json({ data: { error: 'No leads provided' } }, 400);
    if (incoming.length > 500) return c.json({ data: { error: 'Max 500 leads per request' } }, 400);

    // Resolve group names → ids (cache, auto-create)
    const groupCache = {};
    async function resolveGroup(name) {
      const n = (name || '').toString().trim();
      if (!n) return null;
      if (groupCache[n] !== undefined) return groupCache[n];
      const existing = await svc.entities.LeadGroup.filter({ client_id: clientId, name: n });
      let g = existing[0];
      if (!g) g = await svc.entities.LeadGroup.create({ client_id: clientId, name: n, source_type: 'import', color: 'blue' });
      groupCache[n] = g.id;
      return g.id;
    }

    const results = [];
    const syncedLeads = [];
    for (const item of incoming) {
      const phone = (item.phone || '').toString().trim();
      if (!phone) { results.push({ ok: false, error: 'phone required' }); continue; }

      const groupId = item.group ? await resolveGroup(item.group) : null;
      const fields = {
        client_id: clientId,
        name: item.name || '',
        phone,
        email: item.email || '',
        company: item.company || '',
        notes: item.notes || '',
        source: item.source || 'api',
        status: ['new', 'contacted', 'interested', 'not_interested', 'callback', 'converted', 'do_not_call'].includes(item.status) ? item.status : 'new',
        tags: Array.isArray(item.tags) ? item.tags : [],
        crm_id: item.crm_id || '',
        // Size cap: reject oversized custom_fields blobs (entity-bloat / cost
        // amplification vector). 8KB serialized is generous for structured CRM data.
        custom_fields: (() => {
          let cf = item.custom_fields && typeof item.custom_fields === 'object' ? item.custom_fields : {};
          try { if (JSON.stringify(cf).length > 8192) return {}; } catch (_) { return {}; }
          return coerceCustomFields(cf);
        })(),
        ...(groupId ? { group_ids: [groupId] } : {})
      };

      // Idempotency by crm_id
      let lead = null;
      if (item.crm_id) {
        const dup = await svc.entities.Lead.filter({ client_id: clientId, crm_id: item.crm_id });
        if (dup[0]) {
          const merged = groupId ? [...new Set([...(dup[0].group_ids || []), groupId])] : (dup[0].group_ids || []);
          lead = await svc.entities.Lead.update(dup[0].id, { ...fields, group_ids: merged });
          results.push({ ok: true, id: lead.id, action: 'updated', crm_id: item.crm_id });
          syncedLeads.push(lead);
          continue;
        }
      }
      lead = await svc.entities.Lead.create(fields);
      results.push({ ok: true, id: lead.id, action: 'created', crm_id: item.crm_id || null });
      syncedLeads.push(lead);
    }

    // ── Mirror to Postgres (best-effort, never blocks ingest) ──
    // Keeps the PG leads mirror live without depending on the entity
    // automation (which is gated by integration credits).
    for (const l of syncedLeads) {
      svc.functions.invoke('pgLeadSync', { lead: l }).catch(() => {});
    }

    // Usage tracking (fire-and-forget)
    svc.entities.ApiKey.update(key.id, {
      last_used_at: new Date().toISOString(),
      request_count: (key.request_count || 0) + 1
    }).catch(() => {});

    const created = results.filter(r => r.ok && r.action === 'created').length;
    const updated = results.filter(r => r.ok && r.action === 'updated').length;
    const failed = results.filter(r => !r.ok).length;
    return c.json({ data: { success: true, created, updated, failed, results } });
  } catch (error) {
    console.error('publicLeadsIngest error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};