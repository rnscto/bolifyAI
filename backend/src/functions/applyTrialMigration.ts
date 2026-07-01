import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// One-shot admin migration: applies the new 3-day trial + 10-call cap retroactively
// to ALL existing trial clients. Shortens trials longer than (started+3d) and seeds
// trial_call_limit/trial_calls_used. Safe to re-run.
//
// Admin-only. Returns counts of updated clients.



export default async function applyTrialMigration(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const trialClients = await base44.asServiceRole.entities.Client.filter({ account_status: 'trial' });
    let shortened = 0, seeded = 0, untouched = 0, recountedCalls = 0;

    for (const c of trialClients) {
      const patch = {};
      // Shorten trial to (start + 3d) if currently longer; never extend
      if (c.trial_start_date) {
        const start = new Date(c.trial_start_date);
        const targetEnd = new Date(start.getTime() + 3 * 86400000);
        const curEnd = c.trial_end_date ? new Date(c.trial_end_date) : null;
        if (!curEnd || curEnd > targetEnd) {
          patch.trial_end_date = targetEnd.toISOString();
          shortened++;
        }
      }
      // Seed call cap fields if missing
      if (c.trial_call_limit === undefined || c.trial_call_limit === null) {
        patch.trial_call_limit = 10;
        seeded++;
      }
      // Backfill trial_calls_used by counting existing CallLogs for this client
      if (c.trial_calls_used === undefined || c.trial_calls_used === null) {
        const existing = await base44.asServiceRole.entities.CallLog.filter(
          { client_id: c.id, direction: 'outbound' },
          '-created_date',
          200
        ).catch(() => []);
        patch.trial_calls_used = (existing || []).length;
        recountedCalls++;
      }
      if (Object.keys(patch).length > 0) {
        await base44.asServiceRole.entities.Client.update(c.id, patch);
      } else {
        untouched++;
      }
    }

    return c.json({ data: {
      success: true,
      total_trial_clients: trialClients.length,
      shortened,
      seeded,
      untouched,
      recounted_calls: recountedCalls,
    } });
  } catch (e) {
    console.error('applyTrialMigration error:', e);
    return c.json({ data: { error: e.message } }, 500);
  }

};