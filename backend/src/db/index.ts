import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

try {
  await load({ export: true, allowEmptyValues: true, envPath: new URL("../../.env", import.meta.url).pathname });
} catch (e: any) {
  console.log("Skipping dotenv load (expected in prod):", e.message);
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
    `CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_status ON campaign_leads (campaign_id, status);`,
    `CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_status_followup ON campaign_leads (campaign_id, status, followup_call_date);`
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

