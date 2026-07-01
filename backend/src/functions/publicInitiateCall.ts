import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// publicInitiateCall — PUBLIC single-call trigger for third-party CRMs
// ═══════════════════════════════════════════════════════════════════════
// Auth: Authorization: Bearer vaani_live_xxx   (scope: calls:write)
//
// Triggers ONE outbound AI call from the caller's CRM rule engine.
// Resolves (or auto-creates) the lead by phone, validates the agent belongs
// to the API key's client, then delegates to the internal `initiateCall`
// (service_call=true) which owns all telephony/compliance/quota logic.
//
// Body:
//   {
//     "phone": "+9199...",            // required — number to dial
//     "agent_id": "abc123",           // required — one of the client's agents
//     "name": "Rahul",                // optional — used if a new lead is created
//     "email": "...",                 // optional
//     "crm_id": "EXT-123",            // optional — for idempotent lead match
//     "source": "checkout_abandon",   // optional — lead source tag
//     "context": "Customer abandoned checkout; explain installment plan.",
//                                      // optional — extra agent instructions (per-intent)
//     "custom_fields": { ... }        // optional
//   }
// Returns: { success, call_id, call_log_id, call_sid, lead_id }
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

// Reusable API-key auth + per-minute rate limit. Returns { key } or a Response.
async function authenticate(svc, req, endpoint, requiredScope) {
  const auth = req.headers.get('authorization') || '';
  const raw = auth.replace(/^Bearer\s+/i, '').trim();
  if (!raw) return { error: c.json({ data: { error: 'Missing API key' } }, 401) };
  const hash = await sha256Hex(raw);
  const keys = await svc.entities.ApiKey.filter({ key_hash: hash });
  const key = keys[0];
  if (!key) return { error: c.json({ data: { error: 'Invalid API key' } }, 401) };
  if (key.status !== 'active') return { error: c.json({ data: { error: `API key is ${key.status}` } }, 403) };
  if (!(key.scopes || []).includes(requiredScope)) {
    return { error: c.json({ data: { error: `Key lacks ${requiredScope} scope` } }, 403) };
  }
  // Rate limit: 60 req/min/key (fail-open on limiter glitch).
  try {
    const windowStart = new Date(); windowStart.setSeconds(0, 0);
    const bucketKey = `apikey:${key.id}:${endpoint}:${windowStart.toISOString()}`;
    const existing = await svc.entities.RateBucket.filter({ bucket_key: bucketKey });
    const bucket = existing[0];
    if (bucket) {
      if ((bucket.count || 0) >= 60) return { error: c.json({ data: { error: 'Rate limit exceeded (60/min)' } }, 429) };
      await svc.entities.RateBucket.update(bucket.id, { count: (bucket.count || 0) + 1 });
    } else {
      await svc.entities.RateBucket.create({ bucket_key: bucketKey, identity: key.id, endpoint, window_start: windowStart.toISOString(), count: 1 });
    }
  } catch (e) { console.error('publicInitiateCall rate-limit check failed (allowing):', e.message); }
  return { key };
}

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

export default async function publicInitiateCall(c: any) {
  const req = c.req.raw || c.req;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return c.json({ data: { error: 'Method not allowed' } }, 405);

  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const a = await authenticate(svc, req, 'calls_trigger', 'calls:write');
    if (a.error) return a.error;
    const key = a.key;
    const clientId = key.client_id;

    const body = await c.req.json().catch(() => ({}));
    const phone = (body.phone || '').toString().trim();
    const agentId = (body.agent_id || '').toString().trim();
    if (!phone) return c.json({ data: { error: 'phone is required' } }, 400);
    if (!agentId) return c.json({ data: { error: 'agent_id is required' } }, 400);

    // Resolve the agent — accept either an agent ID or an agent NAME so CRM
    // rules can reference a human-friendly agent (e.g. "Roshni") instead of a UUID.
    // 1) Try direct ID lookup. 2) Fall back to case-insensitive name match within
    // this API key's client (tenant isolation). A client may have multiple agents;
    // if the name is ambiguous, ask the caller to disambiguate by ID.
    let agent = await svc.entities.Agent.get(agentId).catch(() => null);
    if (agent && agent.client_id !== clientId) {
      return c.json({ data: { error: 'Forbidden: agent does not belong to your account' } }, 403);
    }
    if (!agent) {
      const clientAgents = await svc.entities.Agent.filter({ client_id: clientId });
      const wanted = agentId.toLowerCase();
      const byName = clientAgents.filter(ag => (ag.name || '').toLowerCase() === wanted);
      if (byName.length === 1) {
        agent = byName[0];
      } else if (byName.length > 1) {
        return c.json({ data: {
          error: `Multiple agents named "${agentId}". Use the agent_id (UUID) instead.`,
          matches: byName.map(ag => ({ id: ag.id, name: ag.name }))
        } }, 409);
      } else {
        const available = clientAgents.map(ag => ({ id: ag.id, name: ag.name }));
        return c.json({ data: { error: `Agent not found (id/name: ${agentId})`, available_agents: available } }, 404);
      }
    }
    // Use the resolved agent's real ID for everything downstream.
    const resolvedAgentId = agent.id;

    // Resolve or create the lead. Prefer crm_id match, then phone match, else create.
    let lead = null;
    if (body.crm_id) {
      const byCrm = await svc.entities.Lead.filter({ client_id: clientId, crm_id: body.crm_id });
      if (byCrm[0]) lead = byCrm[0];
    }
    if (!lead) {
      const p10 = last10(phone);
      const candidates = await svc.entities.Lead.filter({ client_id: clientId }, '-updated_date', 200);
      lead = candidates.find(l => last10(l.phone) === p10) || null;
    }
    if (!lead) {
      lead = await svc.entities.Lead.create({
        client_id: clientId,
        name: body.name || '',
        phone,
        email: body.email || '',
        source: body.source || 'api_call',
        status: 'new',
        crm_id: body.crm_id || '',
        custom_fields: (body.custom_fields && typeof body.custom_fields === 'object') ? body.custom_fields : {}
      });
      svc.functions.invoke('pgLeadSync', { lead }).catch(() => {});
    }

    // Delegate to the internal dialer — it owns DNC/BFSI/quota/provider routing.
    let result;
    try {
      const res = await svc.functions.invoke('initiateCall', {
        service_call: true,
        lead_id: lead.id,
        agent_id: resolvedAgentId,
        phone_number: phone,
        context_override: body.context || ''
      });
      result = res?.data || {};
    } catch (e) {
      const data = e?.response?.data || e?.data || {};
      const msg = data.error || e.message || 'Call initiation failed';
      console.error('publicInitiateCall: initiateCall failed:', msg);
      return c.json({ data: { success: false, error: msg, block_reason: data.block_reason || null } }, 400);
    }

    if (result.success === false) {
      return c.json({ data: { success: false, error: result.error, block_reason: result.block_reason || null } }, 400);
    }

    svc.entities.ApiKey.update(key.id, { last_used_at: new Date().toISOString(), request_count: (key.request_count || 0) + 1 }).catch(() => {});

    return c.json({ data: {
      success: true,
      lead_id: lead.id,
      call_id: result.call_id || result.call_log_id,
      call_log_id: result.call_log_id || result.call_id,
      call_sid: result.call_sid || null
    } });
  } catch (error) {
    console.error('publicInitiateCall error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};