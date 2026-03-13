import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { campaign_id, action, _internal } = body;
    if (!campaign_id) return Response.json({ error: 'campaign_id required' }, { status: 400 });

    let base44;
    let user = null;

    if (_internal) {
      const appId = Deno.env.get('BASE44_APP_ID');
      base44 = createClient({ appId, asServiceRole: true });
    } else {
      base44 = createClientFromRequest(req);
      user = await base44.auth.me();
      if (!user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const svc = _internal ? base44 : base44.asServiceRole;
    const campaign = await svc.entities.Campaign.get(campaign_id);
    if (!campaign) return Response.json({ error: 'Campaign not found' }, { status: 404 });

    // Ownership check only for direct user calls
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
            let outcome = 'neutral';
            let callStatusVal = 'answered';
            if (callLog.status === 'no_answer' || callLog.status === 'failed') { outcome = 'not_answered'; callStatusVal = 'not_answered'; }
            await svc.entities.CampaignLead.update(stuckLead.id, {
              status: 'completed', outcome, call_status: callStatusVal,
              conversation_summary: callLog.conversation_summary || '',
              transcript: callLog.transcript || '',
              call_duration: callLog.duration || 0
            });
            console.log(`[campaign] Fixed stuck lead ${stuckLead.lead_name}: ${outcome}`);
          } else {
            const callAge = Date.now() - new Date(stuckLead.updated_date || stuckLead.created_date).getTime();
            if (callAge > 3 * 60 * 1000) {
              await svc.entities.CampaignLead.update(stuckLead.id, {
                status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
                conversation_summary: 'Call timed out — no response within 3 minutes.'
              });
              if (stuckLead.call_log_id) {
                await svc.entities.CallLog.update(stuckLead.call_log_id, {
                  status: 'no_answer', call_end_time: new Date().toISOString(),
                  conversation_summary: 'Call timed out — no Smartflo webhook callback received.'
                });
              }
              console.log(`[campaign] Timed out stuck lead ${stuckLead.lead_name}`);
            } else {
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

    // ─── FIRE-AND-FORGET BATCH: Initiate up to maxConcurrent calls without waiting ───
    // Instead of waiting 50s per call, fire all calls and let streamAudio/campaignPostCall
    // handle completion asynchronously. The campaignPoller automation handles retries.

    const results = { initiated: 0, failed: 0, errors: [] };
    const MAX_CALLS_PER_RUN = maxConcurrent * 2; // Fire up to 2x concurrency slots
    let didIndex = 0;

    // Count currently active calls
    const currentlyCalling = await svc.entities.CampaignLead.filter(
      { campaign_id, status: 'calling' }, 'created_date', 100
    );
    const slotsAvailable = Math.max(0, maxConcurrent - currentlyCalling.length);

    if (slotsAvailable === 0) {
      console.log(`[campaign] All ${maxConcurrent} slots occupied. Waiting for completions.`);
      return Response.json({ success: true, message: 'All slots occupied', currently_calling: currentlyCalling.length });
    }

    // Get next pending leads ready to call
    // Fetch a large batch because some leads may have future followup_call_date (retry-scheduled)
    // and we need to skip past them to find fresh leads
    const now = new Date();
    const pendingLeadsRaw = await svc.entities.CampaignLead.filter(
      { campaign_id, status: 'pending' }, 'created_date', 200
    );
    const pendingLeads = pendingLeadsRaw.filter(l => {
      if (!l.followup_call_date) return true;
      return new Date(l.followup_call_date) <= now;
    }).slice(0, slotsAvailable);

    if (pendingLeads.length === 0) {
      // Check if campaign should be completed
      const allLeads = await svc.entities.CampaignLead.filter({ campaign_id }, 'created_date', 1000);
      const callingCount = allLeads.filter(l => l.status === 'calling').length;
      const pendingWithFutureRetry = allLeads.filter(l =>
        l.status === 'pending' && l.followup_call_date && new Date(l.followup_call_date) > now
      ).length;
      const pendingReady = allLeads.filter(l =>
        l.status === 'pending' && (!l.followup_call_date || new Date(l.followup_call_date) <= now)
      ).length;

      if (callingCount === 0 && pendingReady === 0 && pendingWithFutureRetry === 0) {
        const completed = allLeads.filter(l => l.status === 'completed').length;
        const failed = allLeads.filter(l => l.status === 'failed').length;
        const outcomes = { neutral: 0, interested: 0, not_interested: 0, not_answered: 0, callback: 0, converted: 0, do_not_call: 0 };
        allLeads.forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
        await svc.entities.Campaign.update(campaign_id, {
          status: 'completed', completed_at: new Date().toISOString(),
          calls_completed: completed, calls_failed: failed, outcomes_summary: outcomes
        });
        console.log(`[campaign] Campaign completed: ${completed} done, ${failed} failed`);
        return Response.json({ success: true, status: 'completed', completed, failed });
      }

      if (pendingWithFutureRetry > 0) {
        console.log(`[campaign] ${pendingWithFutureRetry} leads waiting for retry. Campaign continues.`);
      }
      return Response.json({ success: true, message: 'No ready leads', pending_retry: pendingWithFutureRetry, calling: callingCount });
    }

    // Determine Smartflo API key
    let smartfloApiKey;
    try {
      const clientData = await svc.entities.Client.get(campaign.client_id);
      const isDemoAgent = clientData && (clientData.account_status === 'trial' || clientData.account_status === 'onboarding');
      smartfloApiKey = isDemoAgent
        ? Deno.env.get('SMARTFLO_API_KEY')
        : (agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY'));
    } catch (_) {
      smartfloApiKey = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    }

    // ─── Fire all calls in quick succession (no 50s wait per call) ───
    for (const cl of pendingLeads) {
      try {
        const selectedDID = agentDIDs[didIndex % agentDIDs.length];
        didIndex++;

        await svc.entities.CampaignLead.update(cl.id, {
          status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
        });

        const cleanPhone = cl.lead_phone.replace(/[^0-9]/g, '');
        const callSid = `camp_${campaign_id.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        // Build lead context inline
        let leadContext = '';
        try {
          let lead = null;
          if (cl.lead_id) {
            try { lead = await svc.entities.Lead.get(cl.lead_id); } catch (_) {}
          }
          if (lead) {
            const ctxParts = [];
            ctxParts.push(`CUSTOMER PROFILE:`);
            ctxParts.push(`- Name: ${lead.name || cl.lead_name || 'Unknown'}`);
            if (lead.phone) ctxParts.push(`- Phone: ${lead.phone}`);
            if (lead.email) ctxParts.push(`- Email: ${lead.email}`);
            if (lead.company) ctxParts.push(`- Company: ${lead.company}`);
            if (lead.status) ctxParts.push(`- Status: ${lead.status}`);
            if (lead.score) ctxParts.push(`- Lead Score: ${lead.score}/100`);
            if (lead.qualification_tier) ctxParts.push(`- Qualification: ${lead.qualification_tier.toUpperCase()}`);
            if (lead.notes) ctxParts.push(`\nNOTES: ${lead.notes}`);
            ctxParts.push(`\nCRITICAL PERSONALIZATION RULES:`);
            ctxParts.push(`- You MUST address the customer by name "${lead.name || cl.lead_name || 'Sir/Madam'}".`);
            ctxParts.push(`- Example: "Kya main ${lead.name || cl.lead_name || 'Sir/Madam'} se baat kar rahi hu?"`);
            if (lead.email) ctxParts.push(`- If confirming email, use: "${lead.email}"`);
            if (lead.company) ctxParts.push(`- Reference their company "${lead.company}" naturally.`);
            leadContext = ctxParts.join('\n');
          } else {
            leadContext = `CUSTOMER PROFILE:\n- Name: ${cl.lead_name || 'Unknown'}\n- Phone: ${cl.lead_phone}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;
          }
          console.log(`[campaign] Lead context built for ${cl.lead_name}: ${leadContext.length} chars`);
        } catch (e) {
          leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;
        }

        const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const timeContext = `\n\n--- CURRENT DATE & TIME (IST) ---\nRight now it is: ${nowIST} (Indian Standard Time).\nUse this to calculate relative times. Always confirm callback times in IST.`;

        const personalizedPrompt = [
          agent.system_prompt || '',
          timeContext,
          campaign.call_script?.opening ? `\nCALL SCRIPT - Opening: ${campaign.call_script.opening}` : '',
          campaign.call_script?.pitch ? `\nCALL SCRIPT - Pitch: ${campaign.call_script.pitch}` : '',
          campaign.call_script?.objection_handling ? `\nCALL SCRIPT - Objections: ${campaign.call_script.objection_handling}` : '',
          campaign.call_script?.closing ? `\nCALL SCRIPT - Closing: ${campaign.call_script.closing}` : '',
          `\n\n--- LEAD CONTEXT (YOU MUST USE THIS DATA IN THE CONVERSATION) ---\n${leadContext}`
        ].filter(Boolean).join('\n');

        const callLog = await svc.entities.CallLog.create({
          client_id: campaign.client_id, agent_id: campaign.agent_id, lead_id: cl.lead_id,
          call_sid: callSid, caller_id: selectedDID, callee_number: cleanPhone,
          direction: 'outbound', status: 'initiated', call_start_time: new Date().toISOString(),
          conversation_summary: leadContext ? `[LEAD CONTEXT] ${cl.lead_name}\n${leadContext}` : '',
          agent_config_cache: {
            agent_name: agent.name, system_prompt: personalizedPrompt,
            persona: agent.persona || {}, knowledge_base_content: kbContent,
            lead_context: leadContext,
            greeting_message: agent.greeting_message || ''
          }
        });

        await svc.entities.CampaignLead.update(cl.id, { call_log_id: callLog.id });

        // ─── Initiate the call via Smartflo ───
        let cleanCallerID = selectedDID.replace(/[^0-9]/g, '');
        if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;

        const smartfloResp = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: smartfloApiKey,
            customer_number: cleanPhone,
            caller_id: cleanCallerID,
            async: 1
          })
        });

        const smartfloData = await smartfloResp.json();
        console.log(`[campaign] Smartflo response for ${cl.lead_name}: ${JSON.stringify(smartfloData)}`);

        if (!(smartfloResp.ok && smartfloData.success !== false)) {
          await svc.entities.CallLog.update(callLog.id, { status: 'failed' });
          await svc.entities.CampaignLead.update(cl.id, {
            status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
            conversation_summary: `Smartflo API error: ${smartfloData.message || JSON.stringify(smartfloData)}`
          });
          results.failed++;
          results.errors.push({ lead: cl.lead_phone, error: smartfloData.message || 'API error' });
          continue;
        }

        // Update call log with Smartflo ref — use ref_id as fallback when call_id is null
        const smartfloCallId = smartfloData.call_id || smartfloData.ref_id || smartfloData.call_sid || callSid;
        await svc.entities.CallLog.update(callLog.id, {
          call_sid: smartfloCallId,
          status: 'ringing'
        });
        results.initiated++;
        console.log(`[campaign] ✅ Call fired for ${cl.lead_name} (callLog=${callLog.id}, sid=${smartfloCallId})`);

        // Small delay between calls to avoid Smartflo rate limits
        await new Promise(r => setTimeout(r, 1500));

      } catch (err) {
        console.error(`[campaign] Error calling ${cl.lead_phone}:`, err.message);
        await svc.entities.CampaignLead.update(cl.id, {
          status: 'completed', outcome: 'not_answered', call_status: 'not_answered',
          conversation_summary: `Error: ${err.message}`
        });
        results.failed++;
        results.errors.push({ lead: cl.lead_phone, error: err.message });
      }
    }

    // Update campaign counts
    const allLeads = await svc.entities.CampaignLead.filter({ campaign_id }, 'created_date', 1000);
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