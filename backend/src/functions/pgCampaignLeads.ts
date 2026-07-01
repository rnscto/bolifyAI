import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgCampaignLeads — read the FULL CampaignLead result set from Postgres.
// ═══════════════════════════════════════════════════════════════════════
// CampaignLead is PG-primary (source of record), so the campaign detail UI
// reads its lead table directly from Postgres instead of paginating the
// (stale, best-effort-mirrored) Base44 CampaignLead entity.
//
// Payload: { campaign_id, limit?, offset? }  (limit default 1000, max 5000)
// Returns: { leads: [...], total } — rows shaped like the Base44 entity so
// the existing CampaignLeadsTable / CampaignDetail code works unchanged.
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

export default async function pgCampaignLeads(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    // Auth: any signed-in app user (the page is behind the client dashboard).
    const user = c.get('jwtPayload').catch(() => null);
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json().catch(() => ({}));
    const campaignId = body.campaign_id;
    if (!campaignId) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const limit = Math.min(5000, Math.max(1, parseInt(body.limit, 10) || 1000));
    const offset = Math.max(0, parseInt(body.offset, 10) || 0);
    // Optional server-side filter (matches the table's filter dropdown).
    // 'all' / empty = no filter. 'live' = calling|processing. 'has_transcript'.
    // Otherwise matches either status OR outcome === filter.
    const filter = String(body.filter || 'all');

    const pg = pgClient();
    try {
      ; /* pg.connect() not needed */

      // Build the WHERE filter fragment shared by count + page query.
      let filterSql = '';
      if (filter === 'live') {
        filterSql = `AND cl.status IN ('calling','processing')`;
      } else if (filter === 'has_transcript') {
        filterSql = `AND cl.transcript IS NOT NULL AND cl.transcript <> ''`;
      } else if (filter && filter !== 'all') {
        filterSql = `AND (cl.status = $filter OR cl.outcome = $filter)`;
      }

      const countRes = filterSql.includes('$filter')
        ? await pg.queryObject(
            `SELECT COUNT(*)::int AS total FROM campaign_leads cl WHERE cl.campaign_id = $cid ${filterSql}`,
            { cid: campaignId, filter })
        : await pg.queryObject(
            `SELECT COUNT(*)::int AS total FROM campaign_leads cl WHERE cl.campaign_id = $cid ${filterSql}`,
            { cid: campaignId });
      const total = countRes.rows[0]?.total || 0;

      // Server-side sort matches the table: live calls first, then completed/
      // failed/skipped by most-recent activity, then pending. LEFT JOIN call_logs
      // so recording_url comes back with each lead (campaign CallLogs are PG-only).
      const orderSql = `
        ORDER BY
          CASE cl.status WHEN 'calling' THEN 0 WHEN 'processing' THEN 1 WHEN 'pending' THEN 3 ELSE 2 END ASC,
          COALESCE(cl.updated_at, cl.created_date) DESC NULLS LAST`;

      const pageQuery = `
        SELECT cl.id, cl.campaign_id, cl.client_id, cl.lead_id, cl.status, cl.outcome,
               cl.call_log_id, cl.attempt_count, cl.lead_name, cl.lead_phone,
               cl.followup_call_date, cl.transcript, cl.conversation_summary,
               cl.call_duration, cl.call_status, cl.followup_email_sent,
               cl.followup_scheduled, cl.created_date, cl.updated_at,
               log.recording_url AS recording_url
        FROM campaign_leads cl
        LEFT JOIN call_logs log ON log.id = cl.call_log_id
        WHERE cl.campaign_id = $cid ${filterSql}
        ${orderSql}
        LIMIT $lim OFFSET $off`;

      const res = filterSql.includes('$filter')
        ? await pg.queryObject(pageQuery, { cid: campaignId, filter, lim: limit, off: offset })
        : await pg.queryObject(pageQuery, { cid: campaignId, lim: limit, off: offset });

      // Normalize timestamps to ISO strings so the frontend Date() parsing matches Base44.
      const leads = res.rows.map((r) => ({
        ...r,
        followup_call_date: r.followup_call_date ? new Date(r.followup_call_date).toISOString() : null,
        created_date: r.created_date ? new Date(r.created_date).toISOString() : null,
        updated_date: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      }));

      return c.json({ data: { success: true, leads, total } });
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    console.error('[pgCampaignLeads] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};