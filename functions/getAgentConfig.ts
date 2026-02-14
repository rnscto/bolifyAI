import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

// In-memory cache for agent configs, keyed by call_sid
// Set by initiateCall/executeCampaign before the call is placed
const agentConfigCache = globalThis.__agentConfigCache || (globalThis.__agentConfigCache = new Map());

Deno.serve(async (req) => {
  try {
    // Inject Base44-App-Id if missing
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
    const { call_sid, stream_sid, agent_id, action } = body;

    // === CACHE WRITE: called by initiateCall to pre-store config ===
    if (action === 'cache_config') {
      const { config_key, config_data } = body;
      if (config_key && config_data) {
        agentConfigCache.set(config_key, { ...config_data, _cached_at: Date.now() });
        // Clean old entries (>10min)
        for (const [key, val] of agentConfigCache) {
          if (Date.now() - val._cached_at > 600000) agentConfigCache.delete(key);
        }
        console.log(`[getAgentConfig] Cached config for key: ${config_key}`);
        return Response.json({ success: true, cached: true });
      }
      return Response.json({ error: 'Missing config_key or config_data' }, { status: 400 });
    }

    // === CACHE READ: called by streamAudio to retrieve pre-stored config ===
    if (action === 'get_cached_config') {
      const { config_key } = body;
      const cached = agentConfigCache.get(config_key);
      if (cached) {
        console.log(`[getAgentConfig] Cache hit for key: ${config_key}`);
        agentConfigCache.delete(config_key); // One-time read
        return Response.json({ success: true, ...cached });
      }
      console.log(`[getAgentConfig] Cache miss for key: ${config_key}`);
      return Response.json({ success: false, error: 'Not in cache' });
    }

    // === STANDARD LOOKUP (requires asServiceRole) ===
    if (!call_sid && !stream_sid && !agent_id) {
      return Response.json({ error: 'call_sid, stream_sid, or agent_id required' }, { status: 400 });
    }

    let resolvedAgentId = agent_id;
    let callLogId = null;

    if (!agent_id) {
      let callLog = null;

      if (call_sid) {
        const logs = await base44.asServiceRole.entities.CallLog.filter({ call_sid });
        if (logs.length > 0) callLog = logs[0];
      }

      if (!callLog && stream_sid) {
        const logs = await base44.asServiceRole.entities.CallLog.filter({ stream_sid });
        if (logs.length > 0) callLog = logs[0];
      }

      if (!callLog) {
        const recentLogs = await base44.asServiceRole.entities.CallLog.filter(
          { status: 'ringing' }, '-created_date', 1
        );
        if (recentLogs.length > 0) callLog = recentLogs[0];
        if (!callLog) {
          const initiatedLogs = await base44.asServiceRole.entities.CallLog.filter(
            { status: 'initiated' }, '-created_date', 1
          );
          if (initiatedLogs.length > 0) callLog = initiatedLogs[0];
        }
      }

      if (callLog) {
        callLogId = callLog.id;
        resolvedAgentId = callLog.agent_id;

        const updateData = {};
        if (stream_sid && !callLog.stream_sid) updateData.stream_sid = stream_sid;
        if (call_sid && callLog.call_sid !== call_sid) updateData.call_sid = call_sid;
        if (Object.keys(updateData).length > 0) {
          await base44.asServiceRole.entities.CallLog.update(callLog.id, updateData);
        }
      } else {
        return Response.json({ 
          success: false, error: 'Call log not found',
          callLogId: null, agent: null, knowledgeDocs: []
        });
      }
    }

    if (!resolvedAgentId) {
      return Response.json({ 
        success: false, error: 'No agent_id found',
        callLogId, agent: null, knowledgeDocs: []
      });
    }

    const agent = await base44.asServiceRole.entities.Agent.get(resolvedAgentId);
    if (!agent) {
      return Response.json({ 
        success: false, error: 'Agent not found',
        callLogId, agent: null, knowledgeDocs: []
      });
    }

    const knowledgeDocs = [];
    if (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await base44.asServiceRole.entities.KnowledgeBase.get(kbId);
          if (doc && doc.content) knowledgeDocs.push({ title: doc.title, content: doc.content });
        } catch (err) {
          console.error(`Failed to load KB doc ${kbId}:`, err.message);
        }
      }
    }

    return Response.json({
      success: true,
      callLogId,
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