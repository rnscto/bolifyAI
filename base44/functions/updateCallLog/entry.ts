import { createClient } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    // Called from streamAudio (no user session) — use service role
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    const body = await req.json();
    const { action } = body;

    // === GET AGENT CONFIG action: find call log + load agent + knowledge base ===
    if (action === 'get_agent_config') {
      const { call_sid, stream_sid } = body;
      console.log(`[updateCallLog] get_agent_config: call_sid=${call_sid}, stream_sid=${stream_sid}`);

      let callLog = null;

      // Strategy 1: Match by call_sid
      if (call_sid) {
        const logs = await base44.entities.CallLog.filter({ call_sid });
        if (logs.length > 0) callLog = logs[0];
      }

      // Strategy 2: Match by stream_sid
      if (!callLog && stream_sid) {
        const logs = await base44.entities.CallLog.filter({ stream_sid });
        if (logs.length > 0) callLog = logs[0];
      }

      // Strategy 3: Most recent ringing/initiated call
      if (!callLog) {
        const recentLogs = await base44.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 1);
        if (recentLogs.length > 0) callLog = recentLogs[0];
        if (!callLog) {
          const initiatedLogs = await base44.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 1);
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
        await base44.entities.CallLog.update(callLog.id, updateFields);
      }

      // Fetch agent
      let agent = null;
      let knowledgeDocs = [];
      if (callLog.agent_id) {
        try {
          agent = await base44.entities.Agent.get(callLog.agent_id);
        } catch (e) {
          console.error(`[updateCallLog] Agent fetch failed: ${e.message}`);
        }

        // Fetch knowledge base
        if (agent && agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
          for (const kbId of agent.knowledge_base_ids) {
            try {
              const doc = await base44.entities.KnowledgeBase.get(kbId);
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
    const currentCallLog = await base44.entities.CallLog.get(call_log_id);

    const updateData = {};
    if (status) updateData.status = status;
    if (transcript) updateData.transcript = transcript;
    if (duration !== undefined) updateData.duration = duration;
    if (call_end_time) updateData.call_end_time = call_end_time;
    if (conversation_summary) updateData.conversation_summary = conversation_summary;

    await base44.entities.CallLog.update(call_log_id, updateData);

    // NOTE: Campaign lead updates are handled by the campaignPostCall entity automation
    // triggered by CallLog status changes. No duplicate campaign logic here.

    return Response.json({ success: true });
  } catch (error) {
    console.error('updateCallLog error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});