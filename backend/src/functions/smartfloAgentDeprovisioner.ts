import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Auto-deletes Smartflo users for every Voice Agent belonging to a client
// once the Call Transfer add-on is disabled (turned OFF).
//
// TRIGGERED BY:
//   1. Client entity automation when `call_transfer_enabled` flips from true → false.
//   2. Manual admin invocation: { client_id } in the payload.
//
// WHAT IT DOES (for each Agent owned by the client that has smartflo_agent_id set):
//   - Calls Smartflo's DELETE /v1/user/{id} endpoint to remove the user
//   - Clears smartflo_agent_id, smartflo_intercom_number on the Agent record
//   - If human_transfer_number matched the deleted intercom, clears it too



// Module-level lockout guard — prevents repeated bad-password attempts from locking the Smartflo account.
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

  if (_cachedCredHash && _cachedCredHash !== currentHash) {
    console.log('[smartfloAgentDeprovisioner] 🔄 Credentials changed — resetting failure counter');
    _consecutiveFailures = 0; _lockoutUntil = 0;
  }
  _cachedCredHash = currentHash;

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
      console.error(`[smartfloAgentDeprovisioner] 🚨 ${_consecutiveFailures} consecutive login failures — pausing for 15 min to prevent Smartflo lockout`);
    }
    throw new Error(`Smartflo login failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  _consecutiveFailures = 0; _lockoutUntil = 0;
  return data.access_token || data.token || data.data?.token;
}

async function deleteSmartfloUser(smartfloAgentId, authToken) {
  const url = `https://api-smartflo.tatateleservices.com/v1/user/${smartfloAgentId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${authToken}`
    }
  });
  if (!res.ok) {
    const err = await res.text();
    // If user already doesn't exist (404), treat as success
    if (res.status === 404) {
      console.log(`[smartfloAgentDeprovisioner] Smartflo user ${smartfloAgentId} already gone (404) — treating as deleted`);
      return { ok: true, alreadyGone: true };
    }
    throw new Error(`Smartflo delete-user failed: ${res.status} ${err.slice(0, 300)}`);
  }
  return { ok: true };
}

export default async function smartfloAgentDeprovisioner(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));

    // Determine the target client
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

    // Gate: only run when the add-on is actually DISABLED.
    // (DRY-RUN bypass: pass force_test=true in payload to skip this check for admin testing)
    if (client.call_transfer_enabled && !body?.force_test) {
      console.log(`[smartfloAgentDeprovisioner] Client ${clientId} still has call_transfer_enabled=true — skipping`);
      return c.json({ data: { skipped: true, reason: 'call_transfer_still_enabled' } });
    }

    // Extra guard for entity automations: only fire when the flag just flipped
    // from true → false.
    if (body?.event?.type === 'update') {
      const prev = body?.old_data?.call_transfer_enabled;
      const now = body?.data?.call_transfer_enabled;
      if (prev === now) {
        return c.json({ data: { skipped: true, reason: 'flag_unchanged' } });
      }
      if (now !== false) {
        return c.json({ data: { skipped: true, reason: 'flag_not_disabled' } });
      }
    }

    // Load all voice agents for this client that have a Smartflo ID
    const agents = await base44.asServiceRole.entities.Agent.filter({ client_id: clientId });
    const agentsToDelete = agents.filter(
      (a) => a.smartflo_agent_id && a.smartflo_agent_id !== 'PENDING_API_CAPTURE'
    );

    if (agentsToDelete.length === 0) {
      return c.json({ data: { success: true, message: 'No Smartflo users to delete', deleted: 0 } });
    }

    // Log into Smartflo once
    let authToken;
    try {
      authToken = await smartfloLogin();
    } catch (loginErr) {
      console.error(`[smartfloAgentDeprovisioner] Smartflo login failed: ${loginErr.message}`);
      return c.json({ data: { error: 'smartflo_login_failed', details: loginErr.message } }, 500);
    }

    const results = [];
    for (const agent of agentsToDelete) {
      try {
        const { ok, alreadyGone } = await deleteSmartfloUser(agent.smartflo_agent_id, authToken);

        // Clear Smartflo fields on the Agent record
        const updates = {
          smartflo_agent_id: '',
          smartflo_intercom_number: ''
        };
        // If the agent's human_transfer_number matched the deleted intercom, clear it too
        if (agent.smartflo_intercom_number && agent.human_transfer_number === agent.smartflo_intercom_number) {
          updates.human_transfer_number = '';
        }
        await base44.asServiceRole.entities.Agent.update(agent.id, updates);

        results.push({
          agent_id: agent.id,
          name: agent.name,
          ok,
          smartflo_agent_id: agent.smartflo_agent_id,
          already_gone: !!alreadyGone
        });
      } catch (agentErr) {
        console.error(`[smartfloAgentDeprovisioner] Failed for Agent ${agent.id}: ${agentErr.message}`);
        results.push({ agent_id: agent.id, name: agent.name, ok: false, error: agentErr.message });
      }
    }

    const successCount = results.filter((r) => r.ok).length;

    return c.json({ data: {
      success: true,
      client_id: clientId,
      total_agents: agentsToDelete.length,
      deleted: successCount,
      results
    } });
  } catch (error) {
    console.error('[smartfloAgentDeprovisioner] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};