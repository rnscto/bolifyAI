import { client } from "../db/index.ts";

export function initCampaignPoller() {
  // Run every 5 minutes
  Deno.cron("Campaign Poller", "*/5 * * * *", async () => {
     await processPendingLeads();
  });
}

export async function processPendingLeads() {
    console.log("[CRON] Running Campaign Poller...");

    // Basic TRAI compliance check (9am to 9pm IST)
    const currentHour = new Date().getUTCHours() + 5.5; // Quick IST conversion
    const hourInIST = currentHour >= 24 ? currentHour - 24 : currentHour;
    
    // FOR TESTING, WE WILL COMMENT OUT THE TIME CHECK OR BYPASS IT
    // if (hourInIST < 9 || hourInIST >= 21) {
    //    console.log("[CRON] Outside of allowed calling window (9am-9pm). Skipping batch.");
    //    return;
    // }

    try {
      // Find active campaigns that have pending leads
      // Using a basic locking mechanism in Postgres (FOR UPDATE SKIP LOCKED) is ideal for scaled workers
      const pendingBatches = await client.queryObject(`
        SELECT cl.id as campaignlead_id, cl.lead_id, c.id as campaign_id, l.phone as phone_number,
               a.assigned_did, a.smartflo_api_token, a.id as agent_id
        FROM "campaignlead" cl
        INNER JOIN "campaign" c ON cl.campaign_id = c.id::text
        INNER JOIN "lead" l ON cl.lead_id = l.id::text
        INNER JOIN "agent" a ON c.agent_id = a.id::text
        WHERE c.status = 'active' AND cl.status = 'pending'
        LIMIT 50
      `);

      const leadsToCall = pendingBatches.rows as any[];
      if (leadsToCall.length === 0) {
        return;
      }

      console.log(`[CRON] Found ${leadsToCall.length} pending leads across active campaigns. Initiating calls...`);

      // Update to processing
      const leadIds = leadsToCall.map(l => l.campaignlead_id);
      await client.queryObject(
        `UPDATE "campaignlead" SET status = 'processing' WHERE id = ANY($1)`,
        [leadIds]
      );

      // Trigger calls via Smartflo API...
      for (const lead of leadsToCall) {
        try {
          const SMARTFLO_API_KEY = lead.smartflo_api_token || Deno.env.get("SMARTFLO_API_KEY");
          
          if (!SMARTFLO_API_KEY) {
             console.warn(`[CRON] No Smartflo API token for agent ${lead.agent_id} or globally. Skipping lead ${lead.campaignlead_id}.`);
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
             headers: {
               "Content-Type": "application/json"
             },
             body: JSON.stringify(payload)
          });
          
          const text = await res.text();
          console.log(`[CRON] Smartflo trigger for ${lead.phone_number}:`, res.status, text);
          
        } catch (err) {
          console.error("[CRON] Failed to trigger Smartflo call for lead", lead.campaignlead_id, err);
        }
      }

    } catch (error) {
      console.error("[CRON] Error in Campaign Poller:", error);
    }
}
