import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// enrollEmailCampaignRecipients — Build the recipient queue for an
// EmailCampaign based on its audience config. Called when the campaign
// is started (status: draft/scheduled → running) or re-synced.
//
// Payload: { campaign_id }
// Returns: { success, enrolled, skipped_no_email, skipped_unsubscribed }
// ═══════════════════════════════════════════════════════════════════



export default async function enrollEmailCampaignRecipients(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const me = c.get('jwtPayload');
    if (!me) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const svc = client.asServiceRole;
    const { campaign_id } = await c.req.json();
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const campaign = await svc.entities.EmailCampaign.get(campaign_id);
    if (!campaign) return c.json({ data: { error: 'Campaign not found' } }, 404);

    // Ownership check (clients can only enroll their own)
    if (me.role !== 'admin') {
      const myClients = await svc.entities.Client.filter({ user_id: me.id });
      if (myClients[0]?.id !== campaign.client_id) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const audience = campaign.audience || {};
    const includeAll = !!audience.include_all_leads;

    // Fetch leads via pagination
    const leads = [];
    let page = 0;
    const pageSize = 200;
    while (true) {
      const filter = { client_id: campaign.client_id };
      const batch = await svc.entities.Lead.filter(filter, '-created_date', pageSize, page * pageSize);
      if (!batch.length) break;
      leads.push(...batch);
      if (batch.length < pageSize) break;
      page++;
      if (page > 100) break; // hard safety cap at 20k leads
    }

    // Apply filters
    let pool = leads;
    if (!includeAll) {
      if (Array.isArray(audience.group_ids) && audience.group_ids.length > 0) {
        pool = pool.filter(l => Array.isArray(l.group_ids) && l.group_ids.some(g => audience.group_ids.includes(g)));
      }
      if (Array.isArray(audience.status_filter) && audience.status_filter.length > 0) {
        pool = pool.filter(l => audience.status_filter.includes(l.status));
      }
      if (Array.isArray(audience.tier_filter) && audience.tier_filter.length > 0) {
        pool = pool.filter(l => audience.tier_filter.includes(l.qualification_tier));
      }
    }

    // Load unsubscribe + existing-recipient sets
    const [unsubs, existing] = await Promise.all([
      svc.entities.EmailUnsubscribe.filter({ client_id: campaign.client_id }).catch(() => []),
      svc.entities.EmailCampaignRecipient.filter({ campaign_id }).catch(() => [])
    ]);
    const unsubSet = new Set(unsubs.map(u => (u.recipient_email || '').toLowerCase()));
    const existingSet = new Set(existing.map(r => (r.recipient_email || '').toLowerCase() + '|' + r.lead_id));

    let enrolled = 0, skippedNoEmail = 0, skippedUnsubbed = 0, skippedDupe = 0;
    const toCreate = [];

    for (const lead of pool) {
      const email = (lead.email || '').trim().toLowerCase();
      if (!email) { skippedNoEmail++; continue; }
      if (unsubSet.has(email)) { skippedUnsubbed++; continue; }
      const dedupeKey = email + '|' + lead.id;
      if (existingSet.has(dedupeKey)) { skippedDupe++; continue; }

      toCreate.push({
        campaign_id,
        client_id: campaign.client_id,
        lead_id: lead.id,
        recipient_email: lead.email,
        lead_name: lead.name || '',
        status: 'queued',
        attempt_count: 0
      });
      enrolled++;
    }

    // Bulk create in chunks of 100
    for (let i = 0; i < toCreate.length; i += 100) {
      const chunk = toCreate.slice(i, i + 100);
      await svc.entities.EmailCampaignRecipient.bulkCreate(chunk).catch(e => {
        console.warn('[enrollEmailCampaignRecipients] bulk create chunk failed:', e.message);
      });
    }

    // Update campaign totals
    const newTotal = (existing.length + enrolled);
    const stats = campaign.stats || {};
    await svc.entities.EmailCampaign.update(campaign_id, {
      total_recipients: newTotal,
      stats: {
        ...stats,
        queued: (stats.queued || 0) + enrolled,
        skipped_unsubscribed: (stats.skipped_unsubscribed || 0) + skippedUnsubbed,
        skipped_no_email: (stats.skipped_no_email || 0) + skippedNoEmail
      }
    });

    return c.json({ data: {
      success: true,
      enrolled,
      skipped_no_email: skippedNoEmail,
      skipped_unsubscribed: skippedUnsubbed,
      skipped_already_enrolled: skippedDupe,
      total_recipients: newTotal
    } });
  } catch (error) {
    console.error('[enrollEmailCampaignRecipients] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};