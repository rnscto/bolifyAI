import postgres from 'https://deno.land/x/postgresjs@v3.4.4/mod.js';

const sourceUrl = Deno.env.get('SOURCE_DATABASE_URL');
const targetUrl = Deno.env.get('DATABASE_URL') || 'postgres://postgres:postgres@localhost:5432/bolifyai';

if (!sourceUrl) {
  console.error("ERROR: Please set SOURCE_DATABASE_URL environment variable.");
  console.error("Example: SOURCE_DATABASE_URL='postgres://user:pass@old-host/db' deno run -A backend/scripts/migrateData.ts");
  Deno.exit(1);
}

const sourceSql = postgres(sourceUrl);
const targetSql = postgres(targetUrl);

// List of tables mapping from PascalCase/Base44 names to snake_case schema tables
// Add or remove tables as necessary
const TABLE_MAP: Record<string, string> = {
  Client: 'clients',
  Payment: 'payments',
  PaymentApprovalRequest: 'payment_approval_requests',
  Subscription: 'subscriptions',
  UsageLog: 'usage_logs',
  MarketplaceIntegration: 'marketplace_integrations',
  Activity: 'activities',
  DID: 'dids',
  VoiceLog: 'voice_logs',
  EmailLog: 'email_logs',
  SmsLog: 'sms_logs',
  Contact: 'contacts',
  Template: 'templates',
  ClientConfig: 'client_configs',
  KnowledgeBase: 'knowledge_base',
  Lead: 'leads',
  Campaign: 'campaigns',
  Agent: 'agents',
  Webhook: 'webhooks',
  CallLog: 'call_logs',
  ClientLifecycleEvent: 'client_lifecycle_events',
  CRMConfig: 'crm_configs',
  Deal: 'deals',
  CampaignLead: 'campaign_leads'
};

async function runMigration() {
  console.log(`[Migration] Starting data sync from ${sourceUrl.split('@')[1]} to ${targetUrl.split('@')[1]}`);

  try {
    for (const [oldTable, newTable] of Object.entries(TABLE_MAP)) {
      console.log(`\n--- Migrating ${oldTable} -> ${newTable} ---`);
      
      // 1. Fetch from Source
      let rows;
      try {
        // Try PascalCase first
        rows = await sourceSql`SELECT * FROM ${sourceSql(oldTable)}`;
      } catch (e: any) {
        if (e.message.includes('does not exist') || e.message.includes('relation')) {
          try {
            // Fallback to snake_case in old DB as well if they were already snake case
            rows = await sourceSql`SELECT * FROM ${sourceSql(newTable)}`;
          } catch (err: any) {
             console.warn(`[Skip] Table ${oldTable} / ${newTable} does not exist in source database.`);
             continue;
          }
        } else {
          console.error(`[Error] Failed reading ${oldTable}:`, e);
          continue;
        }
      }

      if (!rows || rows.length === 0) {
        console.log(`[Skip] ${oldTable} is empty.`);
        continue;
      }

      console.log(`Fetched ${rows.length} records for ${oldTable}. Inserting into ${newTable}...`);

      // 2. Insert into Target
      let inserted = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          // If inserting with specific IDs, we can just do a straightforward insert, handling conflicts on ID
          // assuming all tables have an 'id' primary key. If not, this might need tuning.
          await targetSql`
            INSERT INTO ${targetSql(newTable)} ${targetSql(row)}
            ON CONFLICT (id) DO UPDATE SET ${targetSql(row)}
          `;
          inserted++;
        } catch (e: any) {
          failed++;
          if (failed === 1) { // Only log the first error fully to avoid spam
            console.error(`[Error] Insert failed for row in ${newTable}:`, e.message);
          }
        }
      }
      
      console.log(`[Done] ${newTable}: Inserted/Updated = ${inserted}, Failed = ${failed}`);
    }

  } catch (err) {
    console.error("[Fatal Error] Migration halted:", err);
  } finally {
    await sourceSql.end();
    await targetSql.end();
    console.log("\n[Migration] Finished script.");
  }
}

runMigration();
