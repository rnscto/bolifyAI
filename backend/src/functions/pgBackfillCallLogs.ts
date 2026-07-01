import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgBackfillCallLogs — one-time (resumable) backfill of existing Base44
// CallLogs into the Postgres `call_logs` mirror table.
// ═══════════════════════════════════════════════════════════════════════
// Admin or cron (CRON_API_KEY). Processes call logs in pages, upserting
// each page into Postgres. Resumable via ?skip= so a single run that hits
// the time limit can be continued. Rate-limit resilient (backoff on 429).
//
//   GET /pgBackfillCallLogs?api_key=...&pages=10&skip=0
//     pages = how many 200-row pages to process this run (default 5)
//     skip  = call log offset to start from (default 0)
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
      return await svc.entities.CallLog.list('created_date', PAGE_SIZE, offset);
    } catch (e) {
      if (/429|rate limit/i.test(e.message) && attempt < 5) { await sleep(1000 * Math.pow(2, attempt)); continue; }
      throw e;
    }
  }
  return [];
}

export default async function pgBackfillCallLogs(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const url = new URL(req.url);
    const apiKey = url.searchParams.get('api_key');
    const isCron = apiKey && apiKey === Deno.env.get('CRON_API_KEY');
    if (!isCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (user?.role !== 'admin') return c.json({ data: { error: 'Forbidden' } }, 403);
    }
    const svc = base44.asServiceRole;

    // Default to 2 pages (400 rows) per run — keeps each invocation well under
    // the function time budget. Batched into one INSERT per page so a page is a
    // single Postgres round-trip instead of 200 sequential ones.
    const maxPages = Math.max(1, Math.min(parseInt(url.searchParams.get('pages') || '2', 10), 10));
    // Auto-resume: if no explicit ?skip= is given, read last saved offset from PG
    // so a fixed cron URL (no skip) walks the whole table run-by-run.
    const explicitSkip = url.searchParams.get('skip');
    let offset = explicitSkip != null ? Math.max(0, parseInt(explicitSkip, 10)) : null;

    const COLS = 20; // columns per row in the INSERT

    const pg = pgClient();
    let upserted = 0;
    let pagesDone = 0;
    let done = false;
    try {
      ; /* pg.connect() not needed */

      // Progress table for auto-resume (no-op if it already exists).
      await pg.queryArray`
        CREATE TABLE IF NOT EXISTS backfill_progress (
          job text PRIMARY KEY,
          offset_done integer NOT NULL DEFAULT 0,
          done boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `;

      if (offset === null) {
        const r = await pg.queryObject`SELECT offset_done, done FROM backfill_progress WHERE job = 'call_logs'`;
        const row = r.rows?.[0];
        if (row?.done) {
          return c.json({ data: { ok: true, upserted: 0, pagesDone: 0, done: true, next_skip: null, hint: 'Backfill already complete' } });
        }
        offset = row?.offset_done || 0;
      }
      for (let p = 0; p < maxPages; p++) {
        const page = await fetchPage(svc, offset);
        if (!page || page.length === 0) { done = true; break; }

        const rows = page.filter(cl => cl.client_id);
        if (rows.length > 0) {
          // Build a single multi-row INSERT: VALUES ($1,..,$20),($21,..,$40),...
          const valuesSql = rows.map((_, i) => {
            const b = i * COLS;
            return `(${Array.from({ length: COLS }, (_, j) => `$${b + j + 1}`).join(',')})`;
          }).join(',');

          const params = [];
          for (const cl of rows) {
            params.push(
              cl.id, cl.client_id, cl.agent_id || null, cl.lead_id || null,
              cl.campaign_id || null, cl.call_sid || null, cl.caller_id || null,
              cl.callee_number || null, cl.direction || null, cl.status || null,
              cl.duration ?? null, cl.provider || null, cl.country_code || null,
              cl.provider_cost ?? null, cl.provider_currency || null,
              cl.post_processed === true,
              cl.call_start_time || null, cl.call_end_time || null, cl.created_date || null,
              new Date().toISOString()
            );
          }

          await pg.queryArray(
            `INSERT INTO call_logs (
              id, client_id, agent_id, lead_id, campaign_id, call_sid, caller_id,
              callee_number, direction, status, duration, provider, country_code,
              provider_cost, provider_currency, post_processed,
              call_start_time, call_end_time, created_date, updated_at
            ) VALUES ${valuesSql}
            ON CONFLICT (id) DO UPDATE SET
              client_id = EXCLUDED.client_id, agent_id = EXCLUDED.agent_id,
              lead_id = EXCLUDED.lead_id, campaign_id = EXCLUDED.campaign_id,
              call_sid = EXCLUDED.call_sid, caller_id = EXCLUDED.caller_id,
              callee_number = EXCLUDED.callee_number, direction = EXCLUDED.direction,
              status = EXCLUDED.status, duration = EXCLUDED.duration,
              provider = EXCLUDED.provider, country_code = EXCLUDED.country_code,
              provider_cost = EXCLUDED.provider_cost, provider_currency = EXCLUDED.provider_currency,
              post_processed = EXCLUDED.post_processed,
              call_start_time = EXCLUDED.call_start_time, call_end_time = EXCLUDED.call_end_time,
              created_date = COALESCE(EXCLUDED.created_date, call_logs.created_date),
              updated_at = now()`,
            params
          );
          upserted += rows.length;
        }

        offset += page.length;
        pagesDone++;
        if (page.length < PAGE_SIZE) { done = true; break; }
      }

      // Persist progress so a fixed cron URL resumes automatically next run.
      await pg.queryArray`
        INSERT INTO backfill_progress (job, offset_done, done, updated_at)
        VALUES ('call_logs', ${offset}, ${done}, now())
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
    console.error('[pgBackfillCallLogs] Error:', error.message);
    return c.json({ data: { ok: false, error: error.message } }, 500);
  }

};