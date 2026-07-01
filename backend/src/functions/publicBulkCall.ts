import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// publicBulkCall — PUBLIC bulk-dial endpoint for third-party CRMs
// ═══════════════════════════════════════════════════════════════════════
// Auth: Authorization: Bearer vaani_live_xxx   (scope: calls:write)
//
// Accepts up to 5,000 leads, ingests/dedupes them (by crm_id, else phone),
// then creates a Vaani Campaign that dials them across the client's channels.
// The existing campaign engine (campaignPoller) owns pacing + concurrency +
// per-DID rotation, so we don't reinvent dialling here.
//
// Body:
//   {
//     "agent_id": "abc123",            // required
//     "campaign_name": "Checkout recovery Jun-18",
//     "leads": [ { "phone": "...", "name": "...", "email": "...",
//                  "crm_id": "...", "custom_fields": {...} }, ... ],  // ≤5000
//     "context": "...",                // optional extra agent instructions
//     "max_concurrent_calls": 10       // optional (defaults to channel count)
//   }
// Returns: { success, campaign_id, leads_ingested, created, updated }
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
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

export default async function publicBulkCall(c: any) {
  const req = c.req.raw || c.req;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return c.json({ data: { error: 'Method not allowed' } }, 405);

  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // ── Auth (scope calls:write) ──
    const auth = req.headers.get('authorization') || '';
    const raw = auth.replace(/^Bearer\s+/i, '').trim();
    if (!raw) return c.json({ data: { error: 'Missing API key' } }, 401);
    const hash = await sha256Hex(raw);
    const keys = await svc.entities.ApiKey.filter({ key_hash: hash });
    const key = keys[0];
    if (!key) return c.json({ data: { error: 'Invalid API key' } }, 401);
    if (key.status !== 'active') return c.json({ data: { error: `API key is ${key.status}` } }, 403);
    if (!(key.scopes || []).includes('calls:write')) return c.json({ data: { error: 'Key lacks calls:write scope' } }, 403);
    const clientId = key.client_id;

    // ── Rate limit (bulk is heavier → 10 req/min/key) ──
    try {
      const windowStart = new Date(); windowStart.setSeconds(0, 0);
      const bucketKey = `apikey:${key.id}:bulkcall:${windowStart.toISOString()}`;
      const existing = await svc.entities.RateBucket.filter({ bucket_key: bucketKey });
      const bucket = existing[0];
      if (bucket) {
        if ((bucket.count || 0) >= 10) return c.json({ data: { error: 'Rate limit exceeded (10 bulk requests/min)' } }, 429);
        await svc.entities.RateBucket.update(bucket.id, { count: (bucket.count || 0) + 1 });
      } else {
        await svc.entities.RateBucket.create({ bucket_key: bucketKey, identity: key.id, endpoint: 'bulk_call', window_start: windowStart.toISOString(), count: 1 });
      }
    } catch (e) { console.error('publicBulkCall rate-limit check failed (allowing):', e.message); }

    const body = await c.req.json().catch(() => ({}));
    const agentId = (body.agent_id || '').toString().trim();
    const incoming = Array.isArray(body.leads) ? body.leads : [];
    if (!agentId) return c.json({ data: { error: 'agent_id is required' } }, 400);
    if (!incoming.length) return c.json({ data: { error: 'No leads provided' } }, 400);
    if (incoming.length > 5000) return c.json({ data: { error: 'Max 5000 leads per batch' } }, 400);

    // Validate agent ownership.
    const agent = await svc.entities.Agent.get(agentId).catch(() => null);
    if (!agent) return c.json({ data: { error: `Agent not found (id: ${agentId})` } }, 404);
    if (agent.client_id !== clientId) return c.json({ data: { error: 'Forbidden: agent does not belong to your account' } }, 403);

    // ── Ingest / dedupe leads ──
    let created = 0, updated = 0;
    const leadIds = [];
    // Pre-load existing leads once for phone-dedupe (cap at a sane window).
    const existingLeads = await svc.entities.Lead.filter({ client_id: clientId }, '-updated_date', 5000);
    const byPhone = new Map(existingLeads.map(l => [last10(l.phone), l]));
    const byCrm = new Map(existingLeads.filter(l => l.crm_id).map(l => [l.crm_id, l]));

    for (const item of incoming) {
      const phone = (item.phone || '').toString().trim();
      if (!phone) continue;
      const fields = {
        client_id: clientId,
        name: item.name || '',
        phone,
        email: item.email || '',
        source: item.source || 'api_bulk_call',
        crm_id: item.crm_id || '',
        custom_fields: (item.custom_fields && typeof item.custom_fields === 'object') ? item.custom_fields : {}
      };
      let existing = (item.crm_id && byCrm.get(item.crm_id)) || byPhone.get(last10(phone)) || null;
      if (existing) {
        const lead = await svc.entities.Lead.update(existing.id, fields);
        leadIds.push(existing.id); updated++;
        svc.functions.invoke('pgLeadSync', { lead }).catch(() => {});
      } else {
        const lead = await svc.entities.Lead.create({ ...fields, status: 'new' });
        leadIds.push(lead.id); created++;
        byPhone.set(last10(phone), lead);
        if (item.crm_id) byCrm.set(item.crm_id, lead);
        svc.functions.invoke('pgLeadSync', { lead }).catch(() => {});
      }
    }

    if (!leadIds.length) return c.json({ data: { error: 'No valid leads (all missing phone)' } }, 400);

    // ── Create a campaign that the engine will dial across channels ──
    const campaign = await svc.entities.Campaign.create({
      client_id: clientId,
      name: body.campaign_name || `API Bulk Call ${new Date().toISOString().slice(0, 16)}`,
      type: 'cold_call',
      agent_id: agentId,
      status: 'running',
      total_leads: leadIds.length,
      max_concurrent_calls: Math.max(1, parseInt(body.max_concurrent_calls, 10) || (agent.assigned_dids?.length || 1)),
      started_at: new Date().toISOString(),
      notes: body.context ? `[API] ${body.context}` : '[Created via publicBulkCall API]'
    });

    // Attach leads to the campaign so campaignPoller picks them up.
    for (const lid of leadIds) {
      svc.entities.CampaignLead.create({
        campaign_id: campaign.id,
        client_id: clientId,
        lead_id: lid,
        status: 'pending'
      }).catch(() => {});
    }

    svc.entities.ApiKey.update(key.id, { last_used_at: new Date().toISOString(), request_count: (key.request_count || 0) + 1 }).catch(() => {});

    return c.json({ data: {
      success: true,
      campaign_id: campaign.id,
      leads_ingested: leadIds.length,
      created,
      updated,
      message: 'Campaign created and queued. Calls will be dialled across your channels by the campaign engine.'
    } });
  } catch (error) {
    console.error('publicBulkCall error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};