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

    // Get pending leads
    const campaignLeads = await base44.asServiceRole.entities.CampaignLead.filter(
      { campaign_id: campaign_id, status: 'pending' }, 'created_date', 50
    );

    if (campaignLeads.length === 0) {
      await base44.asServiceRole.entities.Campaign.update(campaign_id, {
        status: 'completed',
        completed_at: new Date().toISOString()
      });
      return Response.json({ success: true, message: 'No pending leads', status: 'completed' });
    }

    const maxConcurrent = campaign.max_concurrent_calls || 5;
    const batch = campaignLeads.slice(0, maxConcurrent);
    const results = { initiated: 0, failed: 0, errors: [] };

    // Initiate calls for the batch
    for (let i = 0; i < batch.length; i++) {
      const cl = batch[i];
      try {
        // Round-robin DID selection for concurrent calls
        const selectedDID = agentDIDs[i % agentDIDs.length];

        // Mark as calling
        await base44.asServiceRole.entities.CampaignLead.update(cl.id, {
          status: 'calling',
          attempt_count: (cl.attempt_count || 0) + 1
        });

        // Clean caller ID: Smartflo expects the raw number without + prefix
        // Some DIDs are stored as "+918065485981", some as "8087390277"
        let cleanCallerID = selectedDID.replace(/[^0-9]/g, '');
        // Smartflo needs the DID exactly as registered — typically 10-digit or with country code
        // Pass as-is after stripping non-digits
        const cleanPhone = cl.lead_phone.replace(/[^0-9]/g, '');

        // Create call log with cached agent config (so streamAudio WebSocket can use it)
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

        // Update campaign lead with call log ref
        await base44.asServiceRole.entities.CampaignLead.update(cl.id, {
          call_log_id: callLog.id
        });

        // Initiate via Smartflo - use the DID as stored (Smartflo needs exact registered caller_id)
        const smartfloPayload = {
          api_key: Deno.env.get('SMARTFLO_API_KEY'),
          customer_number: cleanPhone,
          caller_id: selectedDID,
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
          results.initiated++;
        } else {
          await base44.asServiceRole.entities.CallLog.update(callLog.id, { status: 'failed' });
          await base44.asServiceRole.entities.CampaignLead.update(cl.id, { status: 'failed' });
          results.failed++;
          results.errors.push({ lead: cl.lead_phone, error: smartfloData.message || 'API error' });
        }

        // Small delay between calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error(`[campaign] Error calling ${cl.lead_phone}:`, err.message);
        await base44.asServiceRole.entities.CampaignLead.update(cl.id, { status: 'failed' });
        results.failed++;
        results.errors.push({ lead: cl.lead_phone, error: err.message });
      }
    }

    // Update campaign counts
    const allLeads = await base44.asServiceRole.entities.CampaignLead.filter({ campaign_id: campaign_id });
    const completed = allLeads.filter(l => l.status === 'completed').length;
    const failed = allLeads.filter(l => l.status === 'failed').length;

    await base44.asServiceRole.entities.Campaign.update(campaign_id, {
      calls_completed: completed,
      calls_failed: failed
    });

    return Response.json({
      success: true,
      batch_size: batch.length,
      ...results,
      remaining: campaignLeads.length - batch.length
    });

  } catch (error) {
    console.error('[executeCampaign] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});