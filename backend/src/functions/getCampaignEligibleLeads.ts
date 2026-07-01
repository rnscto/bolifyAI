import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// getCampaignEligibleLeads — return the FULL set of a client's leads for the
// campaign create / add-leads dialogs.
//
// WHY THIS EXISTS:
//   The dialogs previously paginated Lead.filter() CLIENT-SIDE with the
//   user-scoped SDK. That path is aggressively rate-limited — a single 429
//   mid-pagination threw, aborted the loop, and left only the first ~500-1000
//   leads loaded. So importing a 7000-lead client silently produced a campaign
//   with ~500 leads ("Select All" only saw what loaded).
//
//   This server-side loader pages the WHOLE table with retry/backoff (no
//   client-side 429, no early abort) and returns every lead. Only the light
//   fields the dialog needs are returned (id, name, phone, status, group_ids)
//   to keep the payload small.
//
// Payload: { client_id }
// Returns: { success, leads: [{id, name, phone, status, group_ids}], total }
// ═══════════════════════════════════════════════════════════════════════



const PAGE = 500;          // SDK hard cap per call
const MAX_PAGES = 400;     // safety: up to 200k leads
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch one page with retry/backoff on 429 so a transient rate-limit never
// truncates the result (the exact bug that capped campaigns at ~500 leads).
async function fetchPageWithRetry(svc, query, limit, offset) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await svc.entities.Lead.filter(query, '-created_date', limit, offset);
    } catch (e) {
      const msg = e?.message || '';
      if (/429|rate limit/i.test(msg) && attempt < 5) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  return [];
}

export default async function getCampaignEligibleLeads(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json().catch(() => ({}));
    const { client_id } = body;
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    // Ownership check (non-admins can only load their own client's leads).
    if (user.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      const ownIds = clients.map((c) => c.id);
      // Team members carry client_id on the user record.
      if (user.client_id) ownIds.push(user.client_id);
      if (!ownIds.includes(client_id)) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const svc = base44.asServiceRole;
    const out = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const batch = await fetchPageWithRetry(svc, { client_id }, PAGE, p * PAGE);
      for (const l of batch) {
        out.push({
          id: l.id,
          name: l.name || '',
          phone: l.phone || '',
          company: l.company || '',
          status: l.status || 'new',
          group_ids: l.group_ids || [],
        });
      }
      if (batch.length < PAGE) break;
      await sleep(120); // gentle pacing between pages
    }

    return c.json({ data: { success: true, leads: out, total: out.length } });
  } catch (error) {
    console.error('[getCampaignEligibleLeads] error:', error.message);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};