import { client } from "../db/index.ts";

export function initCampaignPoller() {
  // Run every 1 minute
  Deno.cron("Campaign Poller", "*/1 * * * *", async () => {
     await processPendingLeads();
  });
}

export async function processPendingLeads() {
    console.log("[CRON] Running Campaign Poller...");

    try {
      // 1. Get all active campaigns and their max_concurrent_calls
      const campaignsRes = await client.queryObject(`
        SELECT id, COALESCE(max_concurrent_calls, 10) as max_concurrent_calls 
        FROM "campaign" 
        WHERE status = 'active'
      `);
      const activeCampaigns = campaignsRes.rows as any[];

      if (activeCampaigns.length === 0) return;

      for (const campaign of activeCampaigns) {
        const campaignId = campaign.id;
        const maxConcurrent = parseInt(campaign.max_concurrent_calls) || 10;

        // 2. Find how many are currently processing for this campaign
        const processingRes = await client.queryObject(`
          SELECT COUNT(*) as count 
          FROM "campaignlead" 
          WHERE campaign_id = $1 AND status = 'processing'
        `, [campaignId]);
        const processingCount = parseInt((processingRes.rows[0] as any).count);

        const availableSlots = maxConcurrent - processingCount;

        if (availableSlots <= 0) {
          continue;
        }

        // 3. Fetch up to 'availableSlots' leads, locking them so no other worker grabs them
        const pendingBatches = await client.queryObject(`
          SELECT cl.id as campaignlead_id, cl.lead_id, l.phone as phone_number,
                 a.assigned_did, a.smartflo_api_token, a.id as agent_id
          FROM "campaignlead" cl
          INNER JOIN "lead" l ON cl.lead_id = l.id::text
          INNER JOIN "campaign" c ON cl.campaign_id = c.id::text
          INNER JOIN "agent" a ON c.agent_id = a.id::text
          WHERE cl.campaign_id = $1 AND cl.status = 'pending'
          FOR UPDATE OF cl SKIP LOCKED
          LIMIT $2
        `, [campaignId, availableSlots]);

        const leadsToCall = pendingBatches.rows as any[];
        
        if (leadsToCall.length === 0) continue;

        console.log(`[CRON] Campaign ${campaignId}: Dispatching ${leadsToCall.length} leads... (Max: ${maxConcurrent})`);

        // 4. Update status to 'processing'
        const leadIds = leadsToCall.map(l => l.campaignlead_id);
        await client.queryObject(
          `UPDATE "campaignlead" SET status = 'processing' WHERE id = ANY($1)`,
          [leadIds]
        );

        // 5. Fire external requests
        for (const lead of leadsToCall) {
          try {
            const SMARTFLO_API_KEY = lead.smartflo_api_token || Deno.env.get("SMARTFLO_API_KEY");
            if (!SMARTFLO_API_KEY) {
               console.warn(`[CRON] No Smartflo API token. Skipping lead ${lead.campaignlead_id}.`);
               continue;
            }

            let cleanCallerID = lead.assigned_did ? lead.assigned_did.replace(/[^0-9]/g, '') : "918064520005";
            if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;
            
            let cleanPhoneNumber = lead.phone_number.replace(/[^0-9]/g, '');
            if (cleanPhoneNumber.length === 10) cleanPhoneNumber = '91' + cleanPhoneNumber;

            const payload = {
              api_key: SMARTFLO_API_KEY,
              customer_number: cleanPhoneNumber,
              caller_id: cleanCallerID,
              custom_identifier: lead.campaignlead_id,
              async: 1
            };
               
            const res = await fetch("https://api-smartflo.tatateleservices.com/v1/click_to_call_support", {
               method: "POST",
               headers: { "Content-Type": "application/json" },
               body: JSON.stringify(payload)
            });
            const text = await res.text();
            if (!res.ok) {
              throw new Error(`Smartflo HTTP Error: ${res.status} ${text}`);
            }
            console.log(`[CRON] Smartflo trigger for ${lead.phone_number}:`, res.status, text);
          } catch (err) {
            console.error("[CRON] Failed to trigger Smartflo call for lead", lead.campaignlead_id, err);
            await client.queryObject(
              `UPDATE "campaignlead" SET status = 'failed', outcome = 'not_answered', call_status = 'failed' WHERE id = $1`,
              [lead.campaignlead_id]
            );
          }
        }
      }
    } catch (error) {
      console.error("[CRON] Error in Campaign Poller:", error);
    }
}
