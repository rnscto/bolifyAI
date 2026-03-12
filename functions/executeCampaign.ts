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
            // Call is still ringing or stuck — check age. If > 3 min, mark failed.
            const callAge = Date.now() - new Date(stuckLead.updated_date || stuckLead.created_date).getTime();
            if (callAge > 3 * 60 * 1000) {
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

    // Count currently in-flight calls
    const currentlyCalling = await svc.entities.CampaignLead.filter(
      { campaign_id, status: 'calling' }, 'created_date', 100
    );
    const slotsAvailable = Math.max(0, maxConcurrent - currentlyCalling.length);

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

    console.log(`[campaign] Initiating ${pendingLeads.length} calls sequentially (slots: ${slotsAvailable})`);
    const results = { initiated: 0, failed: 0, connected: 0, no_answer_timeout: 0, errors: [] };
    const CONNECT_TIMEOUT_MS = 50000; // 50 seconds to connect to streamAudio
    const POLL_INTERVAL_MS = 3000;    // Check every 3 seconds

    // Initiate calls ONE AT A TIME — wait for streamAudio to identify each before moving on
    for (let i = 0; i < pendingLeads.length; i++) {
      const cl = pendingLeads[i];
      try {
        // Check if campaign was paused/cancelled during execution
        const freshCampaign = await svc.entities.Campaign.get(campaign_id);
        if (['paused', 'cancelled', 'completed'].includes(freshCampaign?.status)) {
          console.log(`[campaign] Campaign ${freshCampaign.status}, stopping execution`);
          break;
        }

        const selectedDID = agentDIDs[i % agentDIDs.length];
        await svc.entities.CampaignLead.update(cl.id, {
          status: 'calling', attempt_count: (cl.attempt_count || 0) + 1
        });

        const cleanPhone = cl.lead_phone.replace(/[^0-9]/g, '');
        const callSid = `camp_${campaign_id.slice(-8)}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        // Build lead context INLINE (avoid cross-function auth issues)
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
          console.log(`[campaign] Lead context failed for ${cl.lead_name}: ${e.message}`);
          leadContext = `CUSTOMER: ${cl.lead_name || 'Unknown'}\nCRITICAL: Address the customer by name "${cl.lead_name || 'Sir/Madam'}".`;
        }

        // Inject current IST date/time so the agent is time-aware
        const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const timeContext = `\n\n--- CURRENT DATE & TIME (IST) ---\nRight now it is: ${nowIST} (Indian Standard Time).\nUse this to calculate relative times when the customer says "call me after 30 minutes" or "call me tomorrow morning". Always confirm callback times in IST.`;

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
          call_sid: callSid, caller_id: selectedDID, callee_number: cl.lead_phone,
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
        console.log(`[campaign] Call to ${cl.lead_phone} (${cl.lead_name}): ${JSON.stringify(smartfloData)}`);

        if (!(smartfloResp.ok && smartfloData.success !== false)) {
          // Smartflo API error — mark failed immediately
          await svc.entities.CallLog.update(callLog.id, { status: 'failed' });
          await svc.entities.CampaignLead.update(cl.id, {
            status: 'completed', outcome: 'no_answer',
            conversation_summary: `Smartflo API error: ${smartfloData.message || 'Unknown'}`
          });
          results.failed++;
          results.errors.push({ lead: cl.lead_phone, error: smartfloData.message || 'API error' });
          continue; // Move to next lead immediately
        }

        // Smartflo accepted the call — store ALL possible IDs for webhook matching
        const smartfloCallId = smartfloData.call_id || null;
        const smartfloRefId = smartfloData.ref_id || null;
        const newCallSid = smartfloCallId || smartfloData.call_sid || callSid;
        console.log(`[campaign] Smartflo returned call_id=${smartfloCallId}, ref_id=${smartfloRefId}, call_sid=${smartfloData.call_sid}, using=${newCallSid}, original=${callSid}`);
        
        // Store ref_id in conversation_summary temporarily so webhook can match it
        const updateFields = { call_sid: newCallSid, status: 'ringing' };
        if (smartfloRefId && !smartfloCallId) {
          // Smartflo returned ref_id but no call_id — store ref_id as call_sid too for matching
          updateFields.call_sid = smartfloRefId;
        }
        await svc.entities.CallLog.update(callLog.id, updateFields);
        results.initiated++;

        // ─── WAIT for streamAudio to connect (poll for stream_sid or terminal status) ───
        console.log(`[campaign] ⏳ Waiting up to ${CONNECT_TIMEOUT_MS/1000}s for streamAudio to identify call ${callLog.id}...`);
        const waitStart = Date.now();
        let callConnected = false;
        let callTerminal = false;

        while (Date.now() - waitStart < CONNECT_TIMEOUT_MS) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

          try {
            const updatedLog = await svc.entities.CallLog.get(callLog.id);
            
            // Check if streamAudio has claimed this call (stream_sid is set)
            if (updatedLog.stream_sid) {
              console.log(`[campaign] ✅ Call ${callLog.id} connected to streamAudio (stream_sid=${updatedLog.stream_sid}) after ${Math.round((Date.now() - waitStart)/1000)}s`);
              callConnected = true;
              results.connected++;
              break;
            }

            // Check if call reached a terminal state (completed/failed/no_answer via webhook)
            if (['completed', 'failed', 'no_answer'].includes(updatedLog.status)) {
              console.log(`[campaign] 📴 Call ${callLog.id} reached terminal state: ${updatedLog.status} after ${Math.round((Date.now() - waitStart)/1000)}s`);
              callTerminal = true;
              // CampaignLead will be updated by campaignPostCall automation
              break;
            }

            console.log(`[campaign] ⏳ Still waiting... ${Math.round((Date.now() - waitStart)/1000)}s elapsed, status=${updatedLog.status}, stream_sid=${updatedLog.stream_sid || 'none'}`);
          } catch (pollErr) {
            console.error(`[campaign] ⚠️ Poll error: ${pollErr.message}`);
          }
        }

        // ─── TIMEOUT: Call not connected to streamAudio within 50s ───
        if (!callConnected && !callTerminal) {
          console.log(`[campaign] ⏰ TIMEOUT: Call ${callLog.id} for ${cl.lead_name} not connected within ${CONNECT_TIMEOUT_MS/1000}s`);
          await svc.entities.CallLog.update(callLog.id, {
            status: 'no_answer',
            call_end_time: new Date().toISOString(),
            conversation_summary: `Call not answered — no streamAudio connection within ${CONNECT_TIMEOUT_MS/1000} seconds.`
          });

          // Check if retry is applicable before marking completed
          const currentAttempts = (cl.attempt_count || 0) + 1;
          const freshCamp = await svc.entities.Campaign.get(campaign_id);
          const retryRules = freshCamp?.followup_rules || {};
          const maxRetries = retryRules.no_answer_max_retries || 3;
          const shouldRetry = retryRules.no_answer_retry !== false && currentAttempts < maxRetries;

          if (shouldRetry) {
            const retryHours = retryRules.no_answer_retry_hours || 4;
            await svc.entities.CampaignLead.update(cl.id, {
              status: 'pending', outcome: 'no_answer',
              attempt_count: currentAttempts, call_log_id: null,
              followup_call_date: new Date(Date.now() + retryHours * 3600000).toISOString(),
              conversation_summary: `No answer (attempt ${currentAttempts}/${maxRetries}). Retry in ${retryHours}h.`
            });
            console.log(`[campaign] ♻️ No-answer retry ${currentAttempts}/${maxRetries} queued for ${cl.lead_name}`);
          } else {
            await svc.entities.CampaignLead.update(cl.id, {
              status: 'completed', outcome: 'no_answer',
              conversation_summary: `Call not answered after ${currentAttempts} attempt(s).`
            });
          }
          results.no_answer_timeout++;
        }

        // Small delay before initiating next call
        if (i < pendingLeads.length - 1) await new Promise(r => setTimeout(r, 1000));

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
    
    // Check if campaign is done
    const stillActive = allLeads.filter(l => ['pending', 'calling'].includes(l.status)).length;
    const campaignUpdate = { calls_completed: completedCount, calls_failed: failedCount };
    if (stillActive === 0) {
      const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
      allLeads.forEach(l => { if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++; });
      campaignUpdate.status = 'completed';
      campaignUpdate.completed_at = new Date().toISOString();
      campaignUpdate.outcomes_summary = outcomes;
    }
    await svc.entities.Campaign.update(campaign_id, campaignUpdate);

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