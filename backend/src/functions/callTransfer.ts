import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Call Transfer / Monitor / Whisper / Barge-in via Smartflo API
// Types: 1=Monitor, 2=Whisper, 3=Barge, 4=Transfer

// Smartflo JWT token with in-memory cache to avoid rate-limiting.
// Cache also tracks the credentials it was minted with — so a SMARTFLO_PASSWORD
// change auto-invalidates the cache on the very next call.
let _cachedToken = null;
let _tokenExpiry = 0;
let _cachedCredHash = '';
let _consecutiveFailures = 0;
let _lockoutUntil = 0;

function credHash(email, password) {
  // Lightweight hash — not for security, just to detect credential changes
  return `${email}::${(password || '').length}::${(password || '').slice(-3)}`;
}

async function getSmartfloToken(forceRefresh = false) {
  const email = Deno.env.get('SMARTFLO_EMAIL');
  const password = Deno.env.get('SMARTFLO_PASSWORD');
  if (!email || !password) {
    throw new Error('SMARTFLO_EMAIL or SMARTFLO_PASSWORD not configured');
  }
  const currentHash = credHash(email, password);

  // Return cached token if still valid AND credentials haven't changed
  if (!forceRefresh && _cachedToken && Date.now() < _tokenExpiry && _cachedCredHash === currentHash) {
    console.log('[callTransfer] Using cached Smartflo token');
    return _cachedToken;
  }

  if (_cachedCredHash && _cachedCredHash !== currentHash) {
    console.log('[callTransfer] 🔄 Credentials changed — invalidating cached token and resetting failure counter');
    _cachedToken = null; _tokenExpiry = 0; _consecutiveFailures = 0; _lockoutUntil = 0;
  }

  // Lockout guard: pause after 3 consecutive failures to prevent Smartflo account lockout
  if (Date.now() < _lockoutUntil) {
    const waitMin = Math.ceil((_lockoutUntil - Date.now()) / 60000);
    throw new Error(`Smartflo login paused for ${waitMin} more minute(s) due to repeated failures — preventing account lockout`);
  }

  const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  const loginData = await loginResp.json();
  const token = loginData.access_token || loginData.token;
  if (!loginResp.ok || !token) {
    _cachedToken = null; _tokenExpiry = 0; _cachedCredHash = '';
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= 3) {
      _lockoutUntil = Date.now() + 15 * 60 * 1000;
      console.error(`[callTransfer] 🚨 ${_consecutiveFailures} consecutive login failures — pausing for 15 min to prevent Smartflo lockout`);
    }
    throw new Error(`Smartflo login failed: ${loginData.message || loginResp.status}`);
  }

  _cachedToken = token;
  _tokenExpiry = Date.now() + 10 * 60 * 1000; // 10 min cache
  _cachedCredHash = currentHash;
  _consecutiveFailures = 0;
  _lockoutUntil = 0;
  console.log('[callTransfer] Smartflo login successful (token cached)');
  return token;
}

export default async function callTransfer(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { call_log_id, type, agent_id, intercom } = await c.req.json();

    if (!call_log_id || !type) {
      return c.json({ data: { error: 'Missing call_log_id or type' } }, 400);
    }

    if (![1, 2, 3, 4].includes(type)) {
      return c.json({ data: { error: 'Invalid type. Must be 1 (Monitor), 2 (Whisper), 3 (Barge), or 4 (Transfer)' } }, 400);
    }

    // Get the CallLog to find the Smartflo call_id
    const callLog = await base44.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return c.json({ data: { error: 'CallLog not found' } }, 404);
    }

    const smartfloCallId = callLog.call_sid;
    if (!smartfloCallId) {
      return c.json({ data: { error: 'No Smartflo call_sid found on this call log' } }, 400);
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
      return c.json({ data: { error: 'Transfer requires an intercom/extension number. Configure human_transfer_number on the agent or pass intercom parameter.' } }, 400);
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
      return c.json({ data: { error: 'Monitor/Whisper/Barge requires a Smartflo agent_id. Configure smartflo_agent_id on the agent or pass agent_id parameter.' } }, 400);
    }

    // Get Smartflo JWT token dynamically via login
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

    const doCall = async (tok) => fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tok}`
      },
      body: JSON.stringify(body)
    });

    let response = await doCall(smartfloToken);
    let responseData = await response.json();
    console.log(`[callTransfer] Smartflo response: ${response.status}`, JSON.stringify(responseData));

    // Auto-retry on auth failure (stale cached token after password change)
    if (response.status === 401 || response.status === 403) {
      console.log('[callTransfer] 🔄 Auth failed — forcing fresh login and retrying');
      smartfloToken = await getSmartfloToken(true);
      response = await doCall(smartfloToken);
      responseData = await response.json();
      console.log(`[callTransfer] Retry response: ${response.status}`, JSON.stringify(responseData));
    }

    if (!response.ok) {
      return c.json({ data: {
        error: `Smartflo API error: ${response.status}`,
        detail: responseData
      } }, response.status);
    }

    // Log the action
    
    const svc = base44;;

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

    return c.json({ data: {
      success: true,
      action: typeLabels[type],
      call_id: smartfloCallId,
      smartflo_response: responseData
    } });

  } catch (error) {
    console.error('[callTransfer] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};