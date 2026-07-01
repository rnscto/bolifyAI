import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgCampaignLeadCounts — SQL-backed campaign progress + next-batch selection.
// Replaces the multi-page CampaignLead status scans in campaignPoller and
// executeCampaign with single SQL queries against the `campaign_leads` mirror.
//
// Payload (service_call:true bypasses user auth — only used backend-to-backend):
//   { campaign_id, ready_limit?, want_batch? }
//
// Returns:
//   {
//     counts: { pending, calling, processing, completed, failed, skipped },
//     pending_ready,        // pending whose followup_call_date is null or <= now
//     pending_retry_later,  // pending whose followup_call_date is in the future
//     outcomes: { neutral, interested, ... },   // over completed+failed
//     ready_batch: [{ id, lead_id, lead_phone, lead_name, attempt_count }]  // if want_batch
//   }
// ═══════════════════════════════════════════════════════════════════════

function pgClient() {
  return new Client({
    hostname: Deno.env.get('AZURE_PG_HOST'),
    port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
    database: Deno.env.get('AZURE_PG_DATABASE'),
    user: Deno.env.get('AZURE_PG_USER'),
    password: Deno.env.get('AZURE_PG_PASSWORD'),
    tls: { enabled: true, enforce: true },
    connection: { attempts: 1 },
  });
}

export default async function pgCampaignLeadCounts(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));

    if (!body.service_call) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { campaign_id, ready_limit = 5, want_batch = false } = body;
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const nowIso = new Date().toISOString();

    const pg = pgClient();
    try {
      ; /* pg.connect() not needed */

      // Single grouped count over all statuses + ready/retry split for pending.
      const countRes = await pg.queryObject`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'calling')::int AS calling,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
          COUNT(*) FILTER (
            WHERE status = 'pending'
              AND (followup_call_date IS NULL OR followup_call_date <= ${nowIso}::timestamptz)
          )::int AS pending_ready,
          COUNT(*) FILTER (
            WHERE status = 'pending' AND followup_call_date > ${nowIso}::timestamptz
          )::int AS pending_retry_later,
          COUNT(*) FILTER (WHERE followup_email_sent = true)::int AS emails_sent,
          COUNT(*) FILTER (WHERE followup_scheduled = true)::int AS callbacks_scheduled
        FROM campaign_leads
        WHERE campaign_id = ${campaign_id}
      `;
      const c = countRes.rows[0] || {};

      // Outcome tallies over terminal leads (for outcomes_summary).
      const outcomeRes = await pg.queryObject`
        SELECT outcome, COUNT(*)::int AS n
        FROM campaign_leads
        WHERE campaign_id = ${campaign_id}
          AND status IN ('completed', 'failed')
          AND outcome IS NOT NULL
        GROUP BY outcome
      `;
      const outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
      for (const row of outcomeRes.rows) {
        if (outcomes[row.outcome] !== undefined) outcomes[row.outcome] = row.n;
      }

      let ready_batch = [];
      if (want_batch && (c.pending_ready || 0) > 0) {
        const batchRes = await pg.queryObject`
          SELECT id, lead_id, lead_phone, lead_name, attempt_count
          FROM campaign_leads
          WHERE campaign_id = ${campaign_id}
            AND status = 'pending'
            AND (followup_call_date IS NULL OR followup_call_date <= ${nowIso}::timestamptz)
          ORDER BY created_date ASC NULLS LAST
          LIMIT ${ready_limit}
        `;
        ready_batch = batchRes.rows;
      }

      return c.json({ data: {
        counts: {
          pending: c.pending || 0,
          calling: c.calling || 0,
          processing: c.processing || 0,
          completed: c.completed || 0,
          failed: c.failed || 0,
          skipped: c.skipped || 0,
        },
        pending_ready: c.pending_ready || 0,
        pending_retry_later: c.pending_retry_later || 0,
        emails_sent: c.emails_sent || 0,
        callbacks_scheduled: c.callbacks_scheduled || 0,
        outcomes,
        ready_batch,
      } });
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    console.error('[pgCampaignLeadCounts] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};