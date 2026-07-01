import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// ═══════════════════════════════════════════════════════════════════
// Phase 2 — MATERIALIZED STATS (maintain-on-write)
//
// Triggered by an entity automation on Lead create/update/delete.
// Applies a SINGLE incremental delta to the client's ClientStats row
// instead of re-scanning every lead. This is what permanently kills the
// recompute-on-read pattern that caused dashboard 429s.
//
// SAFETY:
//  - Best-effort: any failure is swallowed and logged (never blocks the
//    Lead write that triggered it).
//  - reconcileClientStats does a full recount on a schedule and self-heals
//    any drift from a missed/duplicate delta.
//  - Purely additive: dashboards can keep their old full-scan reads until
//    they opt into ClientStats.
// ═══════════════════════════════════════════════════════════════════

const LEAD_STATUSES = ['new', 'contacted', 'interested', 'not_interested', 'callback', 'converted', 'do_not_call'];
const LEAD_TIERS = ['hot', 'warm', 'nurture', 'cold', 'disqualified'];

function emptyStatusMap() {
  const m = {};
  for (const s of LEAD_STATUSES) m[s] = 0;
  return m;
}
function emptyTierMap() {
  const m = {};
  for (const t of LEAD_TIERS) m[t] = 0;
  return m;
}

async function getOrCreateStats(svc, clientId) {
  const existing = await svc.entities.ClientStats.filter({ client_id: clientId }, '-created_date', 1);
  if (existing && existing.length > 0) return existing[0];
  return await svc.entities.ClientStats.create({
    client_id: clientId,
    leads_total: 0,
    leads_by_status: emptyStatusMap(),
    leads_by_tier: emptyTierMap(),
    leads_by_source: {},
    leads_by_group: {},
    leads_ungrouped: 0
  });
}

export default async function maintainClientStats(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));
    const event = body.event || {};
    const data = body.data || null;
    const oldData = body.old_data || null;
    const eventType = event.type; // create | update | delete

    // Resolve client_id from whichever payload is present
    const clientId = (data && data.client_id) || (oldData && oldData.client_id);
    if (!clientId) {
      return c.json({ data: { success: true, skipped: 'no_client_id' } });
    }

    const stats = await getOrCreateStats(svc, clientId);
    const byStatus = { ...emptyStatusMap(), ...(stats.leads_by_status || {}) };
    const byTier = { ...emptyTierMap(), ...(stats.leads_by_tier || {}) };
    const bySource = { ...(stats.leads_by_source || {}) };
    const byGroup = { ...(stats.leads_by_group || {}) };
    let total = stats.leads_total || 0;
    let ungrouped = stats.leads_ungrouped || 0;

    const bump = (status, delta) => {
      if (status && byStatus[status] !== undefined) {
        byStatus[status] = Math.max(0, (byStatus[status] || 0) + delta);
      }
    };
    const bumpTier = (tier, delta) => {
      if (tier && byTier[tier] !== undefined) {
        byTier[tier] = Math.max(0, (byTier[tier] || 0) + delta);
      }
    };
    const bumpSource = (src, delta) => {
      if (!src) return;
      const next = Math.max(0, (bySource[src] || 0) + delta);
      if (next === 0) delete bySource[src]; else bySource[src] = next;
    };
    // Apply a +1/-1 delta across a lead's group memberships (and the ungrouped bucket).
    const applyGroups = (lead, delta) => {
      const gids = lead?.group_ids || [];
      if (gids.length === 0) { ungrouped = Math.max(0, ungrouped + delta); return; }
      for (const gid of gids) {
        if (!byGroup[gid]) byGroup[gid] = { total: 0, contacted: 0, converted: 0 };
        byGroup[gid].total = Math.max(0, (byGroup[gid].total || 0) + delta);
        if (lead.last_call_date) byGroup[gid].contacted = Math.max(0, (byGroup[gid].contacted || 0) + delta);
        if (lead.status === 'converted') byGroup[gid].converted = Math.max(0, (byGroup[gid].converted || 0) + delta);
        if (byGroup[gid].total === 0) delete byGroup[gid];
      }
    };

    if (eventType === 'create') {
      total += 1;
      bump(data?.status || 'new', +1);
      bumpTier(data?.qualification_tier, +1);
      bumpSource(data?.source, +1);
      applyGroups(data, +1);
    } else if (eventType === 'delete') {
      const lead = oldData || data;
      total = Math.max(0, total - 1);
      bump(lead?.status || 'new', -1);
      bumpTier(lead?.qualification_tier, -1);
      bumpSource(lead?.source, -1);
      applyGroups(lead, -1);
    } else if (eventType === 'update') {
      // Status bucket
      if (oldData?.status && data?.status && oldData.status !== data.status) {
        bump(oldData.status, -1);
        bump(data.status, +1);
      }
      // Tier bucket
      if (oldData?.qualification_tier !== data?.qualification_tier) {
        bumpTier(oldData?.qualification_tier, -1);
        bumpTier(data?.qualification_tier, +1);
      }
      // Source bucket
      if (oldData?.source !== data?.source) {
        bumpSource(oldData?.source, -1);
        bumpSource(data?.source, +1);
      }
      // Group membership / group-stat fields changed → re-apply cleanly
      const groupsChanged =
        JSON.stringify(oldData?.group_ids || []) !== JSON.stringify(data?.group_ids || []) ||
        oldData?.last_call_date !== data?.last_call_date ||
        oldData?.status !== data?.status;
      if (groupsChanged) {
        applyGroups(oldData, -1);
        applyGroups(data, +1);
      }
      // total unchanged on update
    }

    await svc.entities.ClientStats.update(stats.id, {
      leads_total: total,
      leads_by_status: byStatus,
      leads_by_tier: byTier,
      leads_by_source: bySource,
      leads_by_group: byGroup,
      leads_ungrouped: ungrouped
    });

    return c.json({ data: { success: true, client_id: clientId, leads_total: total } });
  } catch (error) {
    // Never block the Lead write — swallow and log.
    console.warn(`[maintainClientStats] skipped: ${error.message}`);
    return c.json({ data: { success: true, skipped: 'error', message: error.message } });
  }

};