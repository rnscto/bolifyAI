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

    // Use the fixed WebSocket URL configured in agent settings
    if (!agent.wss_url) {
      return Response.json({ 
        success: false, 
        error: 'Agent WSS URL not configured. Please set the WebSocket URL in agent settings.' 
      }, { status: 400 });
    }

    const streamUrl = `${agent.wss_url}?call_sid=${callLog.call_sid}`;

    // Initiate call via Smartflo API
    const smartfloResponse = await fetch('https://api.smartflo.ai/v1/calls', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('SMARTFLO_API_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: agent.assigned_did,
        to: phone_number,
        webhook_url: `${req.headers.get('origin')}/api/functions/smartfloWebhook`,
        stream_url: streamUrl
      })
    });

    if (!smartfloResponse.ok) {
      await base44.asServiceRole.entities.CallLog.update(callLog.id, {
        status: 'failed'
      });
      return Response.json({ 
        success: false, 
        error: 'Failed to initiate call with Smartflo' 
      }, { status: 500 });
    }

    const smartfloData = await smartfloResponse.json();

    // Update call log with Smartflo call SID
    await base44.asServiceRole.entities.CallLog.update(callLog.id, {
      call_sid: smartfloData.call_sid || callLog.call_sid,
      stream_sid: smartfloData.stream_sid,
      status: 'ringing'
    });

    return Response.json({
      success: true,
      call_id: callLog.id,
      call_sid: smartfloData.call_sid,
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