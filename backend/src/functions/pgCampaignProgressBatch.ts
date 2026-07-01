import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgCampaignProgressBatch — live campaign progress for MANY campaigns in ONE
// SQL round-trip against the `campaign_leads` Postgres mirror. Used by the
// Campaigns page so cards always show accurate completed / pending / failed
// counts even when the credit-gated counter automation hasn't run.
//
// Payload: { campaign_ids: [..] }  (caller must be an authenticated user)
// Returns: { progress: { [campaign_id]: {
//             total, completed, failed, pending, calling, processing,
//             outcomes: { neutral, interested, ... }
//           } } }
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

export default async function pgCampaignProgressBatch(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));

    if (!body.service_call) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const ids = Array.isArray(body.campaign_ids)
      ? body.campaign_ids.filter(Boolean)
      : [];
    if (ids.length === 0) return c.json({ data: { progress: {} } });

    const pg = pgClient();
    try {
      ; /* pg.connect() not needed */

      // One grouped query: per-campaign status counts.
      const countRes = await pg.queryObject`
        SELECT
          campaign_id,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'calling')::int AS calling,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM campaign_leads
        WHERE campaign_id = ANY(${ids})
        GROUP BY campaign_id
      `;

      // One grouped query: per-campaign outcome tallies over terminal leads.
      const outcomeRes = await pg.queryObject`
        SELECT campaign_id, outcome, COUNT(*)::int AS n
        FROM campaign_leads
        WHERE campaign_id = ANY(${ids})
          AND status IN ('completed', 'failed')
          AND outcome IS NOT NULL
        GROUP BY campaign_id, outcome
      `;

      const progress = {};
      for (const row of countRes.rows) {
        progress[row.campaign_id] = {
          total: row.total || 0,
          pending: row.pending || 0,
          calling: row.calling || 0,
          processing: row.processing || 0,
          completed: row.completed || 0,
          failed: row.failed || 0,
          outcomes: { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 },
        };
      }
      for (const row of outcomeRes.rows) {
        const p = progress[row.campaign_id];
        if (p && p.outcomes[row.outcome] !== undefined) p.outcomes[row.outcome] = row.n;
      }

      return c.json({ data: { progress } });
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    console.error('[pgCampaignProgressBatch] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};