import { client } from "../db/index.ts";
import { sendEmail } from "../integrations/email.ts";

export function initTrialExpiryCheck() {
  Deno.cron("Check Trial Expiries", "0 0 * * *", async () => {
    console.log("[CRON] Running daily trial expiry check...");
    
    try {
      const result = await client.queryObject(
        `UPDATE "client"
         SET subscription_status = 'suspended'
         WHERE subscription_status = 'trial'
           AND trial_ends_at < NOW()
         RETURNING id, name, company_name, email`
      );

      const suspendedClients = result.rows as any[];
      if (suspendedClients.length > 0) {
        console.log(`[CRON] Suspended ${suspendedClients.length} clients whose trials expired.`);
        
        for (const c of suspendedClients) {
          if (c.email) {
            await sendEmail(
              c.email,
              "Your BolifyAI Trial has Expired",
              `Hi ${c.name || c.company_name},\n\nYour BolifyAI trial for ${c.company_name} has expired and your account has been suspended. Please log in to upgrade your plan and restore service.`
            );
          }
        }
      } else {
        console.log("[CRON] No trials expired today.");
      }
    } catch (error) {
      console.error("[CRON] Error during trial expiry check:", error);
    }
  });
}
