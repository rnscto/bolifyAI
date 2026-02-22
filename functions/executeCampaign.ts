import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { campaign_id, action } = await req.json();
    if (!campaign_id) return Response.json({ error: 'campaign_id required' }, { status: 400 });

    const campaign = await base44.asServiceRole.entities.Campaign.get(campaign_id);
    if (!campaign) return Response.json({ error: 'Campaign not found' }, { status: 404 });

    // Ownership check
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    const clientIds = clients.map(c => c.id);
    if (!clientIds.includes(campaign.client_id)) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Handle pause/resume/cancel
    if (action === 'pause') {
      await base44.asServiceRole.entities.Campaign.update(campaign_id, { status: 'paused' });
      return Response.json({ success: true, status: 'paused' });
    }
    if (action === 'cancel') {
      await base44.asServiceRole.entities.Campaign.update(campaign_id, { status: 'cancelled' });
      return Response.json({ success: true, status: 'cancelled' });
    }

    // Start or resume campaign
    await base44.asServiceRole.entities.Campaign.update(campaign_id, {
      status: 'running',
      started_at: campaign.started_at || new Date().toISOString()
    });

    const agent = await base44.asServiceRole.entities.Agent.get(campaign.agent_id);
    const agentDIDs = (agent?.assigned_dids && agent.assigned_dids.length > 0)
      ? agent.assigned_dids
      : (agent?.assigned_did ? [agent.assigned_did] : []);
    if (!agent || agentDIDs.length === 0) {
      await base44.asServiceRole.entities.Campaign.update(campaign_id, { status: 'draft' });
      return Response.json({ error: 'Agent has no assigned DID' }, { status: 400 });
    }

    // Pre-fetch knowledge base content for agent config cache
    let kbContent = '';
    if (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await base44.asServiceRole.entities.KnowledgeBase.get(kbId);
          if (doc && doc.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
        } catch (e) {
          console.log(`KB doc ${kbId} fetch failed: ${e.message}`);
        }
      }
    }

    const maxConcurrent = campaign.max_concurrent_calls || 5;
    const totalResults = { initiated: 0, failed: 0, errors: [], batches: 0 };

    // First, fix any stuck 'calling' leads from previous runs
    // (leads that were set to 'calling' but their calls ended without updating CampaignLead)
    const stuckLeads = await base44.asServiceRole.entities.CampaignLead.filter(
      { campaign_id: campaign_id, status: 'calling' }, 'created_date', 100
    );
    for (const stuckLead of stuckLeads) {
      try {
        if (stuckLead.call_log_id) {
          const callLog = await base44.asServiceRole.entities.CallLog.get(stuckLead.call_log_id);
          const terminalStatuses = ['completed', 'failed', 'no_answer'];
          if (callLog && terminalStatuses.includes(callLog.status)) {
            // Call already finished — determine outcome
            let outcome = 'contacted';
            if (callLog.status === 'no_answer' || callLog.status === 'failed') {
              outcome = 'no_answer';
            } else if (callLog.transcript || callLog.conversation_summary) {
              try {
                const analysis = await base44.asServiceRole.integrations.Core.InvokeLLM({
                  prompt: `Analyze this call briefly. TRANSCRIPT: ${callLog.transcript || 'N/A'}\nSUMMARY: ${callLog.conversation_summary || 'N/A'}\nDetermine outcome: "interested","not_interested","callback","no_answer","converted","contacted"`,
                  response_json_schema: { type: "object", properties: { outcome: { type: "string" }, summary: { type: "string" } } }
                });
                outcome = analysis.outcome || 'contacted';
              } catch (e) { /* use default */ }
            }
            await base44.asServiceRole.entities.CampaignLead.update(stuckLead.id, {
              status: 'completed',
              outcome: outcome,
              conversation_summary: callLog.conversation_summary || '',
              transcript: callLog.transcript || '',
              call_duration: callLog.duration || 0
            });
            console.log(`[campaign] Fixed stuck lead ${stuckLead.lead_name}: ${outcome}`);
            // Also update the Lead entity
            if (stuckLead.lead_id) {
              const leadStatusMap = { interested: 'interested', not_interested: 'not_interested', callback: 'callback', no_answer: 'callback', converted: 'converted', contacted: 'contacted' };
              await base44.asServiceRole.entities.Lead.update(stuckLead.lead_id, {
                status: leadStatusMap[outcome] || 'contacted',
                last_call_date: new Date().toISOString()
              });
            }
          } else {
            // Call didn't finish or no callLog — reset to pending for retry
            await base44.asServiceRole.entities.CampaignLead.update(stuckLead.id, { status: 'pending', call_log_id: null });
            console.log(`[campaign] Reset stuck lead ${stuckLead.lead_name} to pending`);
          }
        } else {
          // No call_log_id — reset to pending
          await base44.asServiceRole.entities.CampaignLead.update(stuckLead.id, { status: 'pending', call_log_id: null });
          console.log(`[campaign] Reset stuck lead ${stuckLead.lead_name} (no call_log) to pending`);
        }
      } catch (stuckErr) {
        console.error(`[campaign] Error fixing stuck lead ${stuckLead.id}:`, stuckErr.message);
      }
    }
    if (stuckLeads.length > 0) {
      console.log(`[campaign] Fixed ${stuckLeads.length} stuck 'calling' leads`);
    }

    // Process ALL pending leads in batches
    let hasMore = true;
    while (hasMore) {
      // Re-check campaign status each batch (user may have paused/cancelled)
      const currentCampaign = await base44.asServiceRole.entities.Campaign.get(campaign_id);
      if (currentCampaign.status !== 'running') {
        console.log(`[campaign] Campaign status changed to ${currentCampaign.status}, stopping.`);
        break;
      }

      // Get next batch of pending leads
      const pendingLeads = await base44.asServiceRole.entities.CampaignLead.filter(
        { campaign_id: campaign_id, status: 'pending' }, 'created_date', maxConcurrent
      );

      if (pendingLeads.length === 0) {
        // Check if any leads are still in 'calling' (calls in progress)
        const callingLeads = await base44.asServiceRole.entities.CampaignLead.filter(
          { campaign_id: campaign_id, status: 'calling' }, 'created_date', 1
        );
        if (callingLeads.length > 0) {
          console.log(`[campaign] No pending leads but ${callingLeads.length} still calling. Waiting...`);
          // Wait and retry — calls may still be in progress
          await new Promise(r => setTimeout(r, 15000));
          // After waiting, try to fix any stuck calling leads
          const stillCalling = await base44.asServiceRole.entities.CampaignLead.filter(
            { campaign_id: campaign_id, status: 'calling' }, 'created_date', 100
          );
          for (const stk of stillCalling) {
            try {
              if (stk.call_log_id) {
                const cl2 = await base44.asServiceRole.entities.CallLog.get(stk.call_log_id);
                const terms = ['completed', 'failed', 'no_answer'];
                if (cl2 && terms.includes(cl2.status)) {
                  let out = 'contacted';
                  if (cl2.status === 'no_answer' || cl2.status === 'failed') out = 'no_answer';
                  else if (cl2.transcript || cl2.conversation_summary) {
                    try {
                      const a = await base44.asServiceRole.integrations.Core.InvokeLLM({
                        prompt: `Analyze this call briefly. TRANSCRIPT: ${cl2.transcript || 'N/A'}\nSUMMARY: ${cl2.conversation_summary || 'N/A'}\nDetermine outcome: "interested","not_interested","callback","no_answer","converted","contacted"`,
                        response_json_schema: { type: "object", properties: { outcome: { type: "string" }, summary: { type: "string" } } }
                      });
                      out = a.outcome || 'contacted';
                    } catch(e) {}
                  }
                  await base44.asServiceRole.entities.CampaignLead.update(stk.id, {
                    status: 'completed', outcome: out,
                    conversation_summary: cl2.conversation_summary || '',
                    transcript: cl2.transcript || '',
                    call_duration: cl2.duration || 0
                  });
                  if (stk.lead_id) {
                    const lsm = { interested:'interested', not_interested:'not_interested', callback:'callback', no_answer:'callback', converted:'converted', contacted:'contacted' };
                    await base44.asServiceRole.entities.Lead.update(stk.lead_id, { status: lsm[out] || 'contacted', last_call_date: new Date().toISOString() });
                  }
                  console.log(`[campaign] Fixed in-flight lead ${stk.lead_name}: ${out}`);
                } else {
                  // Call still in progress or stuck without terminal status — mark failed
                  await base44.asServiceRole.entities.CampaignLead.update(stk.id, { status: 'failed', outcome: 'no_answer', conversation_summary: 'Call did not complete within expected time.' });
                  console.log(`[campaign] Timed out lead ${stk.lead_name}`);
                }
              } else {
                await base44.asServiceRole.entities.CampaignLead.update(stk.id, { status: 'failed', outcome: 'no_answer' });
              }
            } catch(e) { console.error(`[campaign] Fix in-flight error:`, e.message); }
          }
          continue; // re-check for pending leads
        }
        // All leads truly done — mark campaign completed
        await base44.asServiceRole.entities.Campaign.update(campaign_id, {
          status: 'completed',
          completed_at: new Date().toISOString()
        });
        hasMore = false;
        break;
      }

      totalResults.batches++;
      console.log(`[campaign] Processing batch ${totalResults.batches}, ${pendingLeads.length} leads`);

      // Initiate calls for this batch
      for (let i = 0; i < pendingLeads.length; i++) {
        const cl = pendingLeads[i];
        try {
          const selectedDID = agentDIDs[i % agentDIDs.length];

          await base44.asServiceRole.entities.CampaignLead.update(cl.id, {
            status: 'calling',
            attempt_count: (cl.attempt_count || 0) + 1
          });

          const cleanPhone = cl.lead_phone.replace(/[^0-9]/g, '');
          const callSid = `camp_${campaign_id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
          const callLog = await base44.asServiceRole.entities.CallLog.create({
            client_id: campaign.client_id,
            agent_id: campaign.agent_id,
            lead_id: cl.lead_id,
            call_sid: callSid,
            caller_id: selectedDID,
            callee_number: cl.lead_phone,
            direction: 'outbound',
            status: 'initiated',
            call_start_time: new Date().toISOString(),
            agent_config_cache: {
              agent_name: agent.name,
              system_prompt: agent.system_prompt || '',
              persona: agent.persona || {},
              knowledge_base_content: kbContent
            }
          });

          await base44.asServiceRole.entities.CampaignLead.update(cl.id, {
            call_log_id: callLog.id
          });

          const smartfloCallerID = selectedDID.replace(/^\+/, '');
          const smartfloPayload = {
            api_key: Deno.env.get('SMARTFLO_API_KEY'),
            customer_number: cleanPhone,
            caller_id: smartfloCallerID,
            async: 1
          };
          console.log(`[campaign] Smartflo payload: ${JSON.stringify(smartfloPayload)}`);
          const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(smartfloPayload)
          });

          const smartfloData = await smartfloResp.json();
          console.log(`[campaign] Call to ${cl.lead_phone}: ${JSON.stringify(smartfloData)}`);

          if (smartfloResp.ok && smartfloData.success !== false) {
            await base44.asServiceRole.entities.CallLog.update(callLog.id, {
              call_sid: smartfloData.call_id || smartfloData.call_sid || callSid,
              status: 'ringing'
            });
            totalResults.initiated++;
          } else {
            await base44.asServiceRole.entities.CallLog.update(callLog.id, { status: 'failed' });
            await base44.asServiceRole.entities.CampaignLead.update(cl.id, { status: 'failed' });
            totalResults.failed++;
            totalResults.errors.push({ lead: cl.lead_phone, error: smartfloData.message || 'API error' });
          }

          // Delay between calls to avoid rate limiting
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.error(`[campaign] Error calling ${cl.lead_phone}:`, err.message);
          await base44.asServiceRole.entities.CampaignLead.update(cl.id, { status: 'failed' });
          totalResults.failed++;
          totalResults.errors.push({ lead: cl.lead_phone, error: err.message });
        }
      }

      // Update campaign counts after each batch
      const allLeads = await base44.asServiceRole.entities.CampaignLead.filter({ campaign_id: campaign_id });
      const completedCount = allLeads.filter(l => l.status === 'completed').length;
      const failedCount = allLeads.filter(l => l.status === 'failed').length;
      await base44.asServiceRole.entities.Campaign.update(campaign_id, {
        calls_completed: completedCount,
        calls_failed: failedCount
      });

      // Wait between batches to allow calls to complete before next batch
      console.log(`[campaign] Batch ${totalResults.batches} done. Waiting 10s before next batch...`);
      await new Promise(r => setTimeout(r, 10000));
    }

    // Final counts update with outcomes
    const allLeadsFinal = await base44.asServiceRole.entities.CampaignLead.filter({ campaign_id: campaign_id });
    const finalCompleted = allLeadsFinal.filter(l => l.status === 'completed').length;
    const finalFailed = allLeadsFinal.filter(l => l.status === 'failed').length;
    const finalPending = allLeadsFinal.filter(l => ['pending', 'calling'].includes(l.status)).length;

    const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
    allLeadsFinal.forEach(l => {
      if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++;
    });

    await base44.asServiceRole.entities.Campaign.update(campaign_id, {
      calls_completed: finalCompleted,
      calls_failed: finalFailed,
      outcomes_summary: outcomes
    });

    return Response.json({
      success: true,
      batches_processed: totalResults.batches,
      ...totalResults,
      remaining: finalPending
    });

  } catch (error) {
    console.error('[executeCampaign] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});