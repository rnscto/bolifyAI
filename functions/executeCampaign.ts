import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { campaign_id, action, _internal } = body;
    if (!campaign_id) return Response.json({ error: 'campaign_id required' }, { status: 400 });

    let base44;
    let user = null;

    if (_internal) {
      // Internal calls from campaignPostCall/poller — use service role directly
      const appId = Deno.env.get('BASE44_APP_ID');
      base44 = createClient({ appId, asServiceRole: true });
    } else {
      // User-initiated calls — require authentication
      base44 = createClientFromRequest(req);
      user = await base44.auth.me();
      if (!user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const svc = _internal ? base44 : base44.asServiceRole;
    const campaign = await svc.entities.Campaign.get(campaign_id);
    if (!campaign) return Response.json({ error: 'Campaign not found' }, { status: 404 });

    // Ownership check only for direct user calls (not internal triggers)
    if (user && !_internal) {
      if (user.role !== 'admin') {
        const clients = await base44.entities.Client.filter({ user_id: user.id });
        const clientIds = clients.map(c => c.id);
        if (!clientIds.includes(campaign.client_id)) {
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        }
      }
    }

    // Handle pause/resume/cancel
    if (action === 'pause') {
      await svc.entities.Campaign.update(campaign_id, { status: 'paused' });
      return Response.json({ success: true, status: 'paused' });
    }
    if (action === 'cancel') {
      await svc.entities.Campaign.update(campaign_id, { status: 'cancelled' });
      return Response.json({ success: true, status: 'cancelled' });
    }

    // Guard: don't restart a completed/cancelled campaign via internal trigger
    if (_internal && ['completed', 'cancelled'].includes(campaign.status)) {
      return Response.json({ success: true, skipped: `campaign_${campaign.status}` });
    }

    // Start or resume campaign
    await svc.entities.Campaign.update(campaign_id, {
      status: 'running',
      started_at: campaign.started_at || new Date().toISOString()
    });

    const agent = await svc.entities.Agent.get(campaign.agent_id);
    const agentDIDs = (agent?.assigned_dids && agent.assigned_dids.length > 0)
      ? agent.assigned_dids
      : (agent?.assigned_did ? [agent.assigned_did] : []);
    if (!agent || agentDIDs.length === 0) {
      await svc.entities.Campaign.update(campaign_id, { status: 'draft' });
      return Response.json({ error: 'Agent has no assigned DID' }, { status: 400 });
    }

    // Pre-fetch knowledge base content
    let kbContent = '';
    if (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await svc.entities.KnowledgeBase.get(kbId);
          if (doc && doc.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
        } catch (e) {
          console.log(`KB doc ${kbId} fetch failed: ${e.message}`);
        }
      }
    }

    const maxConcurrent = campaign.max_concurrent_calls || 5;

    // Fix any stuck 'calling' leads from previous runs
    const stuckLeads = await svc.entities.CampaignLead.filter(
      { campaign_id, status: 'calling' }, 'created_date', 100
    );
    for (const stuckLead of stuckLeads) {
      try {
        if (stuckLead.call_log_id) {
          const callLog = await svc.entities.CallLog.get(stuckLead.call_log_id);
          const terminalStatuses = ['completed', 'failed', 'no_answer'];
          if (callLog && terminalStatuses.includes(callLog.status)) {
            let outcome = 'contacted';
            if (callLog.status === 'no_answer' || callLog.status === 'failed') outcome = 'no_answer';
            await svc.entities.CampaignLead.update(stuckLead.id, {
              status: 'completed', outcome,
              conversation_summary: callLog.conversation_summary || '',
              transcript: callLog.transcript || '',
              call_duration: callLog.duration || 0
            });
            console.log(`[campaign] Fixed stuck lead ${stuckLead.lead_name}: ${outcome}`);
          } else {
            // Call is still ringing or stuck — check age. If > 5 min, mark failed.
            const callAge = Date.now() - new Date(stuckLead.updated_date || stuckLead.created_date).getTime();
            if (callAge > 5 * 60 * 1000) {
              await svc.entities.CampaignLead.update(stuckLead.id, {
                status: 'completed', outcome: 'no_answer',
                conversation_summary: 'Call timed out — no response from Smartflo within 5 minutes.'
              });
              if (stuckLead.call_log_id) {
                await svc.entities.CallLog.update(stuckLead.call_log_id, {
                  status: 'no_answer', call_end_time: new Date().toISOString(),
                  conversation_summary: 'Call timed out — no Smartflo webhook callback received within 5 minutes.'
                });
              }
              console.log(`[campaign] Timed out stuck lead ${stuckLead.lead_name}`);
            } else {
              // Still fresh — reset to pending for retry
              await svc.entities.CampaignLead.update(stuckLead.id, { status: 'pending', call_log_id: null });
              console.log(`[campaign] Reset stuck lead ${stuckLead.lead_name} to pending`);
            }
          }
        } else {
          await svc.entities.CampaignLead.update(stuckLead.id, { status: 'pending', call_log_id: null });
        }
      } catch (e) {
        console.error(`[campaign] Error fixing stuck lead:`, e.message);
      }
    }

    // Count currently in-flight calls (exclude any that have been calling for > 5 min — they're stuck)
    const currentlyCalling = await svc.entities.CampaignLead.filter(
      { campaign_id, status: 'calling' }, 'created_date', 100
    );
    const activeCalling = currentlyCalling.filter(cl => {
      const age = Date.now() - new Date(cl.updated_date || cl.created_date).getTime();
      return age < 5 * 60 * 1000; // Only count calls under 5 min old
    });
    const slotsAvailable = Math.max(0, maxConcurrent - activeCalling.length);
    console.log(`[campaign] Slot check: ${currentlyCalling.length} total calling, ${activeCalling.length} active (< 5min), ${slotsAvailable} slots available, max=${maxConcurrent}`);

    if (slotsAvailable === 0) {
      console.log(`[campaign] All ${maxConcurrent} slots occupied, waiting for calls to complete.`);
      return Response.json({ success: true, message: 'All slots busy, next batch when calls complete', slots: 0 });
    }

    // Get next batch of pending leads
    const pendingLeads = await svc.entities.CampaignLead.filter(
      { campaign_id, status: 'pending' }, 'created_date', slotsAvailable
    );

    if (pendingLeads.length === 0) {
      // Check if all done
      const allLeads = await svc.entities.CampaignLead.filter({ campaign_id });
      const stillActive = allLeads.filter(l => ['pending', 'calling'].includes(l.status)).length;
      if (stillActive === 0) {
        const completed = allLeads.filter(l => l.status === 'completed').length;
        const failed = allLeads.filter(l => l.status === 'failed').length;
        const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
        allLeads.forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
        await svc.entities.Campaign.update(campaign_id, {
          status: 'completed', completed_at: new Date().toISOString(),
          calls_completed: completed, calls_failed: failed, outcomes_summary: outcomes
        });
        return Response.json({ success: true, status: 'completed', calls_completed: completed });
      }
      return Response.json({ success: true, message: 'No pending leads, waiting for in-flight calls' });
    }

    console.log(`[campaign] Initiating ${pendingLeads.length} calls (slots: ${slotsAvailable})`);
    const results = { initiated: 0, failed: 0, errors: [] };

    // Initiate calls for this batch
    for (let i = 0; i < pendingLeads.length; i++) {
      const cl = pendingLeads[i];
      try {
        const selectedDID = agentDIDs[i % agentDIDs.length];
        await svc.entities.CampaignLead.update(cl.id, {
          status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
        });

        const cleanPhone = cl.lead_phone.replace(/[^0-9]/g, '');
        const callSid = `camp_${campaign_id.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        // Build personalized lead context
        let leadContext = '';
        try {
          const ctxRes = await svc.functions.invoke('buildLeadContext', {
            lead_id: cl.lead_id, client_id: campaign.client_id, phone_number: cl.lead_phone
          });
          if (ctxRes?.context_text) leadContext = ctxRes.context_text;
        } catch (e) {
          console.log(`[campaign] Lead context failed for ${cl.lead_name}: ${e.message}`);
        }

        const personalizedPrompt = [
          agent.system_prompt || '',
          campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
          campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
          campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
          campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
          leadContext ? `\n\n--- LEAD CONTEXT (use this to personalize the conversation) ---\n${leadContext}` : ''
        ].filter(Boolean).join('\n');

        const callLog = await svc.entities.CallLog.create({
          client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
          call_sid: callSid, caller_id: selectedDID, callee_number: cl.lead_phone,
          direction: 'outbound', status: 'initiated', call_start_time: new Date().toISOString(),
          conversation_summary: leadContext ? `[LEAD CONTEXT] ${cl.lead_name}\n${leadContext}` : '',
          agent_config_cache: {
            agent_name: agent.name, system_prompt: personalizedPrompt,
            persona: agent.persona || {}, knowledge_base_content: kbContent,
            lead_context: leadContext
          }
        });

        await svc.entities.CampaignLead.update(cl.id, { call_log_id: callLog.id });

        // Clean the phone number for Smartflo (must be digits only, no spaces)
        const smartfloPhone = cleanPhone.startsWith('91') ? cleanPhone : `91${cleanPhone}`;
        console.log(`[campaign] Calling ${cl.lead_name}: original=${cl.lead_phone}, clean=${cleanPhone}, smartflo=${smartfloPhone}, DID=${selectedDID}`);

        const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: Deno.env.get('SMARTFLO_API_KEY'),
            customer_number: smartfloPhone,
            caller_id: selectedDID.replace(/^\+/, ''),
            async: 1
          })
        });

        const smartfloData = await smartfloResp.json();
        console.log(`[campaign] Smartflo response for ${cl.lead_name}: ${JSON.stringify(smartfloData)}`);

        if (smartfloResp.ok && smartfloData.success !== false) {
          const newCallSid = smartfloData.call_id || smartfloData.call_sid || callSid;
          console.log(`[campaign] Smartflo call_id for ${cl.lead_name}: ${newCallSid} (original: ${callSid})`);
          // Store BOTH the Smartflo call_id (as call_sid) and our internal ID (in conversation_summary for reference)
          await svc.entities.CallLog.update(callLog.id, {
            call_sid: newCallSid,
            status: 'ringing',
            conversation_summary: callLog.conversation_summary ? `${callLog.conversation_summary}\n[internal_id: ${callSid}]` : `[internal_id: ${callSid}]`
          });
          results.initiated++;
        } else {
          await svc.entities.CallLog.update(callLog.id, { status: 'failed' });
          await svc.entities.CampaignLead.update(cl.id, {
            status: 'completed', outcome: 'no_answer',
            conversation_summary: `Smartflo API error: ${smartfloData.message || 'Unknown'}`
          });
          results.failed++;
          results.errors.push({ lead: cl.lead_phone, error: smartfloData.message || 'API error' });
        }

        // Small delay between calls to avoid race conditions with Smartflo
        if (i < pendingLeads.length - 1) await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[campaign] Error calling ${cl.lead_phone}:`, err.message);
        await svc.entities.CampaignLead.update(cl.id, {
          status: 'completed', outcome: 'no_answer',
          conversation_summary: `Error: ${err.message}`
        });
        results.failed++;
        results.errors.push({ lead: cl.lead_phone, error: err.message });
      }
    }

    // Update campaign counts
    const allLeads = await svc.entities.CampaignLead.filter({ campaign_id });
    const completedCount = allLeads.filter(l => l.status === 'completed').length;
    const failedCount = allLeads.filter(l => l.status === 'failed').length;
    await svc.entities.Campaign.update(campaign_id, {
      calls_completed: completedCount, calls_failed: failedCount
    });

    return Response.json({
      success: true, ...results,
      pending_remaining: allLeads.filter(l => l.status === 'pending').length,
      currently_calling: allLeads.filter(l => l.status === 'calling').length
    });

  } catch (error) {
    console.error('[executeCampaign] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});