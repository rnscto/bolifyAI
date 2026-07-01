import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// publicLeadsExport — PUBLIC pull endpoint for third-party CRMs (GET-style)
// ═══════════════════════════════════════════════════════════════════════
// Auth: Authorization: Bearer vaani_live_xxx  (scope: leads:read / outcomes:read)
//
// Because Base44 functions only accept a POST payload (no real query params),
// callers send filters in the JSON body. Returns leads + their latest call
// outcome data, with optional custom field mapping so the client's CRM gets
// exactly the JSON shape they want.
//
// Body:
//   {
//     "updated_since": "2026-06-01T00:00:00Z",  // optional ISO filter
//     "status": "interested",                    // optional
//     "group": "Webinar Jan 2026",               // optional (by name)
//     "limit": 100,                              // default 100, max 500
//     "skip": 0,
//     "include_outcomes": true,                  // attach latest call data
//     "field_map": {                             // optional output renaming
//       "name": "full_name", "phone": "mobile", "score": "lead_score"
//     }
//   }
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

function applyFieldMap(obj, map) {
  if (!map || typeof map !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[map[k] || k] = v;
  return out;
}

export default async function publicLeadsExport(c: any) {
  const req = c.req.raw || c.req;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return c.json({ data: { error: 'Use POST with JSON body for filters' } }, 405);

  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const auth = req.headers.get('authorization') || '';
    const raw = auth.replace(/^Bearer\s+/i, '').trim();
    if (!raw) return c.json({ data: { error: 'Missing API key' } }, 401);
    const hash = await sha256Hex(raw);
    const keys = await svc.entities.ApiKey.filter({ key_hash: hash });
    const key = keys[0];
    if (!key) return c.json({ data: { error: 'Invalid API key' } }, 401);
    if (key.status !== 'active') return c.json({ data: { error: `API key is ${key.status}` } }, 403);
    const scopes = key.scopes || [];
    if (!scopes.includes('leads:read') && !scopes.includes('outcomes:read'))
      return c.json({ data: { error: 'Key lacks leads:read scope' } }, 403);

    // ── RATE LIMIT (fixed 1-minute window, per API key) — 60 req/min ──
    try {
      const windowStart = new Date();
      windowStart.setSeconds(0, 0);
      const bucketKey = `apikey:${key.id}:export:${windowStart.toISOString()}`;
      const existing = await svc.entities.RateBucket.filter({ bucket_key: bucketKey });
      const bucket = existing[0];
      if (bucket) {
        if ((bucket.count || 0) >= 60) {
          return c.json({ data: { error: 'Rate limit exceeded (60 requests/min). Slow down.' } }, 429);
        }
        await svc.entities.RateBucket.update(bucket.id, { count: (bucket.count || 0) + 1 });
      } else {
        await svc.entities.RateBucket.create({
          bucket_key: bucketKey, identity: key.id, endpoint: 'leads_export',
          window_start: windowStart.toISOString(), count: 1
        });
      }
    } catch (rlErr) {
      console.error('publicLeadsExport rate-limit check failed (allowing):', rlErr.message);
    }

    const clientId = key.client_id;
    const body = await c.req.json().catch(() => ({}));
    const limit = Math.min(500, Math.max(1, parseInt(body.limit) || 100));
    const skip = Math.max(0, parseInt(body.skip) || 0);

    // ── Resolve the client's industry blueprint CRM field mapping (optional) ──
    // Lets custom_fields export under external CRM field names automatically.
    // Shape: { salesforce: { budget: 'Amount' }, default: { budget: 'Budget' } }
    let customFieldMap = null;
    try {
      const client = await svc.entities.Client.get(clientId).catch(() => null);
      // Prefer the manual override (blueprint_key), else slugify the industry label.
      const industryKey = client?.blueprint_key
        ? client.blueprint_key
        : (client?.industry
            ? String(client.industry).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
            : null);
      if (industryKey) {
        const bps = await svc.entities.IndustryBlueprint.filter({ industry_key: industryKey, status: 'active' });
        const mapping = bps[0]?.crm_field_mapping;
        if (mapping && typeof mapping === 'object') {
          // Pick the platform-specific map if the caller named one, else 'default', else first.
          const platform = body.crm_platform;
          customFieldMap = mapping[platform] || mapping.default || Object.values(mapping)[0] || null;
        }
      }
    } catch (_) { /* mapping is optional — ignore failures */ }

    // Build filter
    const filter = { client_id: clientId };
    if (body.status) filter.status = body.status;
    if (body.group) {
      const g = await svc.entities.LeadGroup.filter({ client_id: clientId, name: body.group });
      if (g[0]) filter.group_ids = g[0].id;
      else return c.json({ data: { success: true, count: 0, leads: [] } });
    }

    let leads = await svc.entities.Lead.filter(filter, '-updated_date', limit + skip);
    // updated_since filter (client-side; created/updated_date is built-in)
    if (body.updated_since) {
      const since = new Date(body.updated_since).getTime();
      leads = leads.filter(l => new Date(l.updated_date || l.created_date).getTime() >= since);
    }
    leads = leads.slice(skip, skip + limit);

    const includeOutcomes = body.include_outcomes !== false && scopes.includes('outcomes:read');
    const out = [];
    for (const l of leads) {
      let base = {
        id: l.id,
        crm_id: l.crm_id || null,
        name: l.name || '',
        phone: l.phone || '',
        email: l.email || '',
        company: l.company || '',
        status: l.status,
        score: l.score || 0,
        sentiment: l.sentiment || null,
        qualification_tier: l.qualification_tier || null,
        tags: l.tags || [],
        source: l.source || '',
        custom_fields: l.custom_fields || {},
        // Mapped custom fields hoisted to top level using the blueprint's
        // crm_field_mapping (e.g. budget → Amount). Original custom_fields kept.
        ...(customFieldMap
          ? Object.fromEntries(
              Object.entries(l.custom_fields || {})
                .filter(([k]) => customFieldMap[k])
                .map(([k, v]) => [customFieldMap[k], v])
            )
          : {}),
        last_call_date: l.last_call_date || null,
        next_followup_date: l.next_followup_date || null,
        created_at: l.created_date,
        updated_at: l.updated_date
      };

      if (includeOutcomes) {
        const logs = await svc.entities.CallLog.filter({ client_id: clientId, lead_id: l.id }, '-created_date', 1);
        const last = logs[0];
        base.last_outcome = last ? {
          call_status: last.status,
          duration: last.duration || 0,
          lead_status_updated: last.lead_status_updated || null,
          summary: last.conversation_summary || '',
          recording_url: last.recording_url || null,
          call_time: last.call_start_time || last.created_date
        } : null;
      }

      out.push(applyFieldMap(base, body.field_map));
    }

    svc.entities.ApiKey.update(key.id, {
      last_used_at: new Date().toISOString(),
      request_count: (key.request_count || 0) + 1
    }).catch(() => {});

    return c.json({ data: { success: true, count: out.length, leads: out } });
  } catch (error) {
    console.error('publicLeadsExport error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};