import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

// Call Transfer / Monitor / Whisper / Barge-in via Smartflo API
// Types: 1=Monitor, 2=Whisper, 3=Barge, 4=Transfer

// In-memory token cache (per-isolate) — avoids repeated logins that trigger lockouts.
// Token reused for TOKEN_TTL_MS; concurrent calls share a single in-flight login via loginPromise.
// Honors Smartflo's `retry_after` response to back off when rate-limited.
let cachedToken = null;
let cachedAt = 0;
let loginPromise = null;
let blockedUntil = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

async function performSmartfloLogin() {
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
  const loginData = await loginResp.json().catch(() => ({}));
  const token = loginData.access_token || loginData.token;
  if (!loginResp.ok || !token) {
    // Honor retry_after on 429
    if (loginResp.status === 429 || loginData.retry_after) {
      let cooldownMs = 10 * 60 * 1000;
      if (loginData.retry_after) {
        const ra = new Date(loginData.retry_after.replace(' ', 'T') + '+05:30').getTime();
        if (!isNaN(ra) && ra > Date.now()) cooldownMs = ra - Date.now() + 5000;
      }
      blockedUntil = Date.now() + cooldownMs;
      throw new Error(`Smartflo rate-limited until ${new Date(blockedUntil).toISOString()} (${loginData.retry_after || 'no retry_after'})`);
    }
    throw new Error(`Smartflo login failed: ${loginData.message || loginResp.status}`);
  }
  console.log('[callTransfer] Smartflo login successful (token cached)');
  return token;
}

async function getSmartfloToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && (now - cachedAt) < TOKEN_TTL_MS) {
    return cachedToken;
  }
  if (blockedUntil > now) {
    const waitSec = Math.ceil((blockedUntil - now) / 1000);
    throw new Error(`Smartflo login is rate-limited — retry in ${waitSec}s`);
  }
  // Mutex: only one login in flight at a time
  if (!loginPromise) {
    loginPromise = performSmartfloLogin()
      .then(t => { cachedToken = t; cachedAt = Date.now(); blockedUntil = 0; return t; })
      .finally(() => { loginPromise = null; });
  }
  return await loginPromise;
}

function clearSmartfloTokenCache() {
  cachedToken = null;
  cachedAt = 0;
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

    // Get Smartflo JWT token (cached)
    let smartfloToken = await getSmartfloToken();

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

    let response = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${smartfloToken}`
      },
      body: JSON.stringify(body)
    });

    // If token rejected (401/403), clear cache and retry ONCE with fresh login
    if (response.status === 401 || response.status === 403) {
      console.log('[callTransfer] Token rejected, refreshing and retrying once...');
      clearSmartfloTokenCache();
      smartfloToken = await getSmartfloToken(true);
      response = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${smartfloToken}`
        },
        body: JSON.stringify(body)
      });
    }

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