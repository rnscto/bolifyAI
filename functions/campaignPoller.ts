import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

// This function runs every 5 minutes to:
// 1. Fix stuck "calling" leads (calls that never got a webhook callback)
// 2. Automatically trigger next batch of calls for running campaigns
// 3. Auto-complete campaigns when all leads are processed

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const svc = base44.asServiceRole;
    const results = { campaigns_processed: 0, stuck_fixed: 0, batches_triggered: 0, completed: 0, errors: [] };

    // Find all running campaigns
    const runningCampaigns = await svc.entities.Campaign.filter({ status: 'running' });
    console.log(`[campaignPoller] Found ${runningCampaigns.length} running campaigns`);

    for (const campaign of runningCampaigns) {
      try {
        results.campaigns_processed++;
        const campaignId = campaign.id;

        // === STEP 1: Fix stuck "calling" leads ===
        const stuckLeads = await svc.entities.CampaignLead.filter(
          { campaign_id: campaignId, status: 'calling' }, 'created_date', 100
        );

        for (const cl of stuckLeads) {
          const leadAge = Date.now() - new Date(cl.updated_date || cl.created_date).getTime();
          const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

          if (leadAge < STUCK_TIMEOUT_MS) continue; // Still fresh, skip

          // Check if the associated CallLog has a terminal status
          if (cl.call_log_id) {
            try {
              const callLog = await svc.entities.CallLog.get(cl.call_log_id);
              const terminalStatuses = ['completed', 'failed', 'no_answer'];

              if (callLog && terminalStatuses.includes(callLog.status)) {
                // CallLog finished but CampaignLead wasn't updated — fix it
                let outcome = 'contacted';
                if (callLog.status === 'no_answer' || callLog.status === 'failed') outcome = 'no_answer';
                if (callLog.transcript && callLog.transcript.length > 30) outcome = 'contacted';

                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'completed',
                  outcome,
                  conversation_summary: callLog.conversation_summary || 'Call completed (recovered by poller)',
                  transcript: callLog.transcript || '',
                  call_duration: callLog.duration || 0
                });
                console.log(`[campaignPoller] Fixed stuck lead ${cl.lead_name}: CallLog was ${callLog.status} → outcome=${outcome}`);
                results.stuck_fixed++;
              } else {
                // CallLog still ringing/initiated after 5+ min — mark as no_answer
                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'completed',
                  outcome: 'no_answer',
                  conversation_summary: 'Call timed out — no response from telephony provider within 5 minutes.'
                });
                if (cl.call_log_id) {
                  await svc.entities.CallLog.update(cl.call_log_id, {
                    status: 'no_answer',
                    call_end_time: new Date().toISOString(),
                    conversation_summary: 'Call timed out — no Smartflo webhook callback received within 5 minutes.'
                  });
                }
                console.log(`[campaignPoller] Timed out stuck lead ${cl.lead_name} (${cl.lead_phone})`);
                results.stuck_fixed++;
              }
            } catch (e) {
              console.error(`[campaignPoller] Error fixing lead ${cl.lead_name}: ${e.message}`);
            }
          } else {
            // No call_log_id at all — reset to pending
            await svc.entities.CampaignLead.update(cl.id, { status: 'pending', call_log_id: null });
            console.log(`[campaignPoller] Reset orphan lead ${cl.lead_name} to pending`);
            results.stuck_fixed++;
          }
        }

        // === STEP 2: Check if campaign should be completed ===
        const allLeads = await svc.entities.CampaignLead.filter({ campaign_id: campaignId });
        const pendingCount = allLeads.filter(l => l.status === 'pending').length;
        const callingCount = allLeads.filter(l => l.status === 'calling').length;
        const completedCount = allLeads.filter(l => l.status === 'completed').length;
        const failedCount = allLeads.filter(l => l.status === 'failed').length;

        // Update campaign counters
        const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
        allLeads.forEach(l => {
          if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++;
        });
        await svc.entities.Campaign.update(campaignId, {
          calls_completed: completedCount,
          calls_failed: failedCount,
          outcomes_summary: outcomes
        });

        if (pendingCount === 0 && callingCount === 0) {
          // All done
          await svc.entities.Campaign.update(campaignId, {
            status: 'completed',
            completed_at: new Date().toISOString()
          });
          console.log(`[campaignPoller] Campaign "${campaign.name}" completed: ${completedCount} done, ${failedCount} failed`);
          results.completed++;
          continue;
        }

        // === STEP 3: Trigger next batch if slots available ===
        if (pendingCount > 0 && callingCount < (campaign.max_concurrent_calls || 5)) {
          console.log(`[campaignPoller] Campaign "${campaign.name}": ${pendingCount} pending, ${callingCount} calling — triggering next batch`);
          try {
            await svc.functions.invoke('executeCampaign', {
              campaign_id: campaignId,
              action: 'start',
              _internal: true
            });
            results.batches_triggered++;
          } catch (e) {
            console.error(`[campaignPoller] Failed to trigger batch for "${campaign.name}": ${e.message}`);
            results.errors.push({ campaign: campaign.name, error: e.message });
          }
        } else {
          console.log(`[campaignPoller] Campaign "${campaign.name}": ${pendingCount} pending, ${callingCount} calling — waiting for slots`);
        }
      } catch (e) {
        console.error(`[campaignPoller] Error processing campaign "${campaign.name}": ${e.message}`);
        results.errors.push({ campaign: campaign.name, error: e.message });
      }
    }

    return Response.json({ success: true, ...results });
  } catch (error) {
    console.error('[campaignPoller] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});