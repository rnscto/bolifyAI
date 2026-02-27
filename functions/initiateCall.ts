import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { lead_id, agent_id, phone_number } = await req.json();

    if (!lead_id || !agent_id || !phone_number) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get agent and lead details
    const [agent, lead] = await Promise.all([
      base44.asServiceRole.entities.Agent.get(agent_id),
      base44.asServiceRole.entities.Lead.get(lead_id)
    ]);

    if (!agent) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }

    if (!lead) {
      return Response.json({ error: 'Lead not found' }, { status: 404 });
    }

    // Ownership validation: ensure the user owns this client's agent and lead
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    const userClientIds = clients.map(c => c.id);
    
    if (!userClientIds.includes(agent.client_id)) {
      return Response.json({ error: 'Forbidden: Agent does not belong to your account' }, { status: 403 });
    }
    if (!userClientIds.includes(lead.client_id)) {
      return Response.json({ error: 'Forbidden: Lead does not belong to your account' }, { status: 403 });
    }

    // Support multiple DIDs - pick first available
    const allDIDs = (agent.assigned_dids && agent.assigned_dids.length > 0)
      ? agent.assigned_dids
      : (agent.assigned_did ? [agent.assigned_did] : []);
    if (allDIDs.length === 0) {
      return Response.json({ 
        success: false,
        error: 'No DID assigned to agent. Please assign a DID to the agent before making calls.' 
      }, { status: 400 });
    }

    // Use primary DID for single calls
    const callerDID = allDIDs[0];

    // Pre-fetch knowledge base content for agent config cache
    let kbContent = '';
    if (agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0) {
      const kbDocs = [];
      for (const kbId of agent.knowledge_base_ids) {
        try {
          const doc = await base44.asServiceRole.entities.KnowledgeBase.get(kbId);
          if (doc && doc.content) kbDocs.push({ title: doc.title, content: doc.content });
        } catch (e) {
          console.log(`KB doc ${kbId} fetch failed: ${e.message}`);
        }
      }
      if (kbDocs.length > 0) {
        kbContent = kbDocs.map(doc => `[${doc.title}]\n${doc.content}`).join('\n\n---\n\n');
      }
    }

    // Build personalized lead context (name, history, score, sentiment, notes)
    let leadContext = '';
    try {
      const ctxRes = await base44.asServiceRole.functions.invoke('buildLeadContext', {
        lead_id, client_id: agent.client_id, phone_number
      });
      if (ctxRes?.context_text) leadContext = ctxRes.context_text;
    } catch (e) {
      console.log('Lead context build failed:', e.message);
    }

    // Combine agent system prompt with lead personalization
    const personalizedPrompt = [
      agent.system_prompt || '',
      leadContext ? `\n\n--- LEAD CONTEXT (use this to personalize the conversation) ---\n${leadContext}` : ''
    ].filter(Boolean).join('\n');

    // Create call log with cached agent config (so streamAudio WebSocket can read it without cross-function calls)
    const callLog = await base44.asServiceRole.entities.CallLog.create({
      client_id: agent.client_id,
      agent_id: agent_id,
      lead_id: lead_id,
      call_sid: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      caller_id: callerDID,
      callee_number: phone_number,
      direction: 'outbound',
      status: 'initiated',
      call_start_time: new Date().toISOString(),
      conversation_summary: leadContext ? `[LEAD CONTEXT]\n${leadContext}` : '',
      agent_config_cache: {
        agent_name: agent.name,
        system_prompt: personalizedPrompt,
        persona: agent.persona || {},
        knowledge_base_content: kbContent,
        lead_context: leadContext
      }
    });

    // Clean phone number — strip non-digits and country code for Smartflo
    const cleanCallerID = callerDID.replace(/[^0-9]/g, ''); // Smartflo expects format: 91XXXXXXXXXX
    const cleanPhoneNumber = phone_number.replace(/[^0-9]/g, '');
    const smartfloCustomerNumber = cleanPhoneNumber.startsWith('91') ? cleanPhoneNumber : `91${cleanPhoneNumber}`;

    console.log(`Smartflo request: caller_id=${cleanCallerID}, customer_number=${smartfloCustomerNumber}, original_did=${callerDID}`);

    // Initiate call via Smartflo Click-to-Call Support API
    const smartfloResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: Deno.env.get('SMARTFLO_API_KEY'),
        customer_number: smartfloCustomerNumber,
        caller_id: cleanCallerID,
        async: 1
      })
    });

    const smartfloData = await smartfloResponse.json();
    console.log('Smartflo response:', JSON.stringify(smartfloData));

    // Detect Smartflo errors - they sometimes return field-level errors like {"caller_id": "Provide a vaild caller_id."}
    const isSmartfloError = !smartfloResponse.ok || 
      smartfloData.success === false ||
      (typeof smartfloData.caller_id === 'string' && smartfloData.caller_id.toLowerCase().includes('provide')) ||
      (!smartfloData.ref_id && !smartfloData.call_id && !smartfloData.call_sid);

    if (isSmartfloError) {
      const errorMsg = smartfloData.message || smartfloData.caller_id || JSON.stringify(smartfloData);
      console.error('Smartflo API error:', errorMsg);
      
      await base44.asServiceRole.entities.CallLog.update(callLog.id, {
        status: 'failed'
      });
      
      return Response.json({ 
        success: false, 
        error: `Failed to initiate call: ${errorMsg}` 
      }, { status: 400 });
    }

    // Update call log with Smartflo response
    await base44.asServiceRole.entities.CallLog.update(callLog.id, {
      call_sid: smartfloData.call_id || smartfloData.call_sid || callLog.call_sid,
      status: 'ringing'
    });

    // Update lead status
    await base44.asServiceRole.entities.Lead.update(lead_id, {
      status: 'contacted',
      last_call_date: new Date().toISOString()
    });

    return Response.json({
      success: true,
      call_id: callLog.id,
      call_sid: smartfloData.call_id || smartfloData.call_sid,
      message: 'Call initiated successfully'
    });

  } catch (error) {
    console.error('Error initiating call:', error);
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
});