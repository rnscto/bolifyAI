import { createClient } from 'npm:@base44/sdk@0.8.18';

// This function runs every 5 minutes as a SCHEDULED AUTOMATION to:
// 1. Fix stuck "calling" leads (calls that never got a webhook callback)
// 2. Automatically trigger next batch of calls for running campaigns
// 3. Auto-complete campaigns when all leads are processed
//
// NOTE: Scheduled automations have NO user auth context.
// We use service role directly (no admin check needed — only platform scheduler can invoke this).

Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = createClient({ appId, asServiceRole: true });
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
          const STUCK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

          if (leadAge < STUCK_TIMEOUT_MS) continue; // Still fresh, skip

          if (cl.call_log_id) {
            try {
              const callLog = await svc.entities.CallLog.get(cl.call_log_id);
              const terminalStatuses = ['completed', 'failed', 'no_answer'];

              if (callLog && terminalStatuses.includes(callLog.status)) {
                let outcome = 'contacted';
                if (callLog.status === 'no_answer' || callLog.status === 'failed') outcome = 'no_answer';
                if (callLog.transcript && callLog.transcript.length > 30) outcome = 'contacted';

                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'completed', outcome,
                  conversation_summary: callLog.conversation_summary || 'Call completed (recovered by poller)',
                  transcript: callLog.transcript || '',
                  call_duration: callLog.duration || 0
                });
                console.log(`[campaignPoller] Fixed stuck lead ${cl.lead_name}: CallLog was ${callLog.status} → outcome=${outcome}`);
                results.stuck_fixed++;
              } else {
                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'completed', outcome: 'no_answer',
                  conversation_summary: 'Call timed out — no response from telephony provider.'
                });
                if (cl.call_log_id) {
                  await svc.entities.CallLog.update(cl.call_log_id, {
                    status: 'no_answer', call_end_time: new Date().toISOString(),
                    conversation_summary: 'Call timed out — no Smartflo webhook callback received.'
                  });
                }
                console.log(`[campaignPoller] Timed out stuck lead ${cl.lead_name} (${cl.lead_phone})`);
                results.stuck_fixed++;
              }
            } catch (e) {
              console.error(`[campaignPoller] Error fixing lead ${cl.lead_name}: ${e.message}`);
            }
          } else {
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

        const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
        allLeads.forEach(l => {
          if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++;
        });
        await svc.entities.Campaign.update(campaignId, {
          calls_completed: completedCount, calls_failed: failedCount, outcomes_summary: outcomes
        });

        if (pendingCount === 0 && callingCount === 0) {
          await svc.entities.Campaign.update(campaignId, {
            status: 'completed', completed_at: new Date().toISOString()
          });
          console.log(`[campaignPoller] Campaign "${campaign.name}" completed: ${completedCount} done, ${failedCount} failed`);
          results.completed++;
          continue;
        }

        // === STEP 3: Trigger next batch INLINE (no cross-function invoke) ===
        const maxConcurrent = campaign.max_concurrent_calls || 5;
        if (pendingCount > 0 && callingCount < maxConcurrent) {
          console.log(`[campaignPoller] Campaign "${campaign.name}": ${pendingCount} pending, ${callingCount} calling — triggering next batch`);
          try {
            const agent = await svc.entities.Agent.get(campaign.agent_id);
            const agentDIDs = (agent?.assigned_dids?.length > 0)
              ? agent.assigned_dids
              : (agent?.assigned_did ? [agent.assigned_did] : []);

            if (!agent || agentDIDs.length === 0) {
              console.log(`[campaignPoller] Agent has no DIDs for "${campaign.name}"`);
              continue;
            }

            let kbContent = '';
            if (agent.knowledge_base_ids?.length > 0) {
              for (const kbId of agent.knowledge_base_ids) {
                try {
                  const doc = await svc.entities.KnowledgeBase.get(kbId);
                  if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
                } catch (_) {}
              }
            }

            const slotsAvailable = Math.max(0, maxConcurrent - callingCount);
            const pendingBatch = await svc.entities.CampaignLead.filter(
              { campaign_id: campaignId, status: 'pending' }, 'created_date', slotsAvailable
            );

            for (let i = 0; i < pendingBatch.length; i++) {
              const cl = pendingBatch[i];
              try {
                const selectedDID = agentDIDs[i % agentDIDs.length];
                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
                });

                const cleanPhone = (cl.lead_phone || '').replace(/[^0-9]/g, '');
                const callSid = `camp_${campaignId.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

                let leadContext = '';
                try {
                  const ctxRes = await svc.functions.invoke('buildLeadContext', {
                    lead_id: cl.lead_id, client_id: campaign.client_id, phone_number: cl.lead_phone
                  });
                  if (ctxRes?.context_text) leadContext = ctxRes.context_text;
                } catch (_) {}

                const personalizedPrompt = [
                  agent.system_prompt || '',
                  campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
                  campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
                  campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
                  campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
                  leadContext ? `\n\n--- LEAD CONTEXT ---\n${leadContext}` : ''
                ].filter(Boolean).join('\n');

                const callLog = await svc.entities.CallLog.create({
                  client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
                  call_sid: callSid, caller_id: selectedDID, callee_number: cl.lead_phone,
                  direction: 'outbound', status: 'initiated', call_start_time: new Date().toISOString(),
                  agent_config_cache: {
                    agent_name: agent.name, system_prompt: personalizedPrompt,
                    persona: agent.persona || {}, knowledge_base_content: kbContent,
                    lead_context: leadContext
                  }
                });

                await svc.entities.CampaignLead.update(cl.id, { call_log_id: callLog.id });

                const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    api_key: Deno.env.get('SMARTFLO_API_KEY'),
                    customer_number: cleanPhone,
                    caller_id: selectedDID.replace(/^\+/, ''),
                    async: 1
                  })
                });

                const smartfloData = await smartfloResp.json();
                if (smartfloResp.ok && smartfloData.success !== false) {
                  const newCallSid = smartfloData.call_id || smartfloData.call_sid || callSid;
                  await svc.entities.CallLog.update(callLog.id, { call_sid: newCallSid, status: 'ringing' });
                  console.log(`[campaignPoller] Call initiated: ${cl.lead_name} → ${cleanPhone}`);
                } else {
                  await svc.entities.CallLog.update(callLog.id, { status: 'failed' });
                  await svc.entities.CampaignLead.update(cl.id, {
                    status: 'completed', outcome: 'no_answer',
                    conversation_summary: `Smartflo error: ${smartfloData.message || 'Unknown'}`
                  });
                }

                if (i < pendingBatch.length - 1) await new Promise(r => setTimeout(r, 500));
              } catch (e) {
                console.error(`[campaignPoller] Call error for ${cl.lead_name}: ${e.message}`);
                await svc.entities.CampaignLead.update(cl.id, {
                  status: 'completed', outcome: 'no_answer',
                  conversation_summary: `Error: ${e.message}`
                });
              }
            }

            results.batches_triggered++;
            console.log(`[campaignPoller] Triggered ${pendingBatch.length} calls for "${campaign.name}"`);
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