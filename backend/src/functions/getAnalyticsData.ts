import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Server-side aggregation for the Client Analytics dashboard.
//
// Replaces the old client-side approach that pulled 500 calls + ALL leads
// (unpaginated, undercounting) + all campaigns into the browser and computed
// charts there. That was slow and the unbounded reads tripped 429s.
//
// Here we do bounded, retried full scans server-side, compute every chart's
// data once, and cache per (client, period) for 60s so re-selecting periods
// is instant.
//
// Payload: { client_id, period }   period: '7' | '30' | '90' | 'all'
// Returns: { kpis, dailyData, statusData, directionData, funnelData, hourlyData, campaignData }



const SCAN_PAGE = 500;
const TTL_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _cache = new Map(); // `${client_id}:${period}` -> { expiresAt, result }

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

async function fetchAll(svc, entity, query, limit = 200) {
  const all = [];
  for (let p = 0; p < limit; p++) {
    const batch = await withRetry(() =>
      svc.entities[entity].filter(query, '-created_date', SCAN_PAGE, p * SCAN_PAGE)
    );
    all.push(...batch);
    if (batch.length < SCAN_PAGE) break;
    await sleep(120);
  }
  return all;
}

export default async function getAnalyticsData(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id, period = '30' } = await c.req.json();
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    const cacheKey = `${client_id}:${period}`;
    const cached = _cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return c.json({ data: cached.result });
    }

    const svc = base44.asServiceRole;

    // ── FAST PATH: aggregate calls + leads in Postgres (single queries) ──
    // Campaign data stays on Base44 (small set). If Postgres errors for any
    // reason we fall through to the legacy full-scan path below.
    try {
      const [pgRes, campaigns] = await Promise.all([
        base44.functions.invoke('pgAnalytics', { client_id, period }),
        withRetry(() => svc.entities.Campaign.filter({ client_id })),
      ]);
      const pg = pgRes?.data;
      if (pg && pg.kpis) {
        const campaignData = campaigns.map((camp) => ({
          name: camp.name?.substring(0, 15) || 'Unnamed',
          completed: camp.calls_completed || 0,
          failed: camp.calls_failed || 0,
        }));
        const result = { ...pg, campaignData };
        _cache.set(cacheKey, { expiresAt: Date.now() + TTL_MS, result });
        return c.json({ data: result });
      }
    } catch (e) {
      console.warn('[getAnalyticsData] pg path failed, falling back to scan:', e.message);
    }

    // Date filter for calls
    let cutoff = null;
    if (period !== 'all') {
      cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - parseInt(period, 10));
    }

    const [allCalls, leads, campaigns] = await Promise.all([
      fetchAll(svc, 'CallLog', { client_id }),
      fetchAll(svc, 'Lead', { client_id }),
      withRetry(() => svc.entities.Campaign.filter({ client_id })),
    ]);

    const calls = cutoff
      ? allCalls.filter((c) => c.created_date && new Date(c.created_date) >= cutoff)
      : allCalls;

    // --- KPIs ---
    const totalCalls = calls.length;
    const completedCalls = calls.filter((c) => c.status === 'completed').length;
    const failedCalls = calls.filter((c) => c.status === 'failed' || c.status === 'no_answer').length;
    const avgDuration = completedCalls > 0
      ? Math.round(calls.filter((c) => c.duration).reduce((s, c) => s + c.duration, 0) / completedCalls)
      : 0;
    const connectRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0;

    // --- Calls per day ---
    const callsByDay = {};
    calls.forEach((c) => {
      const day = c.created_date?.split('T')[0];
      if (day) callsByDay[day] = (callsByDay[day] || 0) + 1;
    });
    const dailyData = Object.entries(callsByDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, calls: count }));

    // --- Call status breakdown ---
    const statusCounts = {};
    calls.forEach((c) => { statusCounts[c.status] = (statusCounts[c.status] || 0) + 1; });
    const statusData = Object.entries(statusCounts).map(([name, value]) => ({ name, value }));

    // --- Direction ---
    const outbound = calls.filter((c) => c.direction === 'outbound').length;
    const inbound = calls.filter((c) => c.direction === 'inbound').length;
    const directionData = [
      { name: 'Outbound', value: outbound, color: '#22c55e' },
      { name: 'Inbound', value: inbound, color: '#8b5cf6' },
    ].filter((d) => d.value > 0);

    // --- Lead funnel ---
    const leadStatusCounts = {};
    leads.forEach((l) => { leadStatusCounts[l.status] = (leadStatusCounts[l.status] || 0) + 1; });
    const funnelOrder = ['new', 'contacted', 'interested', 'callback', 'converted', 'not_interested', 'do_not_call'];
    const funnelData = funnelOrder
      .filter((s) => leadStatusCounts[s])
      .map((s) => ({ name: s.replace('_', ' '), value: leadStatusCounts[s] }));

    // --- Calls by hour ---
    const hourCounts = Array(24).fill(0);
    calls.forEach((c) => {
      if (c.call_start_time) hourCounts[new Date(c.call_start_time).getHours()]++;
    });
    const hourlyData = hourCounts
      .map((count, h) => ({ hour: `${h.toString().padStart(2, '0')}:00`, calls: count }))
      .filter((d) => d.calls > 0);

    // --- Campaigns ---
    const campaignData = campaigns.map((camp) => ({
      name: camp.name?.substring(0, 15) || 'Unnamed',
      completed: camp.calls_completed || 0,
      failed: camp.calls_failed || 0,
    }));

    const result = {
      kpis: { totalCalls, completedCalls, failedCalls, avgDuration, connectRate },
      dailyData,
      statusData,
      directionData,
      funnelData,
      hourlyData,
      campaignData,
    };

    _cache.set(cacheKey, { expiresAt: Date.now() + TTL_MS, result });
    return c.json({ data: result });
  } catch (error) {
    console.error('getAnalyticsData error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};