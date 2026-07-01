import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Auto-provisions Smartflo agents for every Voice Agent belonging to a client
// once the Call Transfer add-on is enabled.
//
// TRIGGERED BY:
//   1. Client entity automation when `call_transfer_enabled` flips from false → true.
//   2. Manual admin invocation: { client_id } in the payload.
//
// WHAT IT DOES (for each Agent owned by the client that does NOT already have
// smartflo_agent_id set):
//   - Calls Smartflo's "create agent" REST endpoint (see TODO below)
//   - Stores the returned Smartflo agent ID on Agent.smartflo_agent_id
//   - This enables call monitor / whisper / barge / transfer features
//
// IMPORTANT: The Smartflo REST endpoint for creating an agent is not in public
// docs. You (the builder) need to capture the exact request via browser DevTools:
//   1. Log in to Smartflo admin panel
//   2. Open DevTools → Network tab, filter XHR/Fetch
//   3. Create a new agent manually in the UI
//   4. Inspect the POST request — copy Request URL, headers, and body
//   5. Paste them into the SMARTFLO_CREATE_AGENT_* constants below
//
// Until those constants are filled in, this function will log the intended
// payload and mark agents with a `smartflo_agent_id` of "PENDING_API_CAPTURE"
// so you can track which ones still need real provisioning.



// ═══════════════════════════════════════════════════════════════════════
// Smartflo user/agent creation endpoint
// (confirm exact payload keys via DevTools — adjust buildSmartfloAgentPayload below if needed)
// ═══════════════════════════════════════════════════════════════════════
const SMARTFLO_CREATE_AGENT_URL = 'https://api-smartflo.tatateleservices.com/v1/user';
const SMARTFLO_CREATE_AGENT_METHOD = 'POST';

// Generate a safe random password for the Smartflo agent account
function randomPassword() {
  return 'Vaani' + Math.random().toString(36).slice(-8) + '!' + Math.floor(Math.random() * 99);
}

// Derive a unique login_id/username for Smartflo from our agent + client
function deriveLoginId(agent, client) {
  const slug = (agent.name || 'agent').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const clientSlug = (client.company_name || 'c').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const rand = Math.random().toString(36).slice(-4);
  return `${clientSlug}_${slug}_${rand}`;
}

// Build the body Smartflo expects for POST /v1/user.
// Spec: https://docs.smartflo.tatatelebusiness.com/reference/create-user
// Required: create_agent, status, name, number, email, login_id, user_role, password, caller_id
function buildSmartfloAgentPayload(agent, client, callerIds) {
  const payload = {
    create_agent: true,
    status: true,
    block_web_login: true,             // AI agent doesn't need web UI access
    login_based_calling: false,
    name: agent.name,
    number: client.phone || agent.human_transfer_number || '',
    email: client.email,
    login_id: deriveLoginId(agent, client),
    user_role: parseInt(Deno.env.get('SMARTFLO_AGENT_ROLE_ID') || '0', 10), // Role ID — set SMARTFLO_AGENT_ROLE_ID secret
    password: randomPassword(),
    caller_id: callerIds,              // array of numbers — per Smartflo UI, this is the DID phone number itself
    route_call_through: 2,             // BOTH (agent + extension) — needed for transfer
    assign_extension: true             // Create an Agent Extension (Intercom Number) for transfers
  };
  return payload;
}

// Fetch the Smartflo /v1/my_number directory and build a phone-number → numeric-id map.
// Smartflo returns records like { id: "1759333", did: "+918065485979", alias: "918065485979" }
// and the `id` field is what must be passed as caller_id when creating a user.
async function fetchSmartfloDidDirectory(authToken) {
  const res = await fetch('https://api-smartflo.tatateleservices.com/v1/my_number', {
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${authToken}` }
  });
  if (!res.ok) throw new Error(`Smartflo /v1/my_number failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.data || []);
  const map = new Map();
  for (const entry of list) {
    const id = parseInt(entry.id, 10);
    if (!Number.isFinite(id)) continue;
    if (entry.did) map.set(String(entry.did).replace(/\D/g, ''), id);       // digits of +91...
    if (entry.alias) map.set(String(entry.alias).replace(/\D/g, ''), id);   // 918065...
  }
  return map;
}

// Resolve the client's assigned DIDs to Smartflo numeric caller_ids.
// Prefer explicit smartflo_did_id on the DID record; otherwise look up via /v1/my_number.
async function fetchCallerIdsForClient(client, base44, authToken) {
  const clientDIDs = await base44.asServiceRole.entities.DID.filter({ client_id: client.id });
  if (clientDIDs.length === 0) return { ids: [], unresolved: [] };

  // Check if any DID is missing smartflo_did_id → we'll need the directory
  const needsLookup = clientDIDs.some((d) => !d.smartflo_did_id);
  let directory = null;
  if (needsLookup) {
    try {
      directory = await fetchSmartfloDidDirectory(authToken);
    } catch (e) {
      console.warn(`[smartfloAgentProvisioner] DID directory fetch failed: ${e.message}`);
    }
  }

  const ids = [];
  const unresolved = [];
  for (const d of clientDIDs) {
    // Prefer explicit smartflo_did_id
    if (d.smartflo_did_id) {
      const n = parseInt(d.smartflo_did_id, 10);
      if (Number.isFinite(n)) { ids.push(n); continue; }
    }
    // Look up by phone number
    if (directory && d.number) {
      const digits = String(d.number).replace(/\D/g, '');
      const id = directory.get(digits);
      if (id) {
        ids.push(id);
        // Persist for next time
        await base44.asServiceRole.entities.DID.update(d.id, { smartflo_did_id: String(id) }).catch(() => {});
        continue;
      }
    }
    unresolved.push(d.number);
  }
  return { ids, unresolved };
}
// ═══════════════════════════════════════════════════════════════════════

// Module-level lockout guard — prevents repeated bad-password attempts from locking the Smartflo account.
// Cache also tracks credentials so a password change auto-invalidates the lockout.
let _cachedCredHash = '';
let _consecutiveFailures = 0;
let _lockoutUntil = 0;

function credHash(email, password) {
  return `${email}::${(password || '').length}::${(password || '').slice(-3)}`;
}

async function smartfloLogin() {
  const email = Deno.env.get('SMARTFLO_EMAIL');
  const password = Deno.env.get('SMARTFLO_PASSWORD');
  const currentHash = credHash(email, password);

  // Credentials changed → reset failure counter (fresh attempt allowed)
  if (_cachedCredHash && _cachedCredHash !== currentHash) {
    console.log('[smartfloAgentProvisioner] 🔄 Credentials changed — resetting failure counter');
    _consecutiveFailures = 0; _lockoutUntil = 0;
  }
  _cachedCredHash = currentHash;

  // Lockout guard
  if (Date.now() < _lockoutUntil) {
    const waitMin = Math.ceil((_lockoutUntil - Date.now()) / 60000);
    throw new Error(`Smartflo login paused for ${waitMin} more minute(s) due to repeated failures — preventing account lockout`);
  }

  const res = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= 3) {
      _lockoutUntil = Date.now() + 15 * 60 * 1000;
      console.error(`[smartfloAgentProvisioner] 🚨 ${_consecutiveFailures} consecutive login failures — pausing for 15 min to prevent Smartflo lockout`);
    }
    throw new Error(`Smartflo login failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  _consecutiveFailures = 0; _lockoutUntil = 0;
  return data.access_token || data.token || data.data?.token;
}

async function provisionSmartfloAgent(agent, client, authToken, callerIds) {
  const payload = buildSmartfloAgentPayload(agent, client, callerIds);
  console.log(`[smartfloAgentProvisioner] Provisioning Smartflo agent for "${agent.name}" with payload:`, JSON.stringify(payload));

  const res = await fetch(SMARTFLO_CREATE_AGENT_URL, {
    method: SMARTFLO_CREATE_AGENT_METHOD,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Smartflo create-agent failed: ${res.status} ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  console.log(`[smartfloAgentProvisioner] Smartflo response for "${agent.name}":`, JSON.stringify(data).slice(0, 800));
  const d = data.data || data;
  // Agent ID (displayed like "0507279030001" in the Smartflo UI)
  const smartfloAgentId =
    d.agent_id || d.agentId ||
    d.id || d.user_id ||
    null;
  // Intercom/Extension number (e.g. "1001")
  const intercomNumber =
    d.intercom_number || d.intercomNumber ||
    d.extension || d.extension_number ||
    d.agent_extension ||
    null;
  if (!smartfloAgentId) throw new Error('Smartflo agent created but no ID returned in response');
  return { ok: true, smartfloAgentId, intercomNumber, rawResponse: data };
}

export default async function smartfloAgentProvisioner(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));

    // Determine the target client: either from entity automation payload
    // (triggered by Client update) or manual invocation ({ client_id })
    const clientId =
      body?.event?.entity_id ||
      body?.data?.id ||
      body?.client_id;

    if (!clientId) {
      return c.json({ data: { error: 'Missing client_id' } }, 400);
    }

    const client = await base44.asServiceRole.entities.Client.get(clientId);
    if (!client) {
      return c.json({ data: { error: 'Client not found' } }, 404);
    }

    // Gate: only run when the add-on is actually enabled.
    // (DRY-RUN bypass: pass force_test=true in payload to skip this check for admin testing)
    if (!client.call_transfer_enabled && !body?.force_test) {
      console.log(`[smartfloAgentProvisioner] Client ${clientId} does NOT have call_transfer_enabled — skipping`);
      return c.json({ data: { skipped: true, reason: 'call_transfer_not_enabled' } });
    }

    // Extra guard for entity automations: only fire when the flag just flipped
    // from false → true. This prevents re-running on every unrelated Client update.
    if (body?.event?.type === 'update') {
      const prev = body?.old_data?.call_transfer_enabled;
      const now = body?.data?.call_transfer_enabled;
      if (prev === now) {
        return c.json({ data: { skipped: true, reason: 'flag_unchanged' } });
      }
      if (now !== true) {
        return c.json({ data: { skipped: true, reason: 'flag_disabled' } });
      }
    }

    // Load all voice agents for this client
    const agents = await base44.asServiceRole.entities.Agent.filter({ client_id: clientId });
    if (agents.length === 0) {
      return c.json({ data: { success: true, message: 'No agents to provision', provisioned: 0 } });
    }

    // Log into Smartflo once
    let authToken;
    try {
      authToken = await smartfloLogin();
    } catch (loginErr) {
      console.error(`[smartfloAgentProvisioner] Smartflo login failed: ${loginErr.message}`);
      return c.json({ data: { error: 'smartflo_login_failed', details: loginErr.message } }, 500);
    }

    // Resolve the client's DIDs to Smartflo numeric caller_id IDs (via /v1/my_number lookup)
    const { ids: callerIds, unresolved } = await fetchCallerIdsForClient(client, base44, authToken);
    if (callerIds.length === 0) {
      return c.json({ data: {
        error: 'no_caller_ids',
        message: `Could not resolve any DIDs to Smartflo caller_ids for client ${clientId}.`,
        unresolved_numbers: unresolved
      } }, 400);
    }
    if (unresolved.length > 0) {
      console.warn(`[smartfloAgentProvisioner] Some DIDs could not be resolved to Smartflo IDs: ${unresolved.join(', ')}`);
    }

    const results = [];
    for (const agent of agents) {
      // Skip agents that already have a real Smartflo ID
      if (agent.smartflo_agent_id && agent.smartflo_agent_id !== 'PENDING_API_CAPTURE') {
        results.push({ agent_id: agent.id, name: agent.name, skipped: true, reason: 'already_provisioned' });
        continue;
      }

      try {
        const { ok, smartfloAgentId, intercomNumber } = await provisionSmartfloAgent(agent, client, authToken, callerIds);
        const updates = { smartflo_agent_id: String(smartfloAgentId) };
        if (intercomNumber) {
          updates.smartflo_intercom_number = String(intercomNumber);
          // Auto-fill human_transfer_number if the agent doesn't already have one set
          if (!agent.human_transfer_number) {
            updates.human_transfer_number = String(intercomNumber);
          }
        }
        await base44.asServiceRole.entities.Agent.update(agent.id, updates);
        results.push({ agent_id: agent.id, name: agent.name, ok, smartflo_agent_id: smartfloAgentId, intercom_number: intercomNumber });
      } catch (agentErr) {
        console.error(`[smartfloAgentProvisioner] Failed for Agent ${agent.id}: ${agentErr.message}`);
        results.push({ agent_id: agent.id, name: agent.name, ok: false, error: agentErr.message });
      }
    }

    const successCount = results.filter((r) => r.ok).length;

    return c.json({ data: {
      success: true,
      client_id: clientId,
      total_agents: agents.length,
      provisioned: successCount,
      results
    } });
  } catch (error) {
    console.error('[smartfloAgentProvisioner] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};