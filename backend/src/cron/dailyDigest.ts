import { client } from "../db/index.ts";

export function initDailyDigest() {
  Deno.cron("Daily Task Digest", "0 2 * * *", async () => {
    console.log("[cron/dailyDigest] Running daily task digest...");
    
    try {
      const humanTypes = ['email', 'task', 'demo', 'visit', 'meeting', 'appointment', 'booking'];

      const allPendingRes = await (client as any).queryObject(`
        SELECT * FROM activity 
        WHERE status IN ('scheduled', 'overdue') 
        AND type = ANY($1)
        ORDER BY scheduled_date ASC
        LIMIT 1000
      `, [humanTypes]);

      const allPending = allPendingRes.rows;
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
        if (clientId === 'unknown') continue;
        
        const clientRes = await (client as any).queryObject('SELECT email FROM client WHERE id = $1', [clientId]);
        const clientRow = clientRes.rows[0];
        if (!clientRow || !clientRow.email) continue;

        const overdueCount = tasks.filter((t: any) => t.status === 'overdue').length;
        const pendingCount = tasks.filter((t: any) => t.status === 'scheduled').length;

        console.log(`[cron/dailyDigest] Would send digest to ${clientRow.email}: ${overdueCount} overdue, ${pendingCount} pending`);
        emailsSent++;
      }
      
      console.log(`[cron/dailyDigest] Processed ${Object.keys(byClient).length} clients. Emails sent: ${emailsSent}`);
    } catch (err) {
      console.error("[cron/dailyDigest] Error:", err);
    }
  });
}
