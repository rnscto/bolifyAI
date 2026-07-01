import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Server-side leads pagination + aggregate stats for the ClientLeads page.
//
// WORLD-CLASS FAST PATH (no full table scan on the hot path):
//   • Leads page: filtered + sorted + paginated NATIVELY in the DB. We only
//     ever pull the ONE page (50 rows) the user is looking at. This is what
//     makes the page load instantly even with 100k+ leads, and is the main
//     fix for the 429 rate-limit storms (we went from dozens of sequential
//     500-row scans per request → a single 50-row query).
//   • Stats (tier counts, source list, group stats, ungrouped count): these
//     genuinely need to see every lead, so they're computed by ONE full scan
//     but CACHED for 60s per client. Rapid filter/page clicks reuse the cache
//     instead of re-scanning. The very first load computes them; every click
//     after that is free.
//
// SLOW PATH (only when unavoidable):
//   • Free-text search and the "_ungrouped" pseudo-group can't be expressed as
//     a native query, so those fall back to scanning the (cached) full set.
//
// Payload: { client_id, page, page_size, group_id, tier, status, source, search }
// Returns: { leads, total, stats: { tiers, sources, groups, ungrouped, total } }



const SCAN_PAGE = 500; // SDK hard cap per call
// Tier/source/group stats still need a scan (not tracked in ClientStats), so we
// cache them longer (5 min) to keep the heavy scan OFF the hot path. The base
// total + per-status counts come from ClientStats (no scan, always fresh).
const STATS_TTL_MS = 300_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory cache of the heavy full-scan result, keyed by client_id.
// Survives across warm invocations of the same function instance.
const _statsCache = new Map(); // client_id -> { expiresAt, allLeads, stats }

// Fetch a single page with retry/backoff on rate-limit (429) errors.
async function fetchPageWithRetry(svc, query, sort, limit, offset) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await svc.entities.Lead.filter(query, sort, limit, offset);
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

async function fetchAll(svc, query) {
  const all = [];
  for (let p = 0; p < 200; p++) {
    const batch = await fetchPageWithRetry(svc, query, '-created_date', SCAN_PAGE, p * SCAN_PAGE);
    all.push(...batch);
    if (batch.length < SCAN_PAGE) break;
    await sleep(120);
  }
  return all;
}

const norm = (s) => (s || '').toString().toLowerCase();

// Compute the aggregate stats from a full lead set.
function computeStats(allLeads) {
  const tiers = { hot: 0, warm: 0, nurture: 0, cold: 0, disqualified: 0 };
  const sourceSet = new Set();
  const groupStats = {};
  let ungrouped = 0;

  for (const l of allLeads) {
    if (l.qualification_tier && tiers[l.qualification_tier] !== undefined) tiers[l.qualification_tier]++;
    if (l.source) sourceSet.add(l.source);
    const gids = l.group_ids || [];
    if (gids.length === 0) ungrouped++;
    for (const gid of gids) {
      if (!groupStats[gid]) groupStats[gid] = { total: 0, contacted: 0, converted: 0 };
      groupStats[gid].total++;
      if (l.last_call_date) groupStats[gid].contacted++;
      if (l.status === 'converted') groupStats[gid].converted++;
    }
  }

  return { tiers, sources: Array.from(sourceSet), groups: groupStats, ungrouped, total: allLeads.length };
}

// Read the authoritative materialized stats from ClientStats (maintained on
// every Lead write + reconciled on a schedule). No scan → always fast.
async function getClientStatsRow(svc, clientId) {
  const rows = await svc.entities.ClientStats.filter({ client_id: clientId }, '-created_date', 1).catch(() => []);
  return rows && rows[0] ? rows[0] : null;
}

// Build the stats object the page expects directly from a ClientStats row.
function statsFromRow(row) {
  const tiers = { hot: 0, warm: 0, nurture: 0, cold: 0, disqualified: 0, ...(row.leads_by_tier || {}) };
  const bySource = row.leads_by_source || {};
  return {
    tiers,
    statusCounts: row.leads_by_status || {},
    sources: Object.keys(bySource),
    groups: row.leads_by_group || {},
    ungrouped: row.leads_ungrouped || 0,
    total: row.leads_total || 0,
  };
}

// A ClientStats row is only trustworthy for the FULL breakdown UI if it was
// written by the complete maintainer/reconciler. Early rows only contained
// leads_total + leads_by_status (no tier/source/group maps) — using those would
// show 0 Hot/Warm leads and 0 group counts. Treat such rows as incomplete so we
// fall back to a fresh scan (and trigger a reconcile to heal the row).
function isCompleteStatsRow(row) {
  return (
    row.leads_by_tier !== undefined &&
    row.leads_by_group !== undefined &&
    row.last_reconciled_at  // only fully reconciled rows carry every breakdown
  );
}

// Get the breakdown stats for a client.
// HOT PATH: read everything from a COMPLETE ClientStats row — NO scan at all.
// FALLBACK: no row yet, or an incomplete/legacy row → cached full scan, and
// fire a background reconcile so the next load is fast.
async function getStatsBundle(svc, clientId) {
  const statsRow = await getClientStatsRow(svc, clientId);
  if (statsRow && isCompleteStatsRow(statsRow)) {
    return { fromRow: true, allLeads: null, stats: statsFromRow(statsRow) };
  }

  // No usable materialized row. CRITICAL: do NOT full-scan on the hot path —
  // on large lead tables that triggers 429 rate-limit storms and the whole
  // page fails to load. Serve a cheap (capped) native total + empty breakdowns,
  // and fire a background reconcile so the exact total + rich stats
  // (tiers/sources/groups) appear on the next load once ClientStats is healed.
  const total = await countFiltered(svc, { client_id: clientId }, 5);
  const stats = {
    tiers: { hot: 0, warm: 0, nurture: 0, cold: 0, disqualified: 0 },
    statusCounts: {},
    sources: [],
    groups: {},
    ungrouped: 0,
    total,
  };

  svc.functions.invoke('reconcileClientStats', { client_id: clientId, service_call: true }).catch(() => {});

  // allLeads:null signals downstream code to use native queries (never a scan).
  return { fromRow: false, allLeads: null, stats };
}

// Count leads matching a native filter without pulling all rows into memory.
// Pages through the result counting lengths — far cheaper than a full-table
// scan because filtered result sets are small.
async function countFiltered(svc, query, maxPages = 400) {
  const PAGE = 500;
  let total = 0, p = 0;
  for (; p < maxPages; p++) {
    const batch = await fetchPageWithRetry(svc, query, '-created_date', PAGE, p * PAGE);
    total += batch.length;
    if (batch.length < PAGE) break;
    await sleep(100);
  }
  return total;
}

export default async function getLeadsPage(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const {
      client_id,
      page = 1,
      page_size = 50,
      group_id = null,
      tier = 'all',
      status = 'all',
      source = 'all',
      search = '',
    } = body;

    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    const svc = base44.asServiceRole;
    const pageNum = Math.max(1, page);

    const bundle = await getStatsBundle(svc, client_id);
    const { allLeads, stats } = bundle;

    const s = norm(search);
    const needsFullScan =
      !!s ||                         // free-text search isn't a native query
      group_id === '_ungrouped';     // "no groups" can't be expressed natively

    // ===== FAST PATH: native DB pagination (no scan of all leads) =====
    if (!needsFullScan) {
      const query = { client_id };
      if (group_id) query.group_ids = group_id;       // array-contains match
      if (tier !== 'all') query.qualification_tier = tier;
      if (status !== 'all') query.status = status;
      if (source !== 'all') query.source = source;

      // Resolve the filtered total without any full scan:
      //  • No filters → use the materialized leads_total.
      //  • Single materialized filter (just tier / just status / just group /
      //    just source) → read straight from the ClientStats breakdown maps.
      //  • Anything more complex → one cheap native count of the small result set.
      const activeFilters = [
        group_id ? 'group' : null,
        tier !== 'all' ? 'tier' : null,
        status !== 'all' ? 'status' : null,
        source !== 'all' ? 'source' : null,
      ].filter(Boolean);

      let total;
      if (activeFilters.length === 0) {
        total = stats.total;
      } else if (bundle.fromRow && activeFilters.length === 1) {
        const only = activeFilters[0];
        if (only === 'tier') total = stats.tiers?.[tier] || 0;
        else if (only === 'group') total = stats.groups?.[group_id]?.total || 0;
        else if (only === 'status') total = stats.statusCounts?.[status] ?? await countFiltered(svc, query);
        else total = await countFiltered(svc, query); // source: not stored per-count → cheap native count
      } else if (!bundle.fromRow && allLeads) {
        // Fallback path: derive from the scanned set we already have.
        total = allLeads.filter((l) => {
          if (group_id && !(l.group_ids || []).includes(group_id)) return false;
          if (tier !== 'all' && l.qualification_tier !== tier) return false;
          if (status !== 'all' && l.status !== status) return false;
          if (source !== 'all' && l.source !== source) return false;
          return true;
        }).length;
      } else {
        total = await countFiltered(svc, query);
      }

      const offset = (pageNum - 1) * page_size;
      const leads = await fetchPageWithRetry(svc, query, '-created_date', page_size, offset);

      return c.json({ data: { leads, total, stats } });
    }

    // ===== SLOW PATH: search / ungrouped =====
    // Search & "_ungrouped" can't be expressed as native queries, so we must
    // filter in memory. To avoid a full-table scan (429 storms), narrow the set
    // NATIVELY first using whatever real filters are active (group/tier/status/
    // source), then scan only that (usually small) subset.
    let scanSet = allLeads;
    if (!scanSet) {
      const baseQuery = { client_id };
      if (group_id && group_id !== '_ungrouped') baseQuery.group_ids = group_id;
      if (tier !== 'all') baseQuery.qualification_tier = tier;
      if (status !== 'all') baseQuery.status = status;
      if (source !== 'all') baseQuery.source = source;
      scanSet = await fetchAll(svc, baseQuery);
    }
    const filtered = scanSet.filter((l) => {
      if (group_id === '_ungrouped') {
        if ((l.group_ids || []).length > 0) return false;
      }
      if (tier !== 'all' && l.qualification_tier !== tier) return false;
      if (status !== 'all' && l.status !== status) return false;
      if (source !== 'all' && l.source !== source) return false;
      if (s) {
        const hit = norm(l.name).includes(s) || (l.phone || '').includes(search) || norm(l.company).includes(s);
        if (!hit) return false;
      }
      return true;
    });

    const total = filtered.length;
    const start = (pageNum - 1) * page_size;
    const leads = filtered.slice(start, start + page_size);

    return c.json({ data: { leads, total, stats } });
  } catch (error) {
    console.error('getLeadsPage error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};