import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

    // Get agent details
    const agent = await base44.asServiceRole.entities.Agent.get(agent_id);
    if (!agent) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }

    if (!agent.assigned_did || agent.assigned_did.trim() === '') {
      return Response.json({ 
        success: false,
        error: 'No DID assigned to agent. Please assign a DID to the agent before making calls.' 
      }, { status: 400 });
    }

    // Create call log
    const callLog = await base44.asServiceRole.entities.CallLog.create({
      client_id: agent.client_id,
      agent_id: agent_id,
      lead_id: lead_id,
      call_sid: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      caller_id: agent.assigned_did,
      callee_number: phone_number,
      direction: 'outbound',
      status: 'initiated',
      call_start_time: new Date().toISOString()
    });

    // Get the WSS callback URL from environment or construct it
    let wssUrl = Deno.env.get('DENO_DEPLOY_URL');
    if (!wssUrl) {
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
      if (host) {
        wssUrl = `wss://${host}/functions/streamAudio`;
      }
    } else {
      wssUrl = `${wssUrl.replace('https://', 'wss://').replace('http://', 'wss://')}/functions/streamAudio`;
    }

    if (!wssUrl) {
      return Response.json({ 
        success: false,
        error: 'Could not determine WebSocket URL.'
      }, { status: 500 });
    }

    console.log('WSS URL configured:', wssUrl);
    console.log('Call SID:', callLog.call_sid);

    // Authenticate with Smartflo
    const authResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: Deno.env.get('SMARTFLO_EMAIL'),
        password: Deno.env.get('SMARTFLO_PASSWORD')
      })
    });

    if (!authResponse.ok) {
      return Response.json({ success: false, error: 'Smartflo auth failed' }, { status: 500 });
    }

    const authData = await authResponse.json();
    const smartfloToken = authData.access_token;

    // Create voice streaming endpoint
    const endpointResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/voice_streaming/endpoints', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${smartfloToken}`
      },
      body: JSON.stringify({
        name: `endpoint_${callLog.call_sid}`,
        url: wssUrl,
        type: 'voice_bot'
      })
    });

    let endpointId = null;
    if (endpointResponse.ok) {
      const endpointData = await endpointResponse.json();
      endpointId = endpointData.id || endpointData.endpoint_id;
      console.log('Endpoint created:', endpointId);
    } else {
      console.log('Endpoint creation failed:', await endpointResponse.text());
    }

    // Initiate call with endpoint ID
    const smartfloResponse = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: Deno.env.get('SMARTFLO_API_KEY'),
        customer_number: phone_number,
        caller_id: agent.assigned_did.replace('+', ''),
        voice_streaming_endpoint_id: endpointId,
        async: 1
      })
    });

    if (!smartfloResponse.ok) {
      const errorText = await smartfloResponse.text();
      console.error('Smartflo API error:', errorText);
      
      await base44.asServiceRole.entities.CallLog.update(callLog.id, {
        status: 'failed'
      });
      
      return Response.json({ 
        success: false, 
        error: `Failed to initiate call: ${errorText}` 
      }, { status: 500 });
    }

    const smartfloData = await smartfloResponse.json();

    // Update call log with response data
    await base44.asServiceRole.entities.CallLog.update(callLog.id, {
      call_sid: smartfloData.call_id || smartfloData.call_sid || callLog.call_sid,
      status: 'ringing'
    });

    return Response.json({
      success: true,
      call_id: callLog.id,
      call_sid: smartfloData.call_id || smartfloData.call_sid,
      message: 'Call initiated successfully',
      smartflo_response: smartfloData
    });

  } catch (error) {
    console.error('Error initiating call:', error);
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
});