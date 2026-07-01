import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// Connectivity + schema sanity check for the Azure Postgres Flexible Server.
// Admin-only. Uses the native Deno `deno-postgres` client (jsr:@db/postgres),
// which negotiates Azure's enforced TLS reliably (the npm `postgres` lib stalled
// its TLS handshake against Azure -> CONNECT_TIMEOUT even though raw TCP works).
export default async function pgHealthCheck(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const host = Deno.env.get('AZURE_PG_HOST');
    const database = Deno.env.get('AZURE_PG_DATABASE');
    const username = Deno.env.get('AZURE_PG_USER');
    const password = Deno.env.get('AZURE_PG_PASSWORD');
    const port = parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10);

    if (!host || !database || !username || !password) {
      return c.json({ data: { ok: false, error: 'Missing one or more AZURE_PG_* secrets' } }, 500);
    }

    const client = new Client({
      hostname: host,
      port,
      database,
      user: username,
      password,
      tls: { enabled: true, enforce: true },
      connection: { attempts: 1 },
    });

    let body = {};
    try { body = await c.req.json(); } catch (_) {}
    const initCallLogs = body?.init_call_logs === true;

    const startedAt = Date.now();
    const result = { fn_version: 'v2-call-logs' };

    try {
      ; /* client.connect() not needed */
      result.connected = true;
      result.round_trip_ms = Date.now() - startedAt;

      const ping = await client.queryObject`SELECT version() AS pg_version, now() AS server_time`;
      result.pg_version = ping.rows[0]?.pg_version;
      result.server_time = ping.rows[0]?.server_time;

      // Optional: provision the call_logs mirror table + indexes (idempotent).
      if (initCallLogs) {
        const applied = [];
        await client.queryArray(`
          CREATE TABLE IF NOT EXISTS call_logs (
            id TEXT PRIMARY KEY, client_id TEXT NOT NULL, agent_id TEXT, lead_id TEXT,
            campaign_id TEXT, call_sid TEXT, caller_id TEXT, callee_number TEXT,
            direction TEXT, status TEXT, duration INTEGER, provider TEXT, country_code TEXT,
            provider_cost NUMERIC, provider_currency TEXT,
            post_processed BOOLEAN NOT NULL DEFAULT false,
            call_start_time TIMESTAMPTZ, call_end_time TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        applied.push('call_logs table');
        // Ensure stream_sid exists — older DBs lack it, which breaks the
        // container's phone-match fallback (column "stream_sid" does not exist).
        await client.queryArray(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS stream_sid TEXT`);
        applied.push('call_logs.stream_sid column');
        await client.queryArray(`CREATE INDEX IF NOT EXISTS idx_call_logs_client ON call_logs (client_id)`);
        applied.push('idx_call_logs_client');
        await client.queryArray(`CREATE INDEX IF NOT EXISTS idx_call_logs_agent_status ON call_logs (agent_id, status)`);
        applied.push('idx_call_logs_agent_status');
        await client.queryArray(`CREATE INDEX IF NOT EXISTS idx_call_logs_callsid ON call_logs (call_sid)`);
        applied.push('idx_call_logs_callsid');
        result.call_logs_applied = applied;
      }

      // Temp backfill helper: reconcile stuck PG-only completed calls for a
      // client straight onto the Base44 Lead (status + score + summary +
      // sentiment/tier). No orchestrator side-effects (no emails/WhatsApp/
      // recording fetch) — pure data reconciliation. Returns the finalized
      // per-call data so the caller can write the Leads.
      if (body?.reconcile_stuck_for_client) {
        const cid = body.reconcile_stuck_for_client;
        const sinceIso = body.since || '2026-06-20T00:00:00Z';
        const rows = await client.queryObject`
          SELECT id, lead_id, lead_status_updated, duration,
                 conversation_summary, created_date
          FROM call_logs
          WHERE client_id = ${cid}
            AND direction = 'outbound'
            AND status = 'completed'
            AND created_date >= ${sinceIso}::timestamptz
            AND conversation_summary IS NOT NULL AND conversation_summary <> ''
            AND lead_status_updated IS NOT NULL AND lead_status_updated <> ''
            AND lead_id IS NOT NULL
          ORDER BY created_date DESC
          LIMIT 1000`;
        result.reconcile_calls = rows.rows;
      }

      const tbl = await client.queryObject`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'did_concurrency'
        ) AS exists
      `;
      result.did_concurrency_table_exists = tbl.rows[0]?.exists === true;

      if (result.did_concurrency_table_exists) {
        const cnt = await client.queryObject`SELECT count(*)::int AS n FROM did_concurrency`;
        result.did_concurrency_row_count = cnt.rows[0]?.n ?? 0;
      }

      const clTbl = await client.queryObject`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'call_logs'
        ) AS exists
      `;
      result.call_logs_table_exists = clTbl.rows[0]?.exists === true;
      if (result.call_logs_table_exists) {
        const clCnt = await client.queryObject`SELECT count(*)::int AS n FROM call_logs`;
        result.call_logs_row_count = clCnt.rows[0]?.n ?? 0;
      }

      const leadsTbl = await client.queryObject`
        SELECT EXISTS (
          SELECT FROM information_schema.tables WHERE table_name = 'leads'
        ) AS exists
      `;
      result.leads_table_exists = leadsTbl.rows[0]?.exists === true;
      if (result.leads_table_exists) {
        const lCnt = await client.queryObject`SELECT count(*)::int AS n FROM leads`;
        result.leads_row_count = lCnt.rows[0]?.n ?? 0;
        // Per-client probe so we can verify a specific client's backfill depth.
        if (body?.probe_client_id) {
          const pc = await client.queryObject`
            SELECT count(*)::int AS n FROM leads WHERE client_id = ${body.probe_client_id}
          `;
          result.probe_client_leads = pc.rows[0]?.n ?? 0;
        }
      }
    } finally {
      try { ; /* client.end() not needed */ } catch (_) {}
    }

    return c.json({ data: { ok: true, ...result } });
  } catch (error) {
    console.error('[pgHealthCheck] Error:', error.message);
    return c.json({ data: { ok: false, error: error.message } }, 500);
  }

};