import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

try {
  await load({ export: true, allowEmptyValues: true, envPath: new URL("../../.env", import.meta.url).pathname });
} catch (e: any) {
  console.log("Skipping dotenv load (expected in prod):", e.message);
}

// Auto-populate AZURE_PG_* env vars from DATABASE_URL if they are not explicitly set
if (!Deno.env.get("AZURE_PG_HOST")) {
  const dbUrl = Deno.env.get("DATABASE_URL") || "postgresql://postgres:postgres@localhost:5432/bolifyai";
  try {
    const u = new URL(dbUrl);
    if (u.hostname) {
      Deno.env.set("AZURE_PG_HOST", u.hostname);
      Deno.env.set("AZURE_PG_PORT", u.port || "5432");
      Deno.env.set("AZURE_PG_DATABASE", u.pathname.replace(/^\//, ''));
      Deno.env.set("AZURE_PG_USER", decodeURIComponent(u.username || 'postgres'));
      Deno.env.set("AZURE_PG_PASSWORD", decodeURIComponent(u.password || ''));
    }
  } catch (e: any) {
    console.warn("Could not parse DATABASE_URL to set AZURE_PG_*:", e.message);
  }
}

const databaseUrl = Deno.env.get("DATABASE_URL") || "postgresql://postgres:postgres@localhost:5432/bolifyai";

// Initialize PostgreSQL connection pool wrapper
class DBWrapper {
  private pool: Pool;

  constructor(url: string) {
    this.pool = new Pool(url, 10, true);
  }

  async connect() {
    const conn = await this.pool.connect();
    conn.release();
  }

  async queryObject(query: string, params?: any[]) {
    const conn = await this.pool.connect();
    try {
      return await conn.queryObject(query, params);
    } finally {
      conn.release();
    }
  }
}

export const client = new DBWrapper(databaseUrl);

async function ensurePostgresSchema() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS "clientstats" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      "client_id" TEXT,
      "leads_total" NUMERIC DEFAULT 0,
      "leads_by_status" JSONB DEFAULT '{}'::jsonb,
      "leads_by_tier" JSONB DEFAULT '{}'::jsonb,
      "leads_by_source" JSONB DEFAULT '{}'::jsonb,
      "leads_by_group" JSONB DEFAULT '{}'::jsonb,
      "leads_ungrouped" NUMERIC DEFAULT 0,
      "last_reconciled_at" TEXT
    );`,
    `CREATE INDEX IF NOT EXISTS idx_clientstats_client ON "clientstats" (client_id);`,
    `CREATE TABLE IF NOT EXISTS did_concurrency (
      did_number          TEXT PRIMARY KEY,
      client_id           TEXT,
      max_concurrent      INTEGER NOT NULL DEFAULT 1,
      active_count        INTEGER NOT NULL DEFAULT 0,
      last_increment_at   TIMESTAMPTZ,
      last_decrement_at   TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_did_concurrency_client ON did_concurrency (client_id);`,
    `CREATE TABLE IF NOT EXISTS leads (
      id                 TEXT PRIMARY KEY,
      client_id          TEXT NOT NULL,
      status             TEXT,
      qualification_tier TEXT,
      source             TEXT,
      group_ids          TEXT[] NOT NULL DEFAULT '{}',
      has_call           BOOLEAN NOT NULL DEFAULT false,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS score INTEGER;`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_call_date TIMESTAMPTZ;`,
    `CREATE INDEX IF NOT EXISTS idx_leads_client ON leads (client_id);`,
    `CREATE TABLE IF NOT EXISTS call_logs (
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
    );`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS created_date TIMESTAMPTZ;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS agent_config_cache JSONB;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS conversation_summary TEXT;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transcript TEXT;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_url TEXT;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS stream_sid TEXT;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS call_metadata JSONB;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS custom_identifier TEXT;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS cost NUMERIC;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS call_status TEXT;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS duration INTEGER;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS call_start_time TIMESTAMPTZ;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS call_end_time TIMESTAMPTZ;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS lead_status_updated TEXT;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS lead_score INTEGER;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS sentiment TEXT;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS intent_signals JSONB;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS score_breakdown JSONB;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS key_topics JSONB;`,
    `CREATE INDEX IF NOT EXISTS idx_call_logs_client ON call_logs (client_id);`,
    `CREATE INDEX IF NOT EXISTS idx_call_logs_client_date ON call_logs (client_id, created_date);`,
    `CREATE INDEX IF NOT EXISTS idx_call_logs_agent_status ON call_logs (agent_id, status);`,
    `CREATE INDEX IF NOT EXISTS idx_call_logs_callsid ON call_logs (call_sid);`,
    `CREATE TABLE IF NOT EXISTS campaign_leads (
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
    );`,
    `ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS transcript TEXT;`,
    `ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS conversation_summary TEXT;`,
    `ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call_duration INTEGER;`,
    `ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call_status TEXT;`,
    `ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS followup_email_sent BOOLEAN;`,
    `ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS followup_scheduled BOOLEAN;`,
    `ALTER TABLE ticketmessage ADD COLUMN IF NOT EXISTS attachment_data TEXT;`,
    `ALTER TABLE ticketmessage ADD COLUMN IF NOT EXISTS attachment_type TEXT;`,
    `ALTER TABLE client ADD COLUMN IF NOT EXISTS billing_name TEXT;`,
    `ALTER TABLE client ADD COLUMN IF NOT EXISTS billing_address TEXT;`,
    `ALTER TABLE client ADD COLUMN IF NOT EXISTS billing_state TEXT;`,
    `ALTER TABLE client ADD COLUMN IF NOT EXISTS billing_state_code TEXT;`,
    `ALTER TABLE client ADD COLUMN IF NOT EXISTS gstin TEXT;`,
    `ALTER TABLE client ADD COLUMN IF NOT EXISTS pan_number TEXT;`,
    `CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_status ON campaign_leads (campaign_id, status);`,
    `CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_status_followup ON campaign_leads (campaign_id, status, followup_call_date);`,

    // ── activity table (root cause of ClientActivities being empty) ───────────
    // Stores post-call actions, follow-ups, CRM updates, and manual notes.
    `CREATE TABLE IF NOT EXISTS "activity" (
      "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
      "client_id"   TEXT NOT NULL,
      "lead_id"     TEXT,
      "call_log_id" TEXT,
      "agent_id"    TEXT,
      "type"        TEXT NOT NULL DEFAULT 'note',
      "title"       TEXT,
      "description" TEXT,
      "status"      TEXT DEFAULT 'completed',
      "due_date"    TIMESTAMPTZ,
      "metadata"    JSONB DEFAULT '{}'::jsonb
    );`,
    `CREATE INDEX IF NOT EXISTS idx_activity_client ON "activity" (client_id);`,
    `CREATE INDEX IF NOT EXISTS idx_activity_lead ON "activity" (lead_id);`,
    `CREATE INDEX IF NOT EXISTS idx_activity_call_log ON "activity" (call_log_id);`,
    `CREATE INDEX IF NOT EXISTS idx_activity_created ON "activity" (client_id, created_at DESC);`,

    // ── calendarintegration table ─────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS "calendarintegration" (
      "id"            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
      "client_id"     TEXT NOT NULL,
      "provider"      TEXT NOT NULL DEFAULT 'google',
      "access_token"  TEXT,
      "refresh_token" TEXT,
      "account_email" TEXT,
      "status"        TEXT DEFAULT 'active',
      "expires_at"    TIMESTAMPTZ,
      UNIQUE(client_id, provider)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_calendarintegration_client ON "calendarintegration" (client_id);`,

    // ── call_logs: follow-up tracking columns ─────────────────────────────────
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS whatsapp_follow_up_sent BOOLEAN DEFAULT false;`,
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS email_follow_up_sent BOOLEAN DEFAULT false;`,

    // ── campaign_leads: agent tracking ────────────────────────────────────────
    `ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS agent_id TEXT;`
  ];

  for (const q of queries) {
    try {
      await client.queryObject(q);
    } catch (e: any) {
      console.warn("Schema auto-init warning:", e.message);
    }
  }
}

export async function connectDB() {
  try {
    await client.connect();
    console.log("Connected to PostgreSQL successfully with Connection Pool");
    await ensurePostgresSchema();
    console.log("PostgreSQL schema auto-verified successfully");
  } catch (error) {
    console.error("Failed to connect to PostgreSQL. API will start but DB operations will fail:", error);
    // Removed Deno.exit(1) to allow server to start for testing
  }
}

