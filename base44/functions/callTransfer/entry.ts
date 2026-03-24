import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

// Call Transfer / Monitor / Whisper / Barge-in via Smartflo API
// Types: 1=Monitor, 2=Whisper, 3=Barge, 4=Transfer

// Dynamically get Smartflo JWT token via login API
async function getSmartfloToken() {
  const email = Deno.env.get('SMARTFLO_EMAIL');
  const password = Deno.env.get('SMARTFLO_PASSWORD');
  if (!email || !password) {
    throw new Error('SMARTFLO_EMAIL or SMARTFLO_PASSWORD not configured');
  }

  const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  const loginData = await loginResp.json();
  if (!loginResp.ok || !loginData.token) {
    throw new Error(`Smartflo login failed: ${loginData.message || loginResp.status}`);
  }
  console.log('[callTransfer] Smartflo login successful');
  return loginData.token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { call_log_id, type, agent_id, intercom } = await req.json();

    if (!call_log_id || !type) {
      return Response.json({ error: 'Missing call_log_id or type' }, { status: 400 });
    }

    if (![1, 2, 3, 4].includes(type)) {
      return Response.json({ error: 'Invalid type. Must be 1 (Monitor), 2 (Whisper), 3 (Barge), or 4 (Transfer)' }, { status: 400 });
    }

    // Get the CallLog to find the Smartflo call_id
    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return Response.json({ error: 'CallLog not found' }, { status: 404 });
    }

    const smartfloCallId = callLog.call_sid;
    if (!smartfloCallId) {
      return Response.json({ error: 'No Smartflo call_sid found on this call log' }, { status: 400 });
    }

    // For transfer (type=4), we need an intercom number
    // Try from parameter, then from agent config
    let transferIntercom = intercom;
    if (type === 4 && !transferIntercom && callLog.agent_id) {
      try {
        const agent = await base44.entities.Agent.get(callLog.agent_id);
        transferIntercom = agent?.human_transfer_number;
      } catch (_) {}
    }

    if (type === 4 && !transferIntercom) {
      return Response.json({ error: 'Transfer requires an intercom/extension number. Configure human_transfer_number on the agent or pass intercom parameter.' }, { status: 400 });
    }

    // For monitor/whisper/barge (type 1-3), we need agent_id
    // Try from parameter, then from agent config
    let smartfloAgentId = agent_id;
    if ([1, 2, 3].includes(type) && !smartfloAgentId && callLog.agent_id) {
      try {
        const agent = await base44.entities.Agent.get(callLog.agent_id);
        smartfloAgentId = agent?.smartflo_agent_id;
      } catch (_) {}
    }

    if ([1, 2, 3].includes(type) && !smartfloAgentId) {
      return Response.json({ error: 'Monitor/Whisper/Barge requires a Smartflo agent_id. Configure smartflo_agent_id on the agent or pass agent_id parameter.' }, { status: 400 });
    }

    // Build Smartflo API request
    const smartfloToken = Deno.env.get('SMARTFLO_AUTH_TOKEN');
    if (!smartfloToken) {
      return Response.json({ error: 'SMARTFLO_AUTH_TOKEN not configured' }, { status: 500 });
    }

    const body = {
      type: type,
      call_id: smartfloCallId,
    };

    if ([1, 2, 3].includes(type)) {
      body.agent_id = parseInt(smartfloAgentId);
    }

    if (type === 4) {
      body.intercom = String(transferIntercom);
    }

    const typeLabels = { 1: 'Monitor', 2: 'Whisper', 3: 'Barge', 4: 'Transfer' };
    console.log(`[callTransfer] ${typeLabels[type]} request: call_id=${smartfloCallId}, agent_id=${smartfloAgentId}, intercom=${transferIntercom}`);

    const response = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': smartfloToken
      },
      body: JSON.stringify(body)
    });

    const responseData = await response.json();
    console.log(`[callTransfer] Smartflo response: ${response.status}`, JSON.stringify(responseData));

    if (!response.ok) {
      return Response.json({
        error: `Smartflo API error: ${response.status}`,
        detail: responseData
      }, { status: response.status });
    }

    // Log the action
    const { createClient } = await import('npm:@base44/sdk@0.8.21');
    const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

    // Update CallLog with transfer info
    if (type === 4) {
      await svc.entities.CallLog.update(call_log_id, {
        transferred_to: `Human agent (intercom: ${transferIntercom})`
      });
    }

    // Audit log
    await svc.entities.AuditLog.create({
      client_id: callLog.client_id,
      action_type: 'call_initiated',
      entity_type: 'CallLog',
      entity_id: call_log_id,
      actor_email: user.email,
      actor_role: user.role,
      details: `${typeLabels[type]} action on call ${smartfloCallId}${type === 4 ? ` → intercom ${transferIntercom}` : ` by agent ${smartfloAgentId}`}`
    });

    return Response.json({
      success: true,
      action: typeLabels[type],
      call_id: smartfloCallId,
      smartflo_response: responseData
    });

  } catch (error) {
    console.error('[callTransfer] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});