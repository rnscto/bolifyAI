import { client } from "../db/index.ts";
import { sendEmail } from "../integrations/email.ts";

/**
 * DPDP Act 2023 Compliance: Automated Data Erasure
 * Runs daily at 2 AM IST.
 * Erases personal data for clients who have exceeded their data_retention_days.
 */
export function initDpdpErasure() {
  Deno.cron("DPDP Data Erasure", "30 20 * * *", async () => { // 20:30 UTC = 02:00 IST
    console.log("[cron/dpdpErasure] Running DPDP data retention sweep...");
    try {
      // Find clients whose data retention window has passed
      const clientsRes = await client.queryObject(`
        SELECT id, company_name, email, data_retention_days, dpdp_consent_given
        FROM "client"
        WHERE data_retention_days IS NOT NULL 
          AND data_retention_days > 0
          AND account_status IN ('cancelled', 'expired')
          AND updated_at < NOW() - (data_retention_days || ' days')::INTERVAL
      `);

      const clients = clientsRes.rows as any[];
      if (clients.length === 0) {
        console.log("[cron/dpdpErasure] No clients due for erasure.");
        return;
      }

      for (const c of clients) {
        console.log(`[cron/dpdpErasure] Erasing PII for client ${c.id} (${c.company_name}), retention: ${c.data_retention_days} days`);
        try {
          // Anonymize leads (preserve analytics, erase PII)
          await client.queryObject(`
            UPDATE "lead"
            SET name = 'ERASED', phone = 'ERASED', email = 'ERASED', 
                notes = NULL, custom_fields = NULL, tags = NULL
            WHERE client_id = $1
          `, [c.id]);

          // Anonymize call logs (preserve counts, erase content)
          await client.queryObject(`
            UPDATE "calllog"
            SET transcript = NULL, conversation_summary = NULL, recording_url = NULL
            WHERE client_id = $1
          `, [c.id]);

          // Erase consent logs PII
          await client.queryObject(`
            UPDATE "consentlog"
            SET given_by_email = 'ERASED', given_by_name = 'ERASED', ip_address = 'ERASED'
            WHERE client_id = $1
          `, [c.id]);

          // Erase outreach PII
          await client.queryObject(`
            UPDATE "outreachlog"
            SET recipient_email = 'ERASED', recipient_phone = 'ERASED'
            WHERE client_id = $1
          `, [c.id]);

          // Write audit record
          await client.queryObject(`
            INSERT INTO "auditlog" (client_id, action_type, entity_type, details, actor_role)
            VALUES ($1, 'DATA_ERASURE', 'client', $2, 'system')
          `, [c.id, `DPDP auto-erasure after ${c.data_retention_days} day retention window`]);

          // Notify if email available
          if (c.email && c.email !== 'ERASED') {
            await sendEmail(
              c.email,
              "BolifyAI: Your Data Has Been Erased (DPDP Act 2023)",
              `Dear ${c.company_name},\n\nAs per the Digital Personal Data Protection Act 2023 and your account's ${c.data_retention_days}-day data retention policy, we have completed the erasure of your personal data from our systems.\n\nAudit records will be retained for compliance purposes as permitted under applicable law.\n\nFor queries, contact privacy@bolifyai.com\n\nBolifyAI Privacy Team`
            ).catch(() => {});
          }

          console.log(`[cron/dpdpErasure] ✅ Erased PII for client ${c.id}`);
        } catch (clientErr: any) {
          console.error(`[cron/dpdpErasure] ❌ Failed erasure for ${c.id}: ${clientErr.message}`);
        }
      }

      console.log(`[cron/dpdpErasure] Sweep complete. Processed ${clients.length} clients.`);
    } catch (err: any) {
      console.error("[cron/dpdpErasure] Error:", err.message);
    }
  });
}
