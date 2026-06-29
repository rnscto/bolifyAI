import { base44ORM as base44 } from "../db/orm.ts";

export function initSubscriptionRenewals() {
  // Run every day at midnight (or whatever interval makes sense)
  // For simplicity, running every hour in this implementation to check for today's renewals
  setInterval(async () => {
    try {
      console.log("[Cron] Running Addon Subscription Renewals...");
      const now = new Date();
      
      const subscriptions = await base44.entities.ClientAddonSubscription.filter({
        status: "active"
      });

      for (const sub of subscriptions) {
        if (!sub.next_billing_date) continue;
        
        const nextBilling = new Date(sub.next_billing_date);
        // If the billing date is in the past or exactly today
        if (nextBilling <= now) {
          console.log(`[Cron] Processing renewal for subscription ${sub.id}`);
          
          const client = await base44.entities.Client.get(sub.client_id);
          if (!client) {
            console.warn(`[Cron] Client not found for subscription ${sub.id}`);
            continue;
          }

          const amount = sub.amount;

          if (client.wallet_balance >= amount) {
            // Deduct
            const newBalance = client.wallet_balance - amount;
            await base44.entities.Client.update(client.id, { wallet_balance: newBalance });

            // Calculate next date
            let newNextBilling = new Date(nextBilling);
            if (sub.billing_cycle === "monthly") {
              newNextBilling.setMonth(newNextBilling.getMonth() + 1);
            } else if (sub.billing_cycle === "quarterly") {
              newNextBilling.setMonth(newNextBilling.getMonth() + 3);
            } else if (sub.billing_cycle === "semi_annual") {
              newNextBilling.setMonth(newNextBilling.getMonth() + 6);
            } else if (sub.billing_cycle === "yearly") {
              newNextBilling.setFullYear(newNextBilling.getFullYear() + 1);
            } else if (sub.billing_cycle === "one_time") {
              newNextBilling.setFullYear(newNextBilling.getFullYear() + 100);
            }

            await base44.entities.ClientAddonSubscription.update(sub.id, {
              next_billing_date: newNextBilling.toISOString()
            });

            // Log usage
            const service = await base44.entities.MarketplaceService.get(sub.service_id);
            await base44.entities.UsageLog.create({
              client_id: client.id,
              type: "addon_renewal",
              description: `Marketplace Renewal: ${service?.name || "Unknown Service"} (${sub.billing_cycle})`,
              amount_inr: amount,
              timestamp: new Date().toISOString()
            });

            console.log(`[Cron] Successfully renewed subscription ${sub.id}`);
          } else {
            // Suspend due to insufficient balance
            await base44.entities.ClientAddonSubscription.update(sub.id, {
              status: "suspended"
            });
            console.log(`[Cron] Suspended subscription ${sub.id} due to insufficient balance`);
            
            // Note: In a real system we would dispatch an email/notification here
          }
        }
      }
    } catch (err: any) {
      console.error(`[Cron] Error in subscription renewals: ${err.message}`);
    }
  }, 3600000); // 1 hour
}
