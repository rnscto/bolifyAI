import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// enrollWhatsAppCampaignRecipients — Build the recipient queue for a
// WhatsAppCampaign based on its audience config.
//
// Payload: { campaign_id }
// Returns: { success, enrolled, skipped_no_phone, skipped_unsubscribed, skipped_already_enrolled }
// ═══════════════════════════════════════════════════════════════════



function normalizePhone(raw) {
  if (!raw) return '';
  let n = String(raw).replace(/[^0-9]/g, '');
  if (n.length === 10) n = '91' + n;
  else if (n.length === 11 && n.startsWith('0')) n = '91' + n.substring(1);
  return n;
}

export default async function enrollWhatsAppCampaignRecipients(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const me = c.get('jwtPayload');
    if (!me) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const svc = client.asServiceRole;
    const { campaign_id } = await c.req.json();
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const campaign = await svc.entities.WhatsAppCampaign.get(campaign_id);
    if (!campaign) return c.json({ data: { error: 'Campaign not found' } }, 404);

    // Ownership check
    if (me.role !== 'admin') {
      const myClients = await svc.entities.Client.filter({ user_id: me.id });
      if (myClients[0]?.id !== campaign.client_id) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const audience = campaign.audience || {};
    const includeAll = !!audience.include_all_leads;

    // Paginate leads
    const leads = [];
    let page = 0;
    const pageSize = 200;
    while (true) {
      const batch = await svc.entities.Lead.filter(
        { client_id: campaign.client_id }, '-created_date', pageSize, page * pageSize
      );
      if (!batch.length) break;
      leads.push(...batch);
      if (batch.length < pageSize) break;
      page++;
      if (page > 100) break; // 20k cap
    }

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

    const [unsubs, existing] = await Promise.all([
      svc.entities.WhatsAppUnsubscribe.filter({ client_id: campaign.client_id }).catch(() => []),
      svc.entities.WhatsAppCampaignRecipient.filter({ campaign_id }).catch(() => [])
    ]);
    const unsubSet = new Set(unsubs.map(u => normalizePhone(u.recipient_phone)));
    const existingSet = new Set(existing.map(r => normalizePhone(r.recipient_phone) + '|' + r.lead_id));

    let enrolled = 0, skippedNoPhone = 0, skippedUnsubbed = 0, skippedDupe = 0;
    const toCreate = [];

    for (const lead of pool) {
      const phone = normalizePhone(lead.phone);
      if (!phone || phone.length < 10) { skippedNoPhone++; continue; }
      if (unsubSet.has(phone)) { skippedUnsubbed++; continue; }
      const key = phone + '|' + lead.id;
      if (existingSet.has(key)) { skippedDupe++; continue; }

      toCreate.push({
        campaign_id,
        client_id: campaign.client_id,
        lead_id: lead.id,
        recipient_phone: phone,
        lead_name: lead.name || '',
        status: 'queued',
        attempt_count: 0
      });
      enrolled++;
    }

    for (let i = 0; i < toCreate.length; i += 100) {
      const chunk = toCreate.slice(i, i + 100);
      await svc.entities.WhatsAppCampaignRecipient.bulkCreate(chunk).catch(e => {
        console.warn('[enrollWhatsAppCampaignRecipients] bulk create chunk failed:', e.message);
      });
    }

    const newTotal = existing.length + enrolled;
    const stats = campaign.stats || {};
    await svc.entities.WhatsAppCampaign.update(campaign_id, {
      total_recipients: newTotal,
      stats: {
        ...stats,
        queued: (stats.queued || 0) + enrolled,
        skipped_unsubscribed: (stats.skipped_unsubscribed || 0) + skippedUnsubbed,
        skipped_no_phone: (stats.skipped_no_phone || 0) + skippedNoPhone
      }
    });

    return c.json({ data: {
      success: true,
      enrolled,
      skipped_no_phone: skippedNoPhone,
      skipped_unsubscribed: skippedUnsubbed,
      skipped_already_enrolled: skippedDupe,
      total_recipients: newTotal
    } });
  } catch (error) {
    console.error('[enrollWhatsAppCampaignRecipients] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};