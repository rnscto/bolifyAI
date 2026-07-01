import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// One-time schema initializer for the Azure Postgres Flexible Server.
// Admin-only. Idempotent — safe to re-run (CREATE TABLE IF NOT EXISTS).
// Creates the Phase 1 did_concurrency table + indexes.
export default async function pgInitSchema(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const client = new Client({
      hostname: Deno.env.get('AZURE_PG_HOST'),
      port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
      database: Deno.env.get('AZURE_PG_DATABASE'),
      user: Deno.env.get('AZURE_PG_USER'),
      password: Deno.env.get('AZURE_PG_PASSWORD'),
      tls: { enabled: true, enforce: true },
      connection: { attempts: 1 },
    });

    const applied = [];
    try {
      ; /* client.connect() not needed */
      // schema v2: includes call_logs mirror

      await client.queryArray(`
        CREATE TABLE IF NOT EXISTS did_concurrency (
          did_number          TEXT PRIMARY KEY,
          client_id           TEXT,
          max_concurrent      INTEGER NOT NULL DEFAULT 1,
          active_count        INTEGER NOT NULL DEFAULT 0,
          last_increment_at   TIMESTAMPTZ,
          last_decrement_at   TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      applied.push('did_concurrency table');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_did_concurrency_client
        ON did_concurrency (client_id)
      `);
      applied.push('idx_did_concurrency_client');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_did_concurrency_stale
        ON did_concurrency (last_increment_at)
        WHERE active_count > 0
      `);
      applied.push('idx_did_concurrency_stale');

      // ── Phase 2: leads mirror table ──
      // Dual-write target for the Base44 Lead entity. Only the fields needed
      // to materialize ClientStats are stored. Keyed by the Base44 lead id.
      await client.queryArray(`
        CREATE TABLE IF NOT EXISTS leads (
          id                 TEXT PRIMARY KEY,
          client_id          TEXT NOT NULL,
          status             TEXT,
          qualification_tier TEXT,
          source             TEXT,
          group_ids          TEXT[] NOT NULL DEFAULT '{}',
          has_call           BOOLEAN NOT NULL DEFAULT false,
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      applied.push('leads table');

      // Additive: dedicated live AI score column on the leads mirror so the
      // ClientLeads Postgres overlay can read it directly (no summary parsing).
      await client.queryArray(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS score INTEGER`);
      applied.push('leads.score');
      await client.queryArray(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_call_date TIMESTAMPTZ`);
      applied.push('leads.last_call_date');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_leads_client ON leads (client_id)
      `);
      applied.push('idx_leads_client');

      // ── Phase 2 (CallLog hot path): call_logs mirror table ──
      // Operational fields only — NO transcript / agent_config_cache blobs
      // (those stay on Base44). Keyed by the Base44 CallLog id. Lets
      // aggregations (campaign completion, per-DID/agent counts) run as a
      // single SQL query instead of paginating Base44 CallLog reads.
      console.log('[pgInitSchema] reached call_logs block');
      await client.queryArray(`
        CREATE TABLE IF NOT EXISTS call_logs (
          id                TEXT PRIMARY KEY,
          client_id         TEXT NOT NULL,
          agent_id          TEXT,
          lead_id           TEXT,
          campaign_id       TEXT,
          call_sid          TEXT,
          caller_id         TEXT,
          callee_number     TEXT,
          direction         TEXT,
          status            TEXT,
          duration          INTEGER,
          provider          TEXT,
          country_code      TEXT,
          provider_cost     NUMERIC,
          provider_currency TEXT,
          post_processed    BOOLEAN NOT NULL DEFAULT false,
          call_start_time   TIMESTAMPTZ,
          call_end_time     TIMESTAMPTZ,
          created_date      TIMESTAMPTZ,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      applied.push('call_logs table');

      // Additive migration for pre-existing tables (no-op if already present).
      await client.queryArray(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS created_date TIMESTAMPTZ`);
      applied.push('call_logs.created_date');

      // Option A — zero-Base44 dial path: store the full agent config blob in
      // Postgres so streamGeminiOutgoing can resolve the call config WITHOUT any
      // Base44 read. campaignPoller inserts the CallLog (incl. this blob) into PG
      // directly; the Base44 mirror is async/best-effort and may lag under load.
      await client.queryArray(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS agent_config_cache JSONB`);
      applied.push('call_logs.agent_config_cache');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_call_logs_client ON call_logs (client_id)
      `);
      applied.push('idx_call_logs_client');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_call_logs_client_date ON call_logs (client_id, created_date)
      `);
      applied.push('idx_call_logs_client_date');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_call_logs_agent_status ON call_logs (agent_id, status)
      `);
      applied.push('idx_call_logs_agent_status');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_call_logs_callsid ON call_logs (call_sid)
      `);
      applied.push('idx_call_logs_callsid');

      // ── Phase 3: campaign_leads mirror table ──
      // Dual-write target for the Base44 CampaignLead entity. Mirrors only the
      // operational fields the poller/executor scan on (status, outcome,
      // followup_call_date, batch dial fields). Lets campaign completion checks
      // + next-batch selection run as single SQL queries instead of paginating
      // thousands of CampaignLead reads every poll cycle.
      await client.queryArray(`
        CREATE TABLE IF NOT EXISTS campaign_leads (
          id                 TEXT PRIMARY KEY,
          campaign_id        TEXT NOT NULL,
          client_id          TEXT,
          lead_id            TEXT,
          status             TEXT,
          outcome            TEXT,
          call_log_id        TEXT,
          attempt_count      INTEGER,
          lead_name          TEXT,
          lead_phone         TEXT,
          followup_call_date TIMESTAMPTZ,
          created_date       TIMESTAMPTZ,
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      applied.push('campaign_leads table');

      // ── CampaignLead PG-primary: display/result columns ──
      // CampaignLead is now PG-primary (source of record). The detail UI reads
      // these straight from PG, so the table must hold the full result set, not
      // just the operational fields. Additive — safe on existing installs.
      await client.queryArray(`ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS transcript TEXT`);
      applied.push('campaign_leads.transcript');
      await client.queryArray(`ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS conversation_summary TEXT`);
      applied.push('campaign_leads.conversation_summary');
      await client.queryArray(`ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call_duration INTEGER`);
      applied.push('campaign_leads.call_duration');
      await client.queryArray(`ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call_status TEXT`);
      applied.push('campaign_leads.call_status');
      await client.queryArray(`ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS followup_email_sent BOOLEAN`);
      applied.push('campaign_leads.followup_email_sent');
      await client.queryArray(`ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS followup_scheduled BOOLEAN`);
      applied.push('campaign_leads.followup_scheduled');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_status
        ON campaign_leads (campaign_id, status)
      `);
      applied.push('idx_campaign_leads_campaign_status');

      await client.queryArray(`
        CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_status_followup
        ON campaign_leads (campaign_id, status, followup_call_date)
      `);
      applied.push('idx_campaign_leads_campaign_status_followup');
    } finally {
      try { ; /* client.end() not needed */ } catch (_) {}
    }

    return c.json({ data: { ok: true, applied } });
  } catch (error) {
    console.error('[pgInitSchema] Error:', error.message);
    return c.json({ data: { ok: false, error: error.message } }, 500);
  }

};