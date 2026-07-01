import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Server-side aggregation for the Client main Dashboard.
//
// Replaces the old client-side approach that paginated CallLog 500-at-a-time
// in a sequential loop (countAll) — that caused slow loads and 429 rate-limit
// storms. Here we compute everything server-side with bounded, retried queries
// and a short per-client cache so rapid revisits/polls are free.
//
// Payload: { client_id }
// Returns: {
//   totalAgents, activeAgents, totalLeads, totalCalls, callsToday, upcomingActivities
// }



const SCAN_PAGE = 500;
const TTL_MS = 30_000; // cache the heavy bundle for 30s per client
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _cache = new Map(); // client_id -> { expiresAt, result }

async function withRetry(fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e?.message || '';
      if (/429|rate limit/i.test(msg) && attempt < 3) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

// Count all records matching a query by paginating with retry + small gaps
// (avoids hammering the API which triggers 429).
async function countAll(svc, entity, query) {
  let skip = 0;
  let total = 0;
  for (let p = 0; p < 400; p++) {
    const batch = await withRetry(() =>
      svc.entities[entity].filter(query, '-created_date', SCAN_PAGE, skip)
    );
    total += batch.length;
    if (batch.length < SCAN_PAGE) break;
    skip += SCAN_PAGE;
    await sleep(120);
  }
  return total;
}

export default async function getClientDashboardStats(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id } = await c.req.json();
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    const cached = _cache.get(client_id);
    if (cached && cached.expiresAt > Date.now()) {
      return c.json({ data: cached.result });
    }

    const svc = base44.asServiceRole;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Total calls + today's calls now come from Postgres (single counts)
    // instead of paginating the entire CallLog table. Falls back to the
    // Base44 scan if the PG call fails.
    let pgCalls = null;
    try {
      const r = await base44.functions.invoke('pgDashboardCounts', { client_id });
      if (r?.data && typeof r.data.totalCalls === 'number') pgCalls = r.data;
    } catch (e) {
      console.warn('[getClientDashboardStats] pg counts failed, falling back:', e.message);
    }

    // Run independent reads in parallel. Each is a single bounded query.
    const [agents, clientStatsRows, totalCalls, recentCalls, activities] = await Promise.all([
      withRetry(() => svc.entities.Agent.filter({ client_id })),
      withRetry(() => svc.entities.ClientStats.filter({ client_id })),
      pgCalls ? Promise.resolve(pgCalls.totalCalls) : countAll(svc, 'CallLog', { client_id }),
      pgCalls ? Promise.resolve([]) : withRetry(() => svc.entities.CallLog.filter({ client_id }, '-created_date', SCAN_PAGE)),
      withRetry(() => svc.entities.Activity.filter({ client_id })),
    ]);

    // Lead total from the materialized ClientStats row; fall back to a full
    // count only when the row hasn't been created yet.
    let totalLeads = clientStatsRows?.[0]?.leads_total;
    if (totalLeads === undefined || totalLeads === null) {
      totalLeads = await countAll(svc, 'Lead', { client_id });
    }

    // Today's calls — from Postgres when available, else from the recent page.
    const callsToday = pgCalls
      ? pgCalls.callsToday
      : recentCalls.filter(
          (c) => c.created_date && new Date(c.created_date) >= todayStart
        ).length;

    const now = new Date();
    const upcomingActivities = activities.filter(
      (a) => a.status === 'scheduled' && new Date(a.scheduled_date) > now
    ).length;

    const result = {
      totalAgents: agents.length,
      activeAgents: agents.filter((a) => a.status === 'active').length,
      totalLeads,
      totalCalls,
      callsToday,
      upcomingActivities,
    };

    _cache.set(client_id, { expiresAt: Date.now() + TTL_MS, result });
    return c.json({ data: result });
  } catch (error) {
    console.error('getClientDashboardStats error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};