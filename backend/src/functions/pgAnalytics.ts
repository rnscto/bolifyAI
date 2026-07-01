import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgAnalytics — Postgres-backed aggregation for the Client Analytics
// dashboard. Replaces the old approach in getAnalyticsData that pulled
// EVERY CallLog + EVERY Lead into memory and aggregated in JS (the biggest
// source of 429 rate-limit storms in the app).
//
// Everything here is computed with single GROUP BY queries against the
// call_logs + leads mirror tables, so a client with 50k calls costs one
// round-trip instead of hundreds of paginated Base44 reads.
//
// Payload: { client_id, period }   period: '7' | '30' | '90' | 'all'
// Returns: { kpis, dailyData, statusData, directionData, funnelData, hourlyData }
//   (campaignData is added by the caller from the Campaign entity — small,
//    stays on Base44.)
// ═══════════════════════════════════════════════════════════════════════

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

const FUNNEL_ORDER = ['new', 'contacted', 'interested', 'callback', 'converted', 'not_interested', 'do_not_call'];

export default async function pgAnalytics(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id, period = '30' } = await c.req.json();
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    // Cutoff for the period filter (null = all-time).
    let cutoff = null;
    if (period !== 'all') {
      cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - parseInt(period, 10));
    }
    const cutoffIso = cutoff ? cutoff.toISOString() : null;

    const pg = pgClient();
    try {
      ; /* pg.connect() not needed */

      // ── KPIs (single row) ──
      const kpiRes = await pg.queryObject`
        SELECT
          COUNT(*)::int AS total_calls,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_calls,
          COUNT(*) FILTER (WHERE status IN ('failed','no_answer'))::int AS failed_calls,
          COALESCE(SUM(duration) FILTER (WHERE status = 'completed'), 0)::int AS total_duration,
          COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
          COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound
        FROM call_logs
        WHERE client_id = ${client_id}
          AND (${cutoffIso}::timestamptz IS NULL OR created_date >= ${cutoffIso}::timestamptz)
      `;
      const k = kpiRes.rows[0] || {};
      const totalCalls = k.total_calls || 0;
      const completedCalls = k.completed_calls || 0;
      const failedCalls = k.failed_calls || 0;
      const avgDuration = completedCalls > 0 ? Math.round((k.total_duration || 0) / completedCalls) : 0;
      const connectRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0;

      // ── Calls per day ──
      const dayRes = await pg.queryObject`
        SELECT to_char(created_date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS calls
        FROM call_logs
        WHERE client_id = ${client_id}
          AND created_date IS NOT NULL
          AND (${cutoffIso}::timestamptz IS NULL OR created_date >= ${cutoffIso}::timestamptz)
        GROUP BY 1 ORDER BY 1
      `;
      const dailyData = dayRes.rows.map((r) => ({ date: r.date, calls: r.calls }));

      // ── Status breakdown ──
      const statusRes = await pg.queryObject`
        SELECT COALESCE(status, 'unknown') AS name, COUNT(*)::int AS value
        FROM call_logs
        WHERE client_id = ${client_id}
          AND (${cutoffIso}::timestamptz IS NULL OR created_date >= ${cutoffIso}::timestamptz)
        GROUP BY 1
      `;
      const statusData = statusRes.rows.map((r) => ({ name: r.name, value: r.value }));

      // ── Direction (from KPI row) ──
      const directionData = [
        { name: 'Outbound', value: k.outbound || 0, color: '#22c55e' },
        { name: 'Inbound', value: k.inbound || 0, color: '#8b5cf6' },
      ].filter((d) => d.value > 0);

      // ── Calls by hour (uses call_start_time; only answered calls have it) ──
      const hourRes = await pg.queryObject`
        SELECT EXTRACT(HOUR FROM call_start_time)::int AS hour, COUNT(*)::int AS calls
        FROM call_logs
        WHERE client_id = ${client_id}
          AND call_start_time IS NOT NULL
          AND (${cutoffIso}::timestamptz IS NULL OR created_date >= ${cutoffIso}::timestamptz)
        GROUP BY 1 ORDER BY 1
      `;
      const hourlyData = hourRes.rows.map((r) => ({
        hour: `${String(r.hour).padStart(2, '0')}:00`,
        calls: r.calls,
      }));

      // ── Lead funnel (all-time — leads mirror has no created_date filter) ──
      const leadRes = await pg.queryObject`
        SELECT COALESCE(status, 'new') AS status, COUNT(*)::int AS value
        FROM leads
        WHERE client_id = ${client_id}
        GROUP BY 1
      `;
      const leadCounts = {};
      for (const r of leadRes.rows) leadCounts[r.status] = r.value;
      const funnelData = FUNNEL_ORDER
        .filter((s) => leadCounts[s])
        .map((s) => ({ name: s.replace('_', ' '), value: leadCounts[s] }));

      return c.json({ data: {
        kpis: { totalCalls, completedCalls, failedCalls, avgDuration, connectRate },
        dailyData,
        statusData,
        directionData,
        funnelData,
        hourlyData,
      } });
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    console.error('[pgAnalytics] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};