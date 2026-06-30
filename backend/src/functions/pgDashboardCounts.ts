import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgDashboardCounts — fast call counts for the Client main Dashboard.
// Replaces the paginated countAll(CallLog) scan in getClientDashboardStats
// with two cheap SQL counts against the call_logs mirror.
//
// Payload: { client_id }
// Returns: { totalCalls, callsToday }
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

export default async function pgDashboardCounts(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id } = await c.req.json();
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const pg = pgClient();
    try {
      ; /* pg.connect() not needed */
      const res = await pg.queryObject`
        SELECT
          COUNT(*)::int AS total_calls,
          COUNT(*) FILTER (WHERE created_date >= ${todayIso}::timestamptz)::int AS calls_today
        FROM call_logs
        WHERE client_id::text = ${client_id}
      `;
      const r = res.rows[0] || {};
      return c.json({ data: {
        totalCalls: r.total_calls || 0,
        callsToday: r.calls_today || 0,
      } });
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    console.error('[pgDashboardCounts] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};