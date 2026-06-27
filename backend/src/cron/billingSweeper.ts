import { client } from "../db/index.ts";
import { sendEmail } from "../integrations/email.ts";

export function initBillingSweeper() {
  Deno.cron("Billing Sweeper", "0 0 * * *", async () => {
    console.log("[cron/billingSweeper] Running daily billing & suspension sweep...");
    
    try {
      // 1. Expire trials (fixed: updated_at, trial_end_date::date)
      const trialRes = await (client as any).queryObject(`
        UPDATE "client" 
        SET account_status = 'expired', updated_at = NOW()
        WHERE account_status = 'trial' AND trial_end_date IS NOT NULL AND trial_end_date::date < CURRENT_DATE
        RETURNING id, company_name, email
      `);
      if (trialRes.rows.length > 0) {
        console.log(`[cron/billingSweeper] ${trialRes.rows.length} trial clients expired.`);
        for (const c of trialRes.rows as any[]) {
          if (c.email) {
            await sendEmail(
              c.email,
              "Your BolifyAI Trial Has Expired",
              `Hi ${c.company_name},\n\nYour BolifyAI free trial has ended and your account has been suspended.\n\nPlease log in at https://app.bolifyai.com to upgrade your plan and restore service.\n\nThank you,\nBolifyAI Team`
            ).catch(() => {});
          }
        }
      }

      // 2. Suspend clients with pending subscriptions (fixed: updated_at)
      const pendingSubRes = await (client as any).queryObject(`
        UPDATE "subscription" 
        SET status = 'overdue', payment_status = 'failed', updated_at = NOW()
        WHERE status = 'pending'
        RETURNING id, client_id
      `);
      
      for (const sub of pendingSubRes.rows as any[]) {
        const suspendRes = await (client as any).queryObject(`
          UPDATE "client" 
          SET account_status = 'suspended', updated_at = NOW()
          WHERE id = $1 AND account_status NOT IN ('suspended', 'cancelled')
          RETURNING id, company_name, email
        `, [sub.client_id]);
        if (suspendRes.rows.length > 0) {
          const c = suspendRes.rows[0] as any;
          console.log(`[cron/billingSweeper] Client ${c.company_name} suspended — pending sub ${sub.id}.`);
          if (c.email) {
            await sendEmail(c.email, "BolifyAI Account Suspended - Payment Pending",
              `Hi ${c.company_name},\n\nYour account has been suspended due to a pending/failed payment. Please renew at https://app.bolifyai.com\n\nBolifyAI Team`
            ).catch(() => {});
          }
        }
      }

      // 3. Suspend clients with expired active subscriptions (fixed: updated_at, billing_end_date::date)
      const activeSubsRes = await (client as any).queryObject(`
        SELECT id, client_id, billing_end_date 
        FROM "subscription" 
        WHERE status = 'active' AND billing_end_date IS NOT NULL AND billing_end_date::date < CURRENT_DATE
      `);

      for (const sub of activeSubsRes.rows as any[]) {
        const newerActiveRes = await (client as any).queryObject(`
          SELECT id FROM "subscription" 
          WHERE client_id = $1 AND id != $2 AND status = 'active' AND billing_end_date::date >= CURRENT_DATE
        `, [sub.client_id, sub.id]);

        if (newerActiveRes.rows.length > 0) continue;

        await (client as any).queryObject(
          `UPDATE "subscription" SET status = 'overdue', updated_at = NOW() WHERE id = $1`, [sub.id]
        );
        
        const suspendRes = await (client as any).queryObject(`
          UPDATE "client" 
          SET account_status = 'suspended', updated_at = NOW()
          WHERE id = $1 AND account_status NOT IN ('suspended', 'cancelled')
          RETURNING id, company_name, email
        `, [sub.client_id]);
        
        if (suspendRes.rows.length > 0) {
          const c = suspendRes.rows[0] as any;
          console.log(`[cron/billingSweeper] Client ${c.company_name} suspended — expired sub ${sub.id}.`);
          if (c.email) {
            await sendEmail(c.email, "BolifyAI Subscription Expired",
              `Hi ${c.company_name},\n\nYour BolifyAI subscription has expired and your account is suspended. Renew at https://app.bolifyai.com\n\nBolifyAI Team`
            ).catch(() => {});
          }
        }
      }

      console.log("[cron/billingSweeper] Sweep complete.");
    } catch (err) {
      console.error("[cron/billingSweeper] Error:", err);
    }
  });
}

