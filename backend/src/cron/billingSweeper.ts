import { client } from "../db/index.ts";

export function initBillingSweeper() {
  Deno.cron("Billing Sweeper", "0 0 * * *", async () => {
    console.log("[cron/billingSweeper] Running daily billing & suspension sweep...");
    
    try {
      const trialRes = await (client as any).queryObject(`
        UPDATE client 
        SET account_status = 'expired', updated_date = NOW()
        WHERE account_status = 'trial' AND trial_end_date IS NOT NULL AND trial_end_date < NOW()
        RETURNING id
      `);
      if (trialRes.rows.length > 0) {
        console.log(`[cron/billingSweeper] ${trialRes.rows.length} trial clients expired.`);
      }

      const pendingSubRes = await (client as any).queryObject(`
        UPDATE subscription 
        SET status = 'overdue', payment_status = 'failed', updated_date = NOW()
        WHERE status = 'pending'
        RETURNING id, client_id
      `);
      
      for (const sub of pendingSubRes.rows) {
        const suspendRes = await (client as any).queryObject(`
          UPDATE client 
          SET account_status = 'suspended', updated_date = NOW()
          WHERE id = $1 AND account_status NOT IN ('suspended', 'cancelled')
          RETURNING id
        `, [sub.client_id]);
        if (suspendRes.rows.length > 0) {
          console.log(`[cron/billingSweeper] Client ${sub.client_id} suspended due to pending subscription ${sub.id}.`);
        }
      }

      const activeSubsRes = await (client as any).queryObject(`
        SELECT id, client_id, billing_end_date 
        FROM subscription 
        WHERE status = 'active' AND billing_end_date IS NOT NULL AND billing_end_date < NOW()
      `);

      for (const sub of activeSubsRes.rows) {
        const newerActiveRes = await (client as any).queryObject(`
          SELECT id FROM subscription 
          WHERE client_id = $1 AND id != $2 AND status = 'active' AND billing_end_date > NOW()
        `, [sub.client_id, sub.id]);

        if (newerActiveRes.rows.length > 0) continue;

        await (client as any).queryObject(`UPDATE subscription SET status = 'overdue', updated_date = NOW() WHERE id = $1`, [sub.id]);
        
        const suspendRes = await (client as any).queryObject(`
          UPDATE client 
          SET account_status = 'suspended', updated_date = NOW()
          WHERE id = $1 AND account_status NOT IN ('suspended', 'cancelled')
          RETURNING id
        `, [sub.client_id]);
        
        if (suspendRes.rows.length > 0) {
          console.log(`[cron/billingSweeper] Client ${sub.client_id} suspended due to expired active subscription ${sub.id}.`);
        }
      }
    } catch (err) {
      console.error("[cron/billingSweeper] Error:", err);
    }
  });
}
