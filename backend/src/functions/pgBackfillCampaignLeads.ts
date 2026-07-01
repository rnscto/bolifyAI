import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgBackfillCampaignLeads — resumable backfill of existing Base44 CampaignLeads
// into the Postgres `campaign_leads` mirror.
// ═══════════════════════════════════════════════════════════════════════
// Admin or cron (CRON_API_KEY). Batched one INSERT per page, auto-resuming via
// the backfill_progress table (job='campaign_leads'). Fixed cron URL with no
// ?skip= walks the whole table run-by-run until done:true.
//
//   GET /pgBackfillCampaignLeads?api_key=...&pages=2&skip=0
// ═══════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 200;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

async function fetchPage(svc, offset) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await svc.entities.CampaignLead.list('created_date', PAGE_SIZE, offset);
    } catch (e) {
      if (/429|rate limit/i.test(e.message) && attempt < 5) { await sleep(1000 * Math.pow(2, attempt)); continue; }
      throw e;
    }
  }
  return [];
}

export default async function pgBackfillCampaignLeads(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const url = new URL(req.url);
    const apiKey = url.searchParams.get('api_key');
    const isCron = apiKey && apiKey === Deno.env.get('CRON_API_KEY');
    const bodyPeek = await req.clone().json().catch(() => ({}));
    const isServiceCall = bodyPeek.service_call === true;
    if (!isCron && !isServiceCall) {
      const user = c.get('jwtPayload').catch(() => null);
      if (user?.role !== 'admin') return c.json({ data: { error: 'Forbidden' } }, 403);
    }
    const svc = base44.asServiceRole;

    // ─── Targeted per-campaign backfill ───
    // Syncs ONLY one campaign's CampaignLeads into the PG mirror. Used to repair
    // a campaign whose leads landed in Base44 but never reached PG (e.g. the
    // credit-gated mirror automation was blocked). Accepts campaign_id via body
    // or ?campaign_id=. Runs the whole campaign in one go (Deno, no 10s cap).
    const body = await c.req.json().catch(() => ({}));
    const campaignId = body.campaign_id || url.searchParams.get('campaign_id');
    if (campaignId) {
      const pg = pgClient();
      let upserted = 0, page = 0;
      try {
        ; /* pg.connect() not needed */
        const COLS = 13;
        while (page < 60) {
          let batch = [];
          for (let attempt = 0; attempt < 5; attempt++) {
            try { batch = await svc.entities.CampaignLead.filter({ campaign_id: campaignId }, 'created_date', PAGE_SIZE, page * PAGE_SIZE); break; }
            catch (e) { if (/429|rate limit/i.test(e.message) && attempt < 4) { await sleep(800 * (attempt + 1)); continue; } throw e; }
          }
          if (!batch || batch.length === 0) break;
          const rows = batch.filter(cl => cl.campaign_id);
          if (rows.length) {
            const valuesSql = rows.map((_, i) => { const b = i * COLS; return `(${Array.from({ length: COLS }, (_, j) => `$${b + j + 1}`).join(',')})`; }).join(',');
            const params = [];
            for (const cl of rows) {
              params.push(cl.id, cl.campaign_id, cl.client_id || null, cl.lead_id || null,
                cl.status || null, cl.outcome || null, cl.call_log_id || null,
                cl.attempt_count ?? null, cl.lead_name || null, cl.lead_phone || null,
                cl.followup_call_date || null, cl.created_date || null, new Date().toISOString());
            }
            await pg.queryArray(
              `INSERT INTO campaign_leads (id, campaign_id, client_id, lead_id, status, outcome, call_log_id, attempt_count, lead_name, lead_phone, followup_call_date, created_date, updated_at) VALUES ${valuesSql}
               ON CONFLICT (id) DO UPDATE SET campaign_id=EXCLUDED.campaign_id, client_id=EXCLUDED.client_id, lead_id=EXCLUDED.lead_id, status=EXCLUDED.status, outcome=EXCLUDED.outcome, call_log_id=EXCLUDED.call_log_id, attempt_count=EXCLUDED.attempt_count, lead_name=EXCLUDED.lead_name, lead_phone=EXCLUDED.lead_phone, followup_call_date=EXCLUDED.followup_call_date, created_date=COALESCE(EXCLUDED.created_date, campaign_leads.created_date), updated_at=now()`,
              params
            );
            upserted += rows.length;
          }
          page++;
          if (batch.length < PAGE_SIZE) break;
          await sleep(150);
        }
        return c.json({ data: { ok: true, mode: 'campaign', campaign_id: campaignId, upserted, done: true } });
      } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
    }

    const maxPages = Math.max(1, Math.min(parseInt(url.searchParams.get('pages') || '2', 10), 10));
    const explicitSkip = url.searchParams.get('skip');
    let offset = explicitSkip != null ? Math.max(0, parseInt(explicitSkip, 10)) : null;

    const COLS = 13; // columns per row in the INSERT

    const pg = pgClient();
    let upserted = 0;
    let pagesDone = 0;
    let done = false;
    try {
      ; /* pg.connect() not needed */

      await pg.queryArray`
        CREATE TABLE IF NOT EXISTS backfill_progress (
          job text PRIMARY KEY,
          offset_done integer NOT NULL DEFAULT 0,
          done boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `;

      if (offset === null) {
        const r = await pg.queryObject`SELECT offset_done, done FROM backfill_progress WHERE job = 'campaign_leads'`;
        const row = r.rows?.[0];
        if (row?.done) {
          return c.json({ data: { ok: true, upserted: 0, pagesDone: 0, done: true, next_skip: null, hint: 'Backfill already complete' } });
        }
        offset = row?.offset_done || 0;
      }

      for (let p = 0; p < maxPages; p++) {
        const page = await fetchPage(svc, offset);
        if (!page || page.length === 0) { done = true; break; }

        const rows = page.filter(cl => cl.campaign_id);
        if (rows.length > 0) {
          const valuesSql = rows.map((_, i) => {
            const b = i * COLS;
            return `(${Array.from({ length: COLS }, (_, j) => `$${b + j + 1}`).join(',')})`;
          }).join(',');

          const params = [];
          for (const cl of rows) {
            params.push(
              cl.id, cl.campaign_id, cl.client_id || null, cl.lead_id || null,
              cl.status || null, cl.outcome || null, cl.call_log_id || null,
              cl.attempt_count ?? null, cl.lead_name || null, cl.lead_phone || null,
              cl.followup_call_date || null, cl.created_date || null,
              new Date().toISOString()
            );
          }

          await pg.queryArray(
            `INSERT INTO campaign_leads (
              id, campaign_id, client_id, lead_id, status, outcome, call_log_id,
              attempt_count, lead_name, lead_phone, followup_call_date, created_date, updated_at
            ) VALUES ${valuesSql}
            ON CONFLICT (id) DO UPDATE SET
              campaign_id = EXCLUDED.campaign_id, client_id = EXCLUDED.client_id,
              lead_id = EXCLUDED.lead_id, status = EXCLUDED.status,
              outcome = EXCLUDED.outcome, call_log_id = EXCLUDED.call_log_id,
              attempt_count = EXCLUDED.attempt_count, lead_name = EXCLUDED.lead_name,
              lead_phone = EXCLUDED.lead_phone, followup_call_date = EXCLUDED.followup_call_date,
              created_date = COALESCE(EXCLUDED.created_date, campaign_leads.created_date),
              updated_at = now()`,
            params
          );
          upserted += rows.length;
        }

        offset += page.length;
        pagesDone++;
        if (page.length < PAGE_SIZE) { done = true; break; }
      }

      await pg.queryArray`
        INSERT INTO backfill_progress (job, offset_done, done, updated_at)
        VALUES ('campaign_leads', ${offset}, ${done}, now())
        ON CONFLICT (job) DO UPDATE SET
          offset_done = EXCLUDED.offset_done, done = EXCLUDED.done, updated_at = now()
      `;
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }

    return c.json({ data: {
      ok: true, upserted, pagesDone, done,
      next_skip: done ? null : offset,
      hint: done ? 'Backfill complete' : `Continue with ?skip=${offset}`
    } });
  } catch (error) {
    console.error('[pgBackfillCampaignLeads] Error:', error.message);
    return c.json({ data: { ok: false, error: error.message } }, 500);
  }

};