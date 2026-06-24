import { createClient } from 'npm:@base44/sdk@0.8.31';

// DEPRECATED: This function duplicates updateCallLog's get_agent_config action.
// Kept for backward compatibility but streamAudio now loads config directly from CallLog.agent_config_cache.

Deno.serve(async (req) => {
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const base44 = createClient({ appId, asServiceRole: true });

    const { call_sid, stream_sid, agent_id } = await req.json();

    if (!call_sid && !stream_sid && !agent_id) {
      return Response.json({ error: 'call_sid, stream_sid, or agent_id required' }, { status: 400 });
    }

    let resolvedAgentId = agent_id;
    let callLogId = null;

    // Try to find call log by multiple strategies
    if (!agent_id) {
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

      // Strategy 3: Find most recent active (initiated/ringing) call log
      if (!callLog) {
        console.log('Trying fallback: most recent active call log');
        const recentLogs = await base44.entities.CallLog.filter(
          { status: 'ringing' }, '-created_date', 1
        );
        if (recentLogs.length > 0) {
          callLog = recentLogs[0];
          console.log(`Fallback matched call log ${callLog.id} (status: ${callLog.status}, call_sid: ${callLog.call_sid})`);
        }
        if (!callLog) {
          const initiatedLogs = await base44.entities.CallLog.filter(
            { status: 'initiated' }, '-created_date', 1
          );
          if (initiatedLogs.length > 0) {
            callLog = initiatedLogs[0];
            console.log(`Fallback matched initiated call log ${callLog.id}`);
          }
        }
      }

      if (callLog) {
        callLogId = callLog.id;
        resolvedAgentId = callLog.agent_id;

        // Update call log with stream_sid and call_sid for future matching
        const updateData = {};
        if (stream_sid && !callLog.stream_sid) updateData.stream_sid = stream_sid;
        if (call_sid && callLog.call_sid !== call_sid) updateData.call_sid = call_sid;
        if (Object.keys(updateData).length > 0) {
          await base44.entities.CallLog.update(callLog.id, updateData);
          console.log(`Updated call log ${callLog.id} with:`, JSON.stringify(updateData));
        }
      } else {
        return Response.json({ 
          success: false, 
          error: 'Call log not found',
          callLogId: null,
          agent: null,
          knowledgeDocs: []
        });
      }
    }

    if (!resolvedAgentId) {
      return Response.json({ 
        success: false, 
        error: 'No agent_id found',
        callLogId,
        agent: null,
        knowledgeDocs: []
      });
    }

    // Fetch agent
    const agent = await base44.entities.Agent.get(resolvedAgentId);
    if (!agent) {
      return Response.json({ 
        success: false, 
        error: 'Agent not found',
        callLogId,
        agent: null,
        knowledgeDocs: []
      });
    }

    // Fetch knowledge base documents
    const knowledgeDocs = [];
    if (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await base44.entities.KnowledgeBase.get(kbId);
          if (doc && doc.content) {
            knowledgeDocs.push({ title: doc.title, content: doc.content });
          }
        } catch (err) {
          console.error(`Failed to load KB doc ${kbId}:`, err.message);
        }
      }
    }

    return Response.json({
      success: true,
      callLogId: callLogId,
      agent: {
        id: agent.id,
        name: agent.name,
        system_prompt: agent.system_prompt || '',
        persona: agent.persona || {},
        knowledge_base_ids: agent.knowledge_base_ids || []
      },
      knowledgeDocs
    });

  } catch (error) {
    console.error('getAgentConfig error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});