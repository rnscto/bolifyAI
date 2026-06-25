import { base44ORM as base44 } from "../db/orm.ts";
import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

export default async function executeCampaign(c: any) {
  try {
    const payload = await c.req.json();
    const { campaign_id, action, _internal } = payload;
    
    if (!campaign_id) return c.json({ data: { error: 'campaign_id required' } }, 400);

    const campaign = await base44.entities.Campaign.get(campaign_id);
    if (!campaign) return c.json({ data: { error: 'Campaign not found' } }, 404);

    if (action === 'pause') {
      await base44.entities.Campaign.update(campaign_id, { status: 'paused' });
      return c.json({ data: { success: true, status: 'paused' } });
    }
    if (action === 'cancel') {
      await base44.entities.Campaign.update(campaign_id, { status: 'cancelled' });
      return c.json({ data: { success: true, status: 'cancelled' } });
    }

    // TRAI Window (9 AM to 9 PM IST)
    const istMs = Date.now() + (5 * 60 + 30) * 60 * 1000;
    const istDate = new Date(istMs);
    const istHour = istDate.getUTCHours();
    if (istHour < 9 || istHour >= 21) {
      await base44.entities.Campaign.update(campaign_id, { status: 'paused' });
      return c.json({ data: { error: 'trai_window_closed', message: "Calling allowed only between 9 AM and 9 PM IST. Campaign auto-paused." } });
    }

    if (['completed', 'cancelled'].includes(campaign.status)) {
      return c.json({ data: { success: true, skipped: `campaign_${campaign.status}` } });
    }

    // Billing Check
    const clientData = await base44.entities.Client.get(campaign.client_id);
    if (clientData && clientData.billing_type !== 'unlimited') {
      const freeMinutes = clientData.free_minutes_remaining || 0;
      const walletBalance = clientData.wallet_balance || 0;
      if (freeMinutes <= 0 && walletBalance < 100) {
        return c.json({ data: { error: 'insufficient_balance', message: 'Insufficient balance. Minimum ₹100 required.' } });
      }
    }

    await base44.entities.Campaign.update(campaign_id, {
      status: 'running',
      started_at: campaign.started_at || new Date().toISOString()
    });

    const agent = await base44.entities.Agent.get(campaign.agent_id);
    if (!agent) {
      await base44.entities.Campaign.update(campaign_id, { status: 'draft' });
      return c.json({ data: { error: 'Agent not found' } });
    }

    const callerId = (agent.assigned_dids?.length > 0) ? agent.assigned_dids[0] : agent.assigned_did;
    if (!callerId) {
      return c.json({ data: { error: 'Agent has no assigned DID' } });
    }

    const smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    if (!smartfloApiKey) {
      return c.json({ data: { error: 'No SMARTFLO_API_KEY configured' } });
    }

    const maxConcurrent = campaign.max_concurrent_calls || 5;
    const currentlyCalling = await base44.entities.CampaignLead.filter({ campaign_id, status: 'calling' }, 'created_at', maxConcurrent);
    const slotsAvailable = Math.max(0, maxConcurrent - currentlyCalling.length);

    if (slotsAvailable === 0) {
      return c.json({ data: { success: true, message: 'All slots occupied', currently_calling: currentlyCalling.length } });
    }

    const pendingLeads = await base44.entities.CampaignLead.filter({ campaign_id, status: 'pending' }, 'created_at', slotsAvailable);
    
    if (pendingLeads.length === 0) {
      // Check if campaign is completely done
      if (currentlyCalling.length === 0) {
         await base44.entities.Campaign.update(campaign_id, { status: 'completed', completed_at: new Date().toISOString() });
         return c.json({ data: { success: true, status: 'completed' } });
      }
      return c.json({ data: { success: true, message: 'No ready leads' } });
    }

    const results = { initiated: 0, failed: 0, errors: [] as any[] };

    for (const cl of pendingLeads) {
      try {
        const callee10 = (cl.lead_phone || '').replace(/[^0-9]/g, '').slice(-10);
        if (!/^[6-9]\d{9}$/.test(callee10)) {
           await base44.entities.CampaignLead.update(cl.id, { status: 'completed', outcome: 'do_not_call', conversation_summary: 'Invalid phone' });
           continue;
        }

        await base44.entities.CampaignLead.update(cl.id, { status: 'calling', attempt_count: (cl.attempt_count || 0) + 1 });

        const callLog = await base44.entities.CallLog.create({
          client_id: campaign.client_id, 
          agent_id: campaign.agent_id, 
          lead_id: cl.lead_id,
          caller_id: callerId, 
          callee_number: callee10,
          direction: 'outbound', 
          status: 'initiated', 
          call_start_time: new Date().toISOString(),
        });

        await base44.entities.CampaignLead.update(cl.id, { call_log_id: callLog.id });

        const smartfloResp = await triggerSmartfloOutboundCall({
          smartfloApiKey,
          calleeNumber: '91' + callee10,
          callerId: callerId,
          callLogId: callLog.id
        });

        if (!smartfloResp.success) {
           await base44.entities.CallLog.update(callLog.id, { status: 'failed' });
           await base44.entities.CampaignLead.update(cl.id, { status: 'completed', outcome: 'not_answered', conversation_summary: smartfloResp.message });
           results.failed++;
           results.errors.push({ lead: cl.lead_phone, error: smartfloResp.message });
        } else {
           await base44.entities.CallLog.update(callLog.id, { call_sid: smartfloResp.call_sid, status: 'ringing' });
           results.initiated++;
        }
      } catch (err: any) {
        results.failed++;
        results.errors.push({ lead: cl.lead_phone, error: err.message });
      }
    }

    return c.json({ data: { success: true, ...results } });

  } catch (error: any) {
    return c.json({ data: { error: error.message } }, 500);
  }
}
