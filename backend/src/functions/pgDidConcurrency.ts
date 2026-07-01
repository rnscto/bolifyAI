import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { Client } from 'jsr:@db/postgres@0.19.4';

// ═══════════════════════════════════════════════════════════════════════
// pgDidConcurrency — atomic per-DID concurrency counter on Azure Postgres
// ═══════════════════════════════════════════════════════════════════════
// Phase 1 of the Base44 → Azure Postgres migration. Replaces the per-DID
// DIDConcurrency Base44 entity (which contended for the shared rate-limit
// bucket) with a single atomic SQL UPSERT/UPDATE — sub-ms, no 429 risk.
//
// Actions (passed in the request body):
//   - increment: atomic +1 on dial-start. UPSERTs the row.
//       { action:'increment', did_number, client_id, max_concurrent? }
//   - decrement: atomic -1 on call-end (floored at 0).
//       { action:'decrement', did_number }
//   - get: read a single DID's counter. { action:'get', did_number }
//   - sweep: reset stale counters (active>0 & last_increment_at older than
//       stale_minutes). { action:'sweep', stale_minutes? }
//
// did_number is normalized to last-10 digits to match how DIDs are stored
// on the Agent (callers may pass full E.164 or 10-digit).
// ═══════════════════════════════════════════════════════════════════════

function norm(did) {
  return String(did || '').replace(/\D/g, '').slice(-10);
}

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

export default async function pgDidConcurrency(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    // Allow internal service-role invocations (dialers); require auth otherwise.
    const body = await c.req.json().catch(() => ({}));
    // Accept params from the JSON body OR the URL query string (so a plain GET
    // from an external cron service works too, e.g. cron-job.org).
    const url = new URL(req.url);
    const action = body.action || url.searchParams.get('action');
    const service_call = body.service_call;
    const cron_secret = body.cron_secret || url.searchParams.get('cron_secret');

    // Auth paths: (1) external cron with the shared CRON_API_KEY secret,
    // (2) internal service-role invocation from the dialers, (3) a logged-in user.
    const isCron = cron_secret && cron_secret === Deno.env.get('CRON_API_KEY');
    if (!isCron && !service_call) {
      const user = c.get('jwtPayload');
      if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    if (!action) return c.json({ data: { error: 'action required' } }, 400);

    const client = pgClient();
    try {
      ; /* client.connect() not needed */

      if (action === 'increment') {
        const did = norm(body.did_number);
        if (!did) return c.json({ data: { error: 'did_number required' } }, 400);
        const maxConc = Number.isFinite(body.max_concurrent) ? body.max_concurrent : 1;
        const res = await client.queryObject`
          INSERT INTO did_concurrency (did_number, client_id, max_concurrent, active_count, last_increment_at, updated_at)
          VALUES (${did}, ${body.client_id || null}, ${maxConc}, 1, now(), now())
          ON CONFLICT (did_number) DO UPDATE
            SET active_count = did_concurrency.active_count + 1,
                last_increment_at = now(),
                updated_at = now(),
                -- Keep capacity in sync with the DID's current configured cap
                -- so a row created with a stale cap (e.g. 1) doesn't throttle a
                -- DID later raised to 5.
                max_concurrent = EXCLUDED.max_concurrent,
                client_id = COALESCE(did_concurrency.client_id, EXCLUDED.client_id)
          RETURNING active_count, max_concurrent
        `;
        return c.json({ data: { ok: true, ...res.rows[0] } });
      }

      if (action === 'decrement') {
        const did = norm(body.did_number);
        if (!did) return c.json({ data: { error: 'did_number required' } }, 400);
        const res = await client.queryObject`
          UPDATE did_concurrency
            SET active_count = GREATEST(active_count - 1, 0),
                last_decrement_at = now(),
                updated_at = now()
          WHERE did_number = ${did}
          RETURNING active_count, max_concurrent
        `;
        return c.json({ data: { ok: true, ...(res.rows[0] || { active_count: 0 }) } });
      }

      if (action === 'get') {
        const did = norm(body.did_number);
        if (!did) return c.json({ data: { error: 'did_number required' } }, 400);
        const res = await client.queryObject`
          SELECT did_number, client_id, max_concurrent, active_count,
                 last_increment_at, last_decrement_at
          FROM did_concurrency WHERE did_number = ${did}
        `;
        return c.json({ data: { ok: true, row: res.rows[0] || null } });
      }

      if (action === 'get_all') {
        // Batched read of active counts for a list of DIDs in ONE query.
        // Returns a map { <last10 did>: active_count }. DIDs with no row are
        // simply absent (treated as 0 active by the caller).
        const dids = Array.isArray(body.did_numbers) ? body.did_numbers.map(norm).filter(Boolean) : [];
        if (dids.length === 0) return c.json({ data: { ok: true, active: {} } });
        const res = await client.queryObject`
          SELECT did_number, active_count
          FROM did_concurrency
          WHERE did_number = ANY(${dids})
        `;
        const active = {};
        for (const r of res.rows) active[r.did_number] = Number(r.active_count) || 0;
        return c.json({ data: { ok: true, active } });
      }

      if (action === 'sweep') {
        const staleMin = Number.isFinite(body.stale_minutes) ? body.stale_minutes : 15;
        const res = await client.queryObject`
          UPDATE did_concurrency
            SET active_count = 0, updated_at = now()
          WHERE active_count > 0
            AND last_increment_at < now() - (${staleMin} * INTERVAL '1 minute')
          RETURNING did_number
        `;
        return c.json({ data: { ok: true, swept: res.rows.map(r => r.did_number) } });
      }

      return c.json({ data: { error: `Unknown action: ${action}` } }, 400);
    } finally {
      try { ; /* client.end() not needed */ } catch (_) {}
    }
  } catch (error) {
    console.error('[pgDidConcurrency] Error:', error.message);
    return c.json({ data: { ok: false, error: error.message } }, 500);
  }

};