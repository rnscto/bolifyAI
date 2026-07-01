import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════
// Phase 2 — MATERIALIZED STATS RECONCILER (authoritative safety-net)
//
// Recounts every client's lead breakdown from the Azure Postgres `leads`
// mirror (dual-written by pgLeadSync) using SQL aggregation — a handful of
// cheap grouped queries per client instead of paginating thousands of
// Base44 Lead reads. This eliminates the 429 pressure that crashed the
// old full-fleet scan, and self-heals any drift left by maintainClientStats.
//
// External cron auth (CRON_API_KEY or SMARTFLO_WEBHOOK_SECRET via query).
// ═══════════════════════════════════════════════════════════════════

const LEAD_STATUSES = ['new', 'contacted', 'interested', 'not_interested', 'callback', 'converted', 'do_not_call'];
const LEAD_TIERS = ['hot', 'warm', 'nurture', 'cold', 'disqualified'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (/429|rate limit/i.test(e.message) && i < attempts - 1) { await sleep(1000 * Math.pow(2, i)); continue; }
      throw e;
    }
  }
}

function pgClient() {
  return new Client({
    hostname: Deno.env.get('AZURE_PG_HOST'),
    port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
    database: Deno.env.get('AZURE_PG_DATABASE'),
    user: Deno.env.get('AZURE_PG_USER'),
    password: Deno.env.get('AZURE_PG_PASSWORD'),
    tls: { enabled: true, enforce: true },
    connection: { attempts: 1 },
  });
}

// Compute all breakdowns for one client via SQL aggregation on Postgres.
async function computeAllStats(pg, clientId) {
  const byStatus = {}; for (const s of LEAD_STATUSES) byStatus[s] = 0;
  const byTier = {}; for (const t of LEAD_TIERS) byTier[t] = 0;
  const bySource = {};
  const byGroup = {};
  let ungrouped = 0;
  let total = 0;

  // Status + total
  const sRes = await pg.queryObject`
    SELECT status, COUNT(*)::int AS n FROM leads WHERE client_id = ${clientId} GROUP BY status
  `;
  for (const r of sRes.rows) {
    total += r.n;
    if (r.status && byStatus[r.status] !== undefined) byStatus[r.status] = r.n;
  }

  // Tier
  const tRes = await pg.queryObject`
    SELECT qualification_tier AS tier, COUNT(*)::int AS n FROM leads WHERE client_id = ${clientId} GROUP BY qualification_tier
  `;
  for (const r of tRes.rows) {
    if (r.tier && byTier[r.tier] !== undefined) byTier[r.tier] = r.n;
  }

  // Source
  const srcRes = await pg.queryObject`
    SELECT source, COUNT(*)::int AS n FROM leads WHERE client_id = ${clientId} AND source IS NOT NULL GROUP BY source
  `;
  for (const r of srcRes.rows) bySource[r.source] = r.n;

  // Ungrouped (no group_ids)
  const ugRes = await pg.queryObject`
    SELECT COUNT(*)::int AS n FROM leads WHERE client_id = ${clientId} AND cardinality(group_ids) = 0
  `;
  ungrouped = ugRes.rows[0]?.n || 0;

  // Per-group breakdown — unnest group_ids
  const gRes = await pg.queryObject`
    SELECT gid,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE has_call)::int AS contacted,
           COUNT(*) FILTER (WHERE status = 'converted')::int AS converted
    FROM leads, unnest(group_ids) AS gid
    WHERE client_id = ${clientId}
    GROUP BY gid
  `;
  for (const r of gRes.rows) {
    byGroup[r.gid] = { total: r.total, contacted: r.contacted, converted: r.converted };
  }

  return { total, byStatus, byTier, bySource, byGroup, ungrouped };
}

export default async function reconcileClientStats(c: any) {
  const req = c.req.raw || c.req;
  try {
    const url = new URL(req.url);
    const cronSecret = url.searchParams.get('cron_secret');
    const cronApiKey = url.searchParams.get('api_key');
    const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
    const expectedCronKey = Deno.env.get('CRON_API_KEY');
    let isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);

    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));

    // Also allow authenticated service-role / admin invokes (e.g. the
    // getLeadsPage background heal, or a manual admin trigger). The SQL
    // aggregation is read-only on Postgres + writes only ClientStats, so it's
    // safe for an authenticated app caller.
    if (!isValid || body.service_call) {
      try {
        const caller = c.get('jwtPayload');
        if (caller) isValid = true;
      } catch (_) { /* not authenticated */ }
    }
    if (!isValid) return c.json({ data: { error: 'Forbidden' } }, 403);
    // With SQL aggregation each client is cheap, so we can do many per tick.
    const BATCH = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || body.limit || '50', 10), 200));

    let clients;
    if (body.client_id) {
      const c = await svc.entities.Client.get(body.client_id).catch(() => null);
      clients = c ? [c] : [];
    } else {
      // Rotate by staleness — oldest ClientStats first.
      const active = await withRetry(() => svc.entities.Client.filter({ status: 'active' }));
      const stats = await withRetry(() => svc.entities.ClientStats.list('last_reconciled_at', 500)).catch(() => []);
      const lastById = {};
      for (const s of stats) lastById[s.client_id] = s.last_reconciled_at || '';
      active.sort((a, b) => (lastById[a.id] || '').localeCompare(lastById[b.id] || ''));
      clients = active.slice(0, BATCH);
    }

    const results = { clients_reconciled: 0, errors: [] };

    // Map client_id → existing ClientStats id (one bulk read, no per-client query).
    const allStats = await withRetry(() => svc.entities.ClientStats.list('-created_date', 1000)).catch(() => []);
    const statsByClient = {};
    for (const s of allStats) if (!statsByClient[s.client_id]) statsByClient[s.client_id] = s;

    const pg = pgClient();
    try {
      ; /* pg.connect() not needed */
      for (const client of clients) {
        try {
          const { total, byStatus, byTier, bySource, byGroup, ungrouped } = await computeAllStats(pg, client.id);
          const payload = {
            client_id: client.id,
            leads_total: total,
            leads_by_status: byStatus,
            leads_by_tier: byTier,
            leads_by_source: bySource,
            leads_by_group: byGroup,
            leads_ungrouped: ungrouped,
            last_reconciled_at: new Date().toISOString()
          };
          const existing = statsByClient[client.id];
          if (existing) {
            await withRetry(() => svc.entities.ClientStats.update(existing.id, payload));
          } else {
            await withRetry(() => svc.entities.ClientStats.create(payload));
          }
          results.clients_reconciled++;
        } catch (e) {
          console.error(`[reconcileClientStats] Client ${client.id} failed: ${e.message}`);
          results.errors.push({ client_id: client.id, error: e.message });
        }
        await sleep(40); // light pace on Base44 ClientStats writes
      }
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }

    return c.json({ data: { success: true, ...results } });
  } catch (error) {
    console.error('[reconcileClientStats] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};