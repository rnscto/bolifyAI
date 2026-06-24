import "https://deno.land/std@0.210.0/dotenv/load.ts";
import { client } from "../src/db/index.ts";
import { processPendingLeads } from "../src/cron/campaignPoller.ts";

async function main() {
  console.log("Connecting to DB...");
  try {
    // Check if client is already connected or try connecting. It might auto connect but just in case.
    // The db/index.ts client is a pool, so queries will auto connect.
    
    console.log("Creating Test Agent...");
    const agentRes = await client.queryObject(`
      INSERT INTO "agent" (id, name, created_at, updated_at, greeting_message, system_prompt, assigned_did, smartflo_api_token)
      VALUES (gen_random_uuid(), 'Test Agent', NOW(), NOW(), 'Hello, this is a test', 'Test prompt', '918064520005', $1)
      RETURNING id
    `, [Deno.env.get("SMARTFLO_API_KEY")]);
    const agentId = (agentRes.rows[0] as any).id;

    console.log("Creating Test Lead...");
    const leadRes = await client.queryObject(`
      INSERT INTO "lead" (id, name, phone, created_at, updated_at)
      VALUES (gen_random_uuid(), 'Test Lead', '7020609101', NOW(), NOW())
      RETURNING id
    `);
    const leadId = (leadRes.rows[0] as any).id;

    console.log("Creating Test Campaign...");
    const campRes = await client.queryObject(`
      INSERT INTO "campaign" (id, name, created_at, updated_at, agent_id, status)
      VALUES (gen_random_uuid(), 'Test Campaign', NOW(), NOW(), $1, 'active')
      RETURNING id
    `, [agentId]);
    const campId = (campRes.rows[0] as any).id;

    console.log("Creating CampaignLead (Pending)...");
    await client.queryObject(`
      INSERT INTO "campaignlead" (id, campaign_id, lead_id, status, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'pending', NOW(), NOW())
    `, [campId, leadId]);

    console.log("Data inserted. Triggering campaignPoller logic...");
    
    await processPendingLeads();
    
    console.log("Done.");

  } catch (e) {
    console.error("Error setting up test data", e);
  } finally {
    Deno.exit(0);
  }
}

main();
