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
        // No more pending leads — mark campaign completed
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

    // Final counts update
    const allLeadsFinal = await base44.asServiceRole.entities.CampaignLead.filter({ campaign_id: campaign_id });
    const finalCompleted = allLeadsFinal.filter(l => l.status === 'completed').length;
    const finalFailed = allLeadsFinal.filter(l => l.status === 'failed').length;
    const finalPending = allLeadsFinal.filter(l => ['pending', 'calling'].includes(l.status)).length;

    await base44.asServiceRole.entities.Campaign.update(campaign_id, {
      calls_completed: finalCompleted,
      calls_failed: finalFailed
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