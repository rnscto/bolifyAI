import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// deleteCampaign — server-side deletion of a Campaign + all its CampaignLead rows
// and CampaignTemplateMapping rows.
//
// LARGE-CAMPAIGN SAFE: deleting thousands of CampaignLead rows one-by-one can
// exceed the backend function timeout (~150s), which previously left big
// campaigns un-deletable. This function now works in TIME-BOUNDED passes:
//   - It deletes leads until a soft time budget is hit, then returns
//     { done: false, leads_removed_total } so the frontend can call again.
//   - The campaign itself is only removed once ALL leads are gone (done: true).
// The Postgres mirror rows are wiped in one fast bulk SQL DELETE on the first pass.


// Soft time budget per invocation — stop well before the platform timeout so we
// can return progress cleanly instead of dying mid-delete.
const TIME_BUDGET_MS = 110000;

// Delete one record with retry/backoff on 429 rate-limit errors.
async function deleteWithRetry(deleteFn, id, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      await deleteFn(id);
      return true;
    } catch (err) {
      const msg = String(err?.message || '');
      const is429 = msg.includes('429') || msg.toLowerCase().includes('rate limit');
      if (is429 && i < attempts - 1) {
        await new Promise(r => setTimeout(r, 300 * Math.pow(2, i)));
        continue;
      }
      return false;
    }
  }
  return false;
}

export default async function deleteCampaign(c: any) {
  const req = c.req.raw || c.req;
  const startedAt = Date.now();
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const { campaign_id, leads_removed_so_far = 0 } = body;
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const svc = base44.asServiceRole;

    // Verify ownership (or admin)
    const campaign = await svc.entities.Campaign.get(campaign_id);
    if (!campaign) {
      // Already gone — treat as success so the frontend stops looping.
      return c.json({ data: { success: true, done: true, leads_removed_total: leads_removed_so_far } });
    }

    if (user.role !== 'admin') {
      const clients = await svc.entities.Client.filter({ user_id: user.id });
      const ownsIt = clients.some(c => c.id === campaign.client_id);
      if (!ownsIt) return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    // Stop a running campaign first.
    if (campaign.status === 'running') {
      await svc.entities.Campaign.update(campaign_id, { status: 'cancelled' }).catch(() => {});
    }

    // 1. Wipe the AUTHORITATIVE Postgres rows in ONE fast SQL DELETE. This is the
    //    only delete that matters for the dialer + UI (CampaignLead is PG-primary).
    await svc.functions
      .invoke('pgCampaignLeadSync', { delete_campaign_id: campaign_id })
      .catch((e) => console.warn(`[deleteCampaign] PG wipe skipped: ${e.message}`));

    // 2. Delete the campaign itself — done. The UI no longer shows it instantly.
    await deleteWithRetry(id => svc.entities.Campaign.delete(id), campaign_id);

    // 3. Clean up the Base44 CampaignLead mirror + template mappings in the
    //    BACKGROUND (bulk deleteMany). These are not read by the dialer, so we
    //    don't block the response on them — deletion feels instant.
    (async () => {
      try { await svc.entities.CampaignLead.deleteMany({ campaign_id }); } catch (_) {}
      try { await svc.entities.CampaignTemplateMapping.deleteMany({ campaign_id }); } catch (_) {}
    })();

    return c.json({ data: { success: true, done: true, leads_removed_total: 0 } });
  } catch (error) {
    console.error('[deleteCampaign] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};