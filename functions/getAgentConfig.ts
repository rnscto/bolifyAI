import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req, {
      apiUrl: 'https://app.base44.com'
    });
    const { call_sid, agent_id } = await req.json();

    if (!call_sid && !agent_id) {
      return Response.json({ error: 'call_sid or agent_id required' }, { status: 400 });
    }

    let resolvedAgentId = agent_id;
    let callLogId = null;

    // If call_sid provided, look up the call log to get agent_id
    if (call_sid && !agent_id) {
      const callLogs = await base44.asServiceRole.entities.CallLog.filter({ call_sid });
      if (callLogs.length > 0) {
        callLogId = callLogs[0].id;
        resolvedAgentId = callLogs[0].agent_id;
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
    const agent = await base44.asServiceRole.entities.Agent.get(resolvedAgentId);
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
          const doc = await base44.asServiceRole.entities.KnowledgeBase.get(kbId);
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