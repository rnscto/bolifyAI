import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Populates CampaignLead rows for a BFSI campaign by filtering the relevant
 * source entity (LoanAccount for collections/bounce, VerificationCase for TVR,
 * ReferenceCheck for RCU) according to the campaign's bfsi_case_type tag in
 * notes.
 *
 * Called by the BFSI Campaigns page right before the user clicks "Start" so
 * the campaign engine has rows to dial. Idempotent — skips rows already added
 * to the campaign.
 *
 * Input:  { campaign_id }
 * Output: { success, added, total }
 */

const BUCKETS = {
  soft_collections:   (la) => (la.dpd_days || 0) >= 1 && (la.dpd_days || 0) <= 30,
  hard_collections:   (la) => (la.dpd_days || 0) >= 31 && (la.dpd_days || 0) <= 90,
  legal_notice_pre:   (la) => (la.dpd_days || 0) >= 90,
  settlement:         (la) => la.bucket === 'npa' || la.status === 'written_off',
  mandate_bounce:     (la) => la.status === 'under_collection' || la.bucket === 'bucket_0',
};

export default async function loadBfsiCampaignAudience(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { campaign_id } = await c.req.json();
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const svc = base44.asServiceRole;
    const campaign = await svc.entities.Campaign.get(campaign_id);
    if (!campaign) return c.json({ data: { error: 'Campaign not found' } }, 404);

    // Ownership check
    if (user.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (!clients.map(c => c.id).includes(campaign.client_id)) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    // Extract bfsi subtype from notes ("BFSI:soft_collections • ..." pattern)
    const notes = campaign.notes || '';
    if (!notes.startsWith('BFSI:')) {
      return c.json({ data: { error: 'Not a BFSI campaign' } }, 400);
    }
    const subtype = notes.replace('BFSI:', '').split('•')[0].trim();

    // Existing campaign leads to avoid duplicates
    const existing = await svc.entities.CampaignLead.filter({ campaign_id }, 'created_date', 500);
    const existingPhones = new Set(existing.map(r => String(r.lead_phone || '').replace(/[^0-9]/g, '').slice(-10)));

    // A record is only callable if its phone has at least 7 digits — skip blanks.
    const hasPhone = (p) => String(p || '').replace(/\D/g, '').length >= 7;

    let candidates = [];
    let sourceType = 'loan_account';

    // ─── Branch by subtype ───
    if (BUCKETS[subtype]) {
      const accounts = await svc.entities.LoanAccount.filter(
        { client_id: campaign.client_id }, '-updated_date', 500
      );
      candidates = accounts
        .filter(BUCKETS[subtype])
        .filter(a => hasPhone(a.phone))
        .filter(a => !existingPhones.has(String(a.phone || '').replace(/[^0-9]/g, '').slice(-10)))
        .map(a => ({
          campaign_id,
          client_id: campaign.client_id,
          lead_id: a.id, // store loan_account id in lead_id slot
          status: 'pending',
          lead_name: a.customer_name || a.loan_id,
          lead_phone: a.phone,
        }));
    } else if (subtype === 'tvr_verification') {
      sourceType = 'verification_case';
      const cases = await svc.entities.VerificationCase.filter(
        { client_id: campaign.client_id, verification_status: 'pending' }, '-created_date', 500
      );
      candidates = cases
        .filter(c => hasPhone(c.phone))
        .filter(c => !existingPhones.has(String(c.phone || '').replace(/[^0-9]/g, '').slice(-10)))
        .map(c => ({
          campaign_id,
          client_id: campaign.client_id,
          lead_id: c.id,
          status: 'pending',
          lead_name: c.applicant_name || c.application_id,
          lead_phone: c.phone,
        }));
    } else if (subtype === 'rcu_reference') {
      sourceType = 'reference_check';
      const refs = await svc.entities.ReferenceCheck.filter(
        { client_id: campaign.client_id, status: 'pending' }, '-created_date', 500
      );
      candidates = refs
        .filter(r => hasPhone(r.reference_phone))
        .filter(r => !existingPhones.has(String(r.reference_phone || '').replace(/[^0-9]/g, '').slice(-10)))
        .map(r => ({
          campaign_id,
          client_id: campaign.client_id,
          lead_id: r.id,
          status: 'pending',
          lead_name: r.reference_name || `Ref for ${r.applicant_name || r.application_id}`,
          lead_phone: r.reference_phone,
        }));
    } else {
      return c.json({ data: { error: `Unsupported BFSI subtype: ${subtype}` } }, 400);
    }

    // Insert in chunks of 500
    const CHUNK = 500;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      await svc.entities.CampaignLead.bulkCreate(candidates.slice(i, i + CHUNK));
    }

    // Update campaign total
    const newTotal = (campaign.total_leads || 0) + candidates.length;
    await svc.entities.Campaign.update(campaign_id, { total_leads: newTotal });

    console.log(`[loadBfsiCampaignAudience] subtype=${subtype} source=${sourceType} added=${candidates.length}`);
    return c.json({ data: {
      success: true,
      added: candidates.length,
      total: newTotal,
      source_type: sourceType,
      subtype,
    } });
  } catch (error) {
    console.error('[loadBfsiCampaignAudience] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};