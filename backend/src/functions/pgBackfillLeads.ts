import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgBackfillLeads — one-time (resumable) backfill of existing Base44 Leads
// into the Postgres `leads` mirror table.
// ═══════════════════════════════════════════════════════════════════════
// Admin or cron (CRON_API_KEY). Processes leads in pages, bulk-upserting
// each page into Postgres. Resumable via ?skip= so a single run that hits
// the time limit can be continued. Rate-limit resilient (backoff on 429).
//
//   GET /pgBackfillLeads?api_key=...&pages=10&skip=0
//     pages = how many 200-lead pages to process this run (default 10)
//     skip  = lead offset to start from (default 0)
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
      return await svc.entities.Lead.list('created_date', PAGE_SIZE, offset);
    } catch (e) {
      if (/429|rate limit/i.test(e.message) && attempt < 5) { await sleep(1000 * Math.pow(2, attempt)); continue; }
      throw e;
    }
  }
  return [];
}

export default async function pgBackfillLeads(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const url = new URL(req.url);
    // Accept params from query string (cron) OR JSON body (functions.invoke).
    const body = await c.req.json().catch(() => ({}));
    const apiKey = url.searchParams.get('api_key') || body.api_key;
    const isCron = apiKey && apiKey === Deno.env.get('CRON_API_KEY');
    if (!isCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (user?.role !== 'admin') return c.json({ data: { error: 'Forbidden' } }, 403);
    }
    const svc = base44.asServiceRole;

    const maxPages = Math.max(1, Math.min(parseInt(url.searchParams.get('pages') || body.pages || '5', 10), 50));
    let offset = Math.max(0, parseInt(url.searchParams.get('skip') || body.skip || '0', 10));

    const pg = pgClient();
    let upserted = 0;
    let pagesDone = 0;
    let done = false;
    try {
      ; /* pg.connect() not needed */
      for (let p = 0; p < maxPages; p++) {
        const page = await fetchPage(svc, offset);
        if (!page || page.length === 0) { done = true; break; }

        // Bulk multi-row upsert — ONE roundtrip per page instead of 200.
        // (Per-row awaited queries over the TLS link were ~0.5s each = far too slow.)
        const rows = page.filter(l => l.client_id);
        if (rows.length > 0) {
          const params = [];
          const valuesSql = rows.map((lead, i) => {
            const b = i * 7;
            params.push(
              lead.id, lead.client_id, lead.status || null,
              lead.qualification_tier || null, lead.source || null,
              lead.group_ids || [], !!lead.last_call_date
            );
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, now())`;
          }).join(', ');
          await pg.queryArray(
            `INSERT INTO leads (id, client_id, status, qualification_tier, source, group_ids, has_call, updated_at)
             VALUES ${valuesSql}
             ON CONFLICT (id) DO UPDATE SET
               client_id = EXCLUDED.client_id, status = EXCLUDED.status,
               qualification_tier = EXCLUDED.qualification_tier, source = EXCLUDED.source,
               group_ids = EXCLUDED.group_ids, has_call = EXCLUDED.has_call, updated_at = now()`,
            params
          );
          upserted += rows.length;
        }
        offset += page.length;
        pagesDone++;
        if (page.length < PAGE_SIZE) { done = true; break; }
        await sleep(200);
      }
    } finally {
      try { ; /* pg.end() not needed */ } catch (_) {}
    }

    return c.json({ data: {
      ok: true, upserted, pagesDone, done,
      next_skip: done ? null : offset,
      hint: done ? 'Backfill complete' : `Continue with ?skip=${offset}`
    } });
  } catch (error) {
    console.error('[pgBackfillLeads] Error:', error.message);
    return c.json({ data: { ok: false, error: error.message } }, 500);
  }

};