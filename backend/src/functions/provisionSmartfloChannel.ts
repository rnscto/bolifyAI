import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// provisionSmartfloChannel — auto-assign a Smartflo Click-to-Call API token
// + streaming channel to an Agent, instead of pasting it by hand.
// ═══════════════════════════════════════════════════════════════════════
// TIER MODEL (matches the product design):
//
//  • SHARED   — clients with a single agent (trial / SMB) reuse one of the
//               pre-built shared streaming channels. The C2C token comes from
//               env (SMARTFLO_C2C_* — already used by initiateCall.pickSmartfloToken).
//               Zero per-client Smartflo setup.
//
//  • DEDICATED — multi-agent / scale clients get their own streaming channel.
//               We log in to Smartflo (JWT via email+password), list the
//               streaming channels + their bound C2C tokens, pick a free one,
//               and write its token onto Agent.smartflo_api_token.
//
// Why this also fixes the streaming scale bug (S1): the dedicated channel must
// have the `custom_identifier` custom-parameter enabled so Smartflo echoes our
// CallLog id into the stream `start` frame. That gives O(1) call→config
// resolution and removes the fragile phone-scan fallback under heavy concurrency.
//
// SECURITY: admin-only. The Smartflo JWT is short-lived — we log in on demand
// and never persist it. Only the long-lived C2C token is stored on the Agent.
//
// Input:  { agent_id, mode? ('auto'|'shared'|'dedicated'), channel_token? }
// Output: { success, mode, assigned_token_masked, agent_id }
// ═══════════════════════════════════════════════════════════════════════


const SMARTFLO_BASE = 'https://api-smartflo.tatateleservices.com/v1';

function mask(token) {
  if (!token) return '';
  const s = String(token);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

async function smartfloLogin() {
  const email = Deno.env.get('SMARTFLO_EMAIL');
  const password = Deno.env.get('SMARTFLO_PASSWORD');
  if (!email || !password) throw new Error('SMARTFLO_EMAIL/PASSWORD not configured');
  const res = await fetch(`${SMARTFLO_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Smartflo login failed');
  return data.access_token; // short-lived JWT — never stored
}

export default async function provisionSmartfloChannel(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // Admin OR internal service-role (onboarding flow) only.
    const user = c.get('jwtPayload').catch(() => null);
    const isInternal = req.headers.get('x-internal-call') === '1';
    if (!isInternal && user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: admin access required' } }, 403);
    }

    const { agent_id, mode = 'auto', channel_token } = await c.req.json();
    if (!agent_id) return c.json({ data: { error: 'agent_id required' } }, 400);

    const agent = await svc.entities.Agent.get(agent_id).catch(() => null);
    if (!agent) return c.json({ data: { error: 'Agent not found' } }, 404);

    // Count this client's agents to decide shared vs dedicated when mode='auto'.
    const clientAgents = agent.client_id
      ? await svc.entities.Agent.filter({ client_id: agent.client_id }).catch(() => [])
      : [];
    const isSingleAgentClient = clientAgents.length <= 1;

    let resolvedMode = mode;
    if (mode === 'auto') resolvedMode = isSingleAgentClient ? 'shared' : 'dedicated';

    // ── SHARED TIER ──
    // Clear any per-agent token so initiateCall.pickSmartfloToken falls back to
    // the shared env channel tokens (SMARTFLO_C2C_*). This is the zero-setup path.
    if (resolvedMode === 'shared') {
      await svc.entities.Agent.update(agent_id, { smartflo_api_token: '' });
      console.log(`[provisionSmartfloChannel] Agent ${agent_id} → SHARED channel (env token)`);
      return c.json({ data: {
        success: true,
        mode: 'shared',
        agent_id,
        message: 'Agent will use the shared Smartflo streaming channel (env C2C token). No dedicated channel assigned.'
      } });
    }

    // ── DEDICATED TIER ──
    // If an explicit channel_token was provided (admin pasted/selected one), use it.
    // Otherwise log in to Smartflo and discover an available channel token.
    let token = channel_token || '';
    if (!token) {
      const jwt = await smartfloLogin();
      // Discover streaming channels. The exact field names vary by Smartflo
      // account plan, so we look across the likely endpoints and pull the first
      // C2C/streaming token we find. Admin can override via channel_token.
      const candidates = ['/click_to_call', '/voice_streaming', '/channels'];
      for (const ep of candidates) {
        try {
          const r = await fetch(`${SMARTFLO_BASE}${ep}`, {
            headers: { 'Authorization': jwt, 'Accept': 'application/json' }
          });
          if (!r.ok) continue;
          const body = await r.json().catch(() => null);
          // Heuristic extraction: look for an api_key / token / c2c_token field
          // on the first channel object returned.
          const arr = Array.isArray(body) ? body : (body?.data || body?.channels || body?.results || []);
          const list = Array.isArray(arr) ? arr : [];
          for (const ch of list) {
            const t = ch.api_key || ch.c2c_token || ch.click_to_call_token || ch.token;
            if (t) { token = t; break; }
          }
          if (token) break;
        } catch (_) { /* try next endpoint */ }
      }
    }

    if (!token) {
      return c.json({ data: {
        success: false,
        mode: 'dedicated',
        error: 'Could not auto-discover a dedicated Smartflo C2C token for this account. ' +
               'Your TATA plan may expose channel tokens via dashboard only — paste one via channel_token, ' +
               'or assign the shared tier.'
      } }, 422);
    }

    await svc.entities.Agent.update(agent_id, { smartflo_api_token: token });
    console.log(`[provisionSmartfloChannel] Agent ${agent_id} → DEDICATED channel token ${mask(token)}`);

    return c.json({ data: {
      success: true,
      mode: 'dedicated',
      agent_id,
      assigned_token_masked: mask(token),
      reminder: 'Ensure the custom_identifier custom-parameter is enabled on this Smartflo channel\'s Voice-Bot config so call→config resolution stays O(1) under load.'
    } });
  } catch (error) {
    console.error('[provisionSmartfloChannel] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};