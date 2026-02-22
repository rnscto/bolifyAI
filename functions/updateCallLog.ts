import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    // Inject Base44-App-Id if missing (called from streamAudio WebSocket context)
    let base44Req = req;
    if (!req.headers.get('Base44-App-Id')) {
      const appId = Deno.env.get('BASE44_APP_ID');
      if (appId) {
        const newHeaders = new Headers(req.headers);
        newHeaders.set('Base44-App-Id', appId);
        base44Req = new Request(req.url, {
          method: req.method,
          headers: newHeaders,
          body: req.body,
          duplex: 'half'
        });
      }
    }
    const base44 = createClientFromRequest(base44Req);

    const body = await req.json();
    const { action } = body;

    // === GET AGENT CONFIG action: find call log + load agent + knowledge base ===
    if (action === 'get_agent_config') {
      const { call_sid, stream_sid } = body;
      console.log(`[updateCallLog] get_agent_config: call_sid=${call_sid}, stream_sid=${stream_sid}`);

      let callLog = null;

      // Strategy 1: Match by call_sid
      if (call_sid) {
        const logs = await base44.asServiceRole.entities.CallLog.filter({ call_sid });
        if (logs.length > 0) callLog = logs[0];
      }

      // Strategy 2: Match by stream_sid
      if (!callLog && stream_sid) {
        const logs = await base44.asServiceRole.entities.CallLog.filter({ stream_sid });
        if (logs.length > 0) callLog = logs[0];
      }

      // Strategy 3: Most recent ringing/initiated call
      if (!callLog) {
        const recentLogs = await base44.asServiceRole.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 1);
        if (recentLogs.length > 0) callLog = recentLogs[0];
        if (!callLog) {
          const initiatedLogs = await base44.asServiceRole.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 1);
          if (initiatedLogs.length > 0) callLog = initiatedLogs[0];
        }
      }

      if (!callLog) {
        return Response.json({ success: false, error: 'Call log not found' });
      }

      // Update call log with stream_sid/call_sid
      const updateFields = {};
      if (stream_sid && !callLog.stream_sid) updateFields.stream_sid = stream_sid;
      if (call_sid && callLog.call_sid !== call_sid) updateFields.call_sid = call_sid;
      if (Object.keys(updateFields).length > 0) {
        await base44.asServiceRole.entities.CallLog.update(callLog.id, updateFields);
      }

      // Fetch agent
      let agent = null;
      let knowledgeDocs = [];
      if (callLog.agent_id) {
        try {
          agent = await base44.asServiceRole.entities.Agent.get(callLog.agent_id);
        } catch (e) {
          console.error(`[updateCallLog] Agent fetch failed: ${e.message}`);
        }

        // Fetch knowledge base
        if (agent && agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
          for (const kbId of agent.knowledge_base_ids) {
            try {
              const doc = await base44.asServiceRole.entities.KnowledgeBase.get(kbId);
              if (doc && doc.content) knowledgeDocs.push({ title: doc.title, content: doc.content });
            } catch (e) {
              console.error(`[updateCallLog] KB doc ${kbId} failed: ${e.message}`);
            }
          }
        }
      }

      return Response.json({
        success: true,
        callLogId: callLog.id,
        agent: agent ? {
          id: agent.id,
          name: agent.name,
          system_prompt: agent.system_prompt || '',
          persona: agent.persona || {},
        } : null,
        knowledgeDocs
      });
    }

    // === DEFAULT: Update call log ===
    const { call_log_id, status, transcript, duration, call_end_time, conversation_summary } = body;

    if (!call_log_id) {
      return Response.json({ error: 'call_log_id required' }, { status: 400 });
    }

    const validStatuses = ['initiated', 'ringing', 'answered', 'completed', 'failed', 'no_answer'];
    if (status && !validStatuses.includes(status)) {
      return Response.json({ error: 'Invalid status' }, { status: 400 });
    }

    // Get current call log to check previous status
    const currentCallLog = await base44.asServiceRole.entities.CallLog.get(call_log_id);

    const updateData = {};
    if (status) updateData.status = status;
    if (transcript) updateData.transcript = transcript;
    if (duration !== undefined) updateData.duration = duration;
    if (call_end_time) updateData.call_end_time = call_end_time;
    if (conversation_summary) updateData.conversation_summary = conversation_summary;

    await base44.asServiceRole.entities.CallLog.update(call_log_id, updateData);

    // If this call just reached a terminal status, check if it's a campaign call
    // and update CampaignLead + Lead + Campaign directly
    const terminalStatuses = ['completed', 'failed', 'no_answer'];
    const isNewlyTerminal = status && terminalStatuses.includes(status) && !terminalStatuses.includes(currentCallLog?.status);

    if (isNewlyTerminal) {
      console.log(`[updateCallLog] Call ${call_log_id} reached terminal status: ${status}. Checking for campaign link...`);

      const campaignLeads = await base44.asServiceRole.entities.CampaignLead.filter({ call_log_id: call_log_id });

      if (campaignLeads.length > 0) {
        const cl = campaignLeads[0];
        console.log(`[updateCallLog] Found campaign lead ${cl.id} for campaign ${cl.campaign_id}`);

        // Determine outcome
        let outcome = 'contacted';
        let summaryText = conversation_summary || currentCallLog?.conversation_summary || '';

        if (status === 'no_answer' || status === 'failed') {
          outcome = 'no_answer';
          summaryText = summaryText || (status === 'no_answer' ? 'Call was not answered.' : 'Call failed to connect.');
        } else if (transcript || summaryText) {
          // Use LLM to analyze the call
          try {
            const analysis = await base44.asServiceRole.integrations.Core.InvokeLLM({
              prompt: `Analyze this sales call and determine the outcome.

TRANSCRIPT:
${transcript || currentCallLog?.transcript || 'No transcript available'}

SUMMARY:
${summaryText}

Determine:
1. outcome: one of "interested", "not_interested", "callback", "no_answer", "converted", "contacted"
2. summary: A brief 2-3 sentence summary.

Rules:
- "interested" = expressed clear interest, asked about pricing/details, wanted next steps
- "callback" = asked to be called back later, was busy
- "not_interested" = explicitly declined
- "no_answer" = no real conversation, voicemail, cut off quickly
- "converted" = agreed to sign up/purchase/commit
- "contacted" = had a conversation but no clear outcome yet`,
              response_json_schema: {
                type: "object",
                properties: {
                  outcome: { type: "string" },
                  summary: { type: "string" }
                }
              }
            });
            outcome = analysis.outcome || 'contacted';
            summaryText = analysis.summary || summaryText;
          } catch (llmErr) {
            console.error(`[updateCallLog] LLM analysis failed:`, llmErr.message);
          }
        }

        // Update CampaignLead
        await base44.asServiceRole.entities.CampaignLead.update(cl.id, {
          status: 'completed',
          outcome: outcome,
          conversation_summary: summaryText,
          transcript: transcript || currentCallLog?.transcript || '',
          call_duration: duration || currentCallLog?.duration || 0
        });
        console.log(`[updateCallLog] CampaignLead ${cl.id} → completed, outcome: ${outcome}`);

        // Update Lead entity
        if (cl.lead_id) {
          const leadStatusMap = {
            'interested': 'interested',
            'not_interested': 'not_interested',
            'callback': 'callback',
            'no_answer': 'callback',
            'converted': 'converted',
            'contacted': 'contacted'
          };
          await base44.asServiceRole.entities.Lead.update(cl.lead_id, {
            status: leadStatusMap[outcome] || 'contacted',
            last_call_date: new Date().toISOString()
          });
          console.log(`[updateCallLog] Lead ${cl.lead_id} status → ${leadStatusMap[outcome] || 'contacted'}`);
        }

        // Update Campaign outcome counts
        const allCampaignLeads = await base44.asServiceRole.entities.CampaignLead.filter({ campaign_id: cl.campaign_id });
        const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
        let completedCount = 0;
        let failedCount = 0;

        allCampaignLeads.forEach(l => {
          if (l.status === 'completed') completedCount++;
          if (l.status === 'failed') failedCount++;
          if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++;
        });

        const campaignUpdate = {
          outcomes_summary: outcomes,
          calls_completed: completedCount,
          calls_failed: failedCount
        };

        // Check if all leads are done
        const pendingCount = allCampaignLeads.filter(l => ['pending', 'calling'].includes(l.status)).length;
        if (pendingCount === 0) {
          campaignUpdate.status = 'completed';
          campaignUpdate.completed_at = new Date().toISOString();
        }

        await base44.asServiceRole.entities.Campaign.update(cl.campaign_id, campaignUpdate);
        console.log(`[updateCallLog] Campaign ${cl.campaign_id} updated: completed=${completedCount}, failed=${failedCount}, pending=${pendingCount}`);
      }
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('updateCallLog error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});