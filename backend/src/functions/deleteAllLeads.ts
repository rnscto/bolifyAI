import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function deleteAllLeads(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { client_id } = await c.req.json();
    if (!client_id) {
      return c.json({ data: { error: 'client_id is required' } }, 400);
    }

    // Ownership check: non-admins may only delete leads for a client they own.
    if (user.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      const owns = (clients || []).some(c => c.id === client_id);
      if (!owns) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    // Delete in batches so we never hold the full dataset in memory.
    // Each filter/delete is wrapped with retry-on-429 + gentle pacing so a
    // transient rate limit doesn't abort a large bulk delete halfway through.
    const svc = base44.asServiceRole;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const withRetry = async (fn) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await fn();
        } catch (e) {
          const msg = e?.message || '';
          if (/429|rate limit/i.test(msg) && attempt < 3) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          throw e;
        }
      }
    };

    let deleted = 0;
    const BATCH = 100;
    while (true) {
      const batch = await withRetry(() =>
        svc.entities.Lead.filter({ client_id }, '-created_date', BATCH)
      );
      if (!batch || batch.length === 0) break;
      for (const lead of batch) {
        await withRetry(() => svc.entities.Lead.delete(lead.id));
        deleted++;
        await sleep(60); // pace deletes to stay under the rate limit
      }
      if (batch.length < BATCH) break;
    }

    // Clear the Postgres mirror for this client too (best-effort).
    svc.functions.invoke('pgLeadSync', { delete_client_id: client_id }).catch(() => {});

    return c.json({ data: { success: true, deleted } });
  } catch (error) {
    console.error('deleteAllLeads error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};