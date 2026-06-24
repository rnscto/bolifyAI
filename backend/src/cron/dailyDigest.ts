import { base44ORM as base44 } from "../db/orm.ts";

export function initDailyDigest() {
  Deno.cron("Daily Task Digest", "0 2 * * *", async () => {
    // Runs at 02:00 UTC (07:30 IST)
    console.log("[cron/dailyDigest] Running daily task digest...");
    
    try {
      const humanTypes = ['email', 'task', 'demo', 'visit', 'meeting', 'appointment', 'booking'];

      const scheduledActs = await base44.entities.Activity.filter({ status: 'scheduled' }, 'scheduled_date', 500);
      const overdueActs = await base44.entities.Activity.filter({ status: 'overdue' }, 'scheduled_date', 500);

      const allPending = [...scheduledActs, ...overdueActs].filter((a: any) => humanTypes.includes(a.type));
      if (allPending.length === 0) {
        console.log('[cron/dailyDigest] No pending human tasks — skipping');
        return;
      }

      const byClient: Record<string, any[]> = {};
      for (const act of allPending) {
        const cid = act.client_id || 'unknown';
        if (!byClient[cid]) byClient[cid] = [];
        byClient[cid].push(act);
      }

      let emailsSent = 0;
      for (const [clientId, tasks] of Object.entries(byClient)) {
        const clients = await base44.entities.Client.filter({ id: clientId });
        const client = clients[0];
        if (!client || !client.email) continue;

        const overdueCount = tasks.filter((t: any) => t.status === 'overdue').length;
        const pendingCount = tasks.filter((t: any) => t.status === 'scheduled').length;

        // Note: For now we just log it as the email service is not implemented
        console.log(`[cron/dailyDigest] Would send digest to ${client.email}: ${overdueCount} overdue, ${pendingCount} pending`);
        emailsSent++;
      }
      
      console.log(`[cron/dailyDigest] Processed ${Object.keys(byClient).length} clients. Emails sent: ${emailsSent}`);
    } catch (err) {
      console.error("[cron/dailyDigest] Error:", err);
    }
  });
}
