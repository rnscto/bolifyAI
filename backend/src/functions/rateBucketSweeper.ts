import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// rateBucketSweeper — periodic cleanup for RateBucket + stale DIDConcurrency.
// ═══════════════════════════════════════════════════════════════════════
// RateBucket rows are fixed-window counters that become useless once their
// window passes. This deletes windows older than 10 minutes so the table
// stays small. It also resets DIDConcurrency rows whose last increment is
// older than the longest plausible call (15 min) AND active_count > 0 — a
// safety net against counter drift if a call never reported completion.
//
// Triggered by external cron only (?cron_secret=<CRON_API_KEY>) every ~10 min.
// ═══════════════════════════════════════════════════════════════════════


export default async function rateBucketSweeper(c: any) {
  const req = c.req.raw || c.req;
  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get('cron_secret') || url.searchParams.get('api_key');
    const expected = Deno.env.get('CRON_API_KEY');
    if (!expected || secret !== expected) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const result = { rate_buckets_deleted: 0, did_counters_reset: 0 };

    // ── 1. Delete stale RateBucket windows (> 10 min old) ──
    const cutoff = Date.now() - 10 * 60 * 1000;
    const buckets = await svc.entities.RateBucket.list('-created_date', 500).catch(() => []);
    for (const b of buckets) {
      const ws = new Date(b.window_start || b.created_date).getTime();
      if (ws < cutoff) {
        await svc.entities.RateBucket.delete(b.id).catch(() => {});
        result.rate_buckets_deleted++;
        await new Promise(r => setTimeout(r, 60)); // gentle pacing
      }
    }

    // ── 2. Reset drifted DIDConcurrency counters ──
    // If a DID shows active calls but hasn't been incremented in >15 min,
    // the underlying call almost certainly ended without decrementing.
    const staleCut = Date.now() - 15 * 60 * 1000;
    const dids = await svc.entities.DIDConcurrency.filter({}).catch(() => []);
    for (const d of dids) {
      if ((d.active_count || 0) > 0) {
        const last = new Date(d.last_increment_at || d.created_date).getTime();
        if (last < staleCut) {
          await svc.entities.DIDConcurrency.update(d.id, { active_count: 0 }).catch(() => {});
          result.did_counters_reset++;
        }
      }
    }

    return c.json({ data: { success: true, ...result } });
  } catch (error) {
    console.error('[rateBucketSweeper] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};