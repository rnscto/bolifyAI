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
    const allDIDs = agent.assigned_dids || (agent.assigned_did ? [agent.assigned_did] : []);
    if (allDIDs.length === 0) {
      return Response.json({ 
        success: false,
        error: 'No DID assigned to agent. Please assign a DID to the agent before making calls.' 
      }, { status: 400 });
    }

    // Use primary DID for single calls
    const callerDID = allDIDs[0];

    // Create call log
    const callLog = await base44.asServiceRole.entities.CallLog.create({
      client_id: agent.client_id,
      agent_id: agent_id,
      lead_id: lead_id,
      call_sid: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      caller_id: callerDID,
      callee_number: phone_number,
      direction: 'outbound',
      status: 'initiated',
      call_start_time: new Date().toISOString()
    });

    // Clean phone number (remove + and non-digits)
    const cleanCallerID = callerDID.replace(/\D/g, '');
    const cleanPhoneNumber = phone_number.replace(/\D/g, '');

    // Initiate call via Smartflo Click-to-Call Support API
    const smartfloResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: Deno.env.get('SMARTFLO_API_KEY'),
        customer_number: cleanPhoneNumber,
        caller_id: cleanCallerID,
        async: 1
      })
    });

    const smartfloData = await smartfloResponse.json();
    console.log('Smartflo response:', JSON.stringify(smartfloData));

    if (!smartfloResponse.ok || smartfloData.success === false) {
      const errorMsg = smartfloData.message || 'Unknown error';
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