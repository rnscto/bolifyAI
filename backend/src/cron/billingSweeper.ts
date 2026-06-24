import { base44ORM as base44 } from "../db/orm.ts";

export function initBillingSweeper() {
  Deno.cron("Billing Sweeper", "0 0 * * *", async () => {
    console.log("[cron/billingSweeper] Running daily billing & suspension sweep...");
    const now = new Date();
    
    try {
      // 1. Trial -> Expired
      const trials = await base44.entities.Client.filter({ account_status: 'trial' });
      for (const c of trials) {
        if (!c.trial_end_date) continue;
        const end = new Date(c.trial_end_date);
        if (end < now) {
          await base44.entities.Client.update(c.id, { account_status: 'expired' });
          console.log(`[cron/billingSweeper] Client ${c.id} trial expired.`);
        }
      }

      // 2. Pending Subscriptions
      const pendingSubs = await base44.entities.Subscription.filter({ status: 'pending' });
      for (const sub of pendingSubs) {
        await base44.entities.Subscription.update(sub.id, { status: 'overdue', payment_status: 'failed' });
        const clients = await base44.entities.Client.filter({ id: sub.client_id });
        const c = clients[0];
        if (c && !['suspended', 'cancelled'].includes(c.account_status)) {
          await base44.entities.Client.update(c.id, { account_status: 'suspended' });
          console.log(`[cron/billingSweeper] Client ${c.id} suspended due to pending subscription ${sub.id}.`);
        }
      }

      // 3. Active Subscription -> Overdue
      const activeSubs = await base44.entities.Subscription.filter({ status: 'active' });
      for (const sub of activeSubs) {
        if (!sub.billing_end_date) continue;
        const end = new Date(sub.billing_end_date);
        if (end >= now) continue;

        const allClientSubs = await base44.entities.Subscription.filter({ client_id: sub.client_id });
        const hasNewerActive = allClientSubs.some((s: any) =>
          s.id !== sub.id && s.status === 'active' && s.billing_end_date && new Date(s.billing_end_date) > now
        );
        if (hasNewerActive) continue;

        await base44.entities.Subscription.update(sub.id, { status: 'overdue' });
        const clients = await base44.entities.Client.filter({ id: sub.client_id });
        const c = clients[0];
        if (c && !['suspended', 'cancelled'].includes(c.account_status)) {
          await base44.entities.Client.update(c.id, { account_status: 'suspended' });
          console.log(`[cron/billingSweeper] Client ${c.id} suspended due to expired active subscription ${sub.id}.`);
        }
      }
    } catch (err) {
      console.error("[cron/billingSweeper] Error:", err);
    }
  });
}
