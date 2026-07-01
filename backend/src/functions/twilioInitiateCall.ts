import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// twilioInitiateCall — Outbound call via Twilio Programmable Voice.
// Parallel to functions/initiateCall (Smartflo). Used for US/UK calls.
//
// Flow:
//   1. Validate auth + ownership (same pattern as initiateCall)
//   2. Build slim agent_config_cache (reuses the inline logic from initiateCall
//      via buildAgentContext if available, else minimal cache)
//   3. Create CallLog (provider='twilio')
//   4. Place Twilio call with TwiML that opens a Media Streams WSS to
//      streamTwilioOutgoing — the Azure GPT-Realtime brain.
//
// Secrets required:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_STREAM_WSS_URL — public wss URL of streamTwilioOutgoing
//                          (e.g. wss://app.base44.com/functions/streamTwilioOutgoing)
//   TWILIO_STATUS_CALLBACK_URL — public https URL of twilioWebhook
// ═══════════════════════════════════════════════════════════════════════



// ─── Country code detection ───
function detectCountry(phone) {
  const clean = String(phone || '').replace(/[^0-9+]/g, '');
  if (clean.startsWith('+1') || /^1\d{10}$/.test(clean)) return 'US';
  if (clean.startsWith('+44') || /^44\d{9,10}$/.test(clean)) return 'GB';
  if (clean.startsWith('+91') || /^91\d{10}$/.test(clean)) return 'IN';
  return 'UNKNOWN';
}

// ─── E.164 normalization ───
function toE164(phone, defaultCountry = 'US') {
  let clean = String(phone || '').replace(/[^0-9+]/g, '');
  if (clean.startsWith('+')) return clean;
  if (defaultCountry === 'US' && clean.length === 10) return '+1' + clean;
  if (defaultCountry === 'GB' && (clean.length === 10 || clean.length === 11)) return '+44' + clean.replace(/^0/, '');
  if (defaultCountry === 'IN' && clean.length === 10) return '+91' + clean;
  return '+' + clean;
}

// ─── Region-aware call quota gate ───
// IN: legacy 10-call trial cap + trial_end_date.
// US/UK: trial gated by trial_end_date; active gated when minute usage
//        exceeds included × OVERAGE_GRACE_MULTIPLIER.
const OVERAGE_GRACE_MULTIPLIER = 1.5;
function checkCallQuota(client) {
  if (!client) return { allowed: false, error: 'Client not found', block_reason: 'no_client', http_status: 404 };
  const region = client.region || 'IN';
  const status = client.account_status;
  const now = new Date();

  if (status === 'suspended') {
    return { allowed: false, error: 'Account suspended. Contact support to restore access.', block_reason: 'account_suspended', http_status: 403 };
  }

  if (region === 'IN') {
    if (status === 'trial' || status === 'expired') {
      const trialEnd = client.trial_end_date ? new Date(client.trial_end_date) : null;
      const unlimitedUntil = client.trial_topup_unlimited_until ? new Date(client.trial_topup_unlimited_until) : null;
      const isUnlimited = unlimitedUntil && unlimitedUntil > now;
      const callsUsed = Number(client.trial_calls_used || 0);
      const callLimit = Number(client.trial_call_limit ?? 10);
      if (status === 'expired' || (trialEnd && trialEnd <= now && !isUnlimited)) {
        return { allowed: false, error: 'Your free trial has ended. Please top-up or subscribe to continue making calls.', block_reason: 'trial_expired', http_status: 402 };
      }
      if (!isUnlimited && callsUsed >= callLimit) {
        return { allowed: false, error: `You've used all ${callLimit} trial calls. Top-up for unlimited calling or subscribe to a full plan.`, block_reason: 'call_limit_reached', http_status: 402 };
      }
    }
    return { allowed: true };
  }

  // US / UK
  if (status === 'trial') {
    const trialEnd = client.trial_end_date ? new Date(client.trial_end_date) : null;
    if (trialEnd && trialEnd <= now) {
      return { allowed: false, error: 'Your free trial has ended. Please subscribe to a minute plan to continue making calls.', block_reason: 'trial_expired', http_status: 402 };
    }
    return { allowed: true };
  }
  if (status === 'expired') {
    return { allowed: false, error: 'Your subscription has expired. Please choose a plan to resume calling.', block_reason: 'subscription_expired', http_status: 402 };
  }
  if (status === 'active') {
    const included = Number(client.minutes_included || 0);
    const used = Number(client.minutes_used_this_period || 0);
    if (included > 0 && used >= included * OVERAGE_GRACE_MULTIPLIER) {
      return { allowed: false, error: `You've exceeded your monthly minutes (${used.toLocaleString()} used of ${included.toLocaleString()} included). Upgrade your plan to continue.`, block_reason: 'minutes_exceeded', http_status: 402 };
    }
  }
  return { allowed: true };
}

// ─── Pick a Twilio DID for the destination country (round-robin) ───
// Prefers agent.twilio_dids; falls back to agent.assigned_dids (legacy field)
// so US/UK agents that only have a DID in the legacy field still work.
// When the agent has MULTIPLE matching DIDs we rotate across them per-agent so
// a multi-DID Twilio agent spreads its calls instead of always using the first
// number. The cursor is keyed by agent id and persists across calls within this
// warm function instance (best-effort — survives consecutive campaign dials).
const _twilioRrCursor = {};
function rotate(dids, agentId) {
  if (dids.length <= 1) return dids[0] || null;
  const i = (_twilioRrCursor[agentId] || 0) % dids.length;
  _twilioRrCursor[agentId] = i + 1;
  return dids[i];
}
function pickTwilioDID(agent, destCountry) {
  const twilioDids = Array.isArray(agent.twilio_dids) ? agent.twilio_dids : [];
  const assignedDids = Array.isArray(agent.assigned_dids) ? agent.assigned_dids : [];
  const dids = twilioDids.length > 0 ? twilioDids : assignedDids;
  if (dids.length === 0) return null;
  // Match by country code prefix, rotating across all matching numbers.
  if (destCountry === 'US') {
    const us = dids.filter(d => d.startsWith('+1'));
    if (us.length > 0) return rotate(us, agent.id);
  }
  if (destCountry === 'GB') {
    const uk = dids.filter(d => d.startsWith('+44'));
    if (uk.length > 0) return rotate(uk, agent.id);
  }
  // Fallback: rotate across all available DIDs (used for IN destinations from
  // US/UK clients, and any other country — Twilio dials internationally).
  return rotate(dids, agent.id);
}

export default async function twilioInitiateCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json();
    const { lead_id, agent_id, phone_number, service_call, context_override } = body;

    let user = null;
    if (!service_call) {
      user = c.get('jwtPayload');
      if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    if (!lead_id || !agent_id || !phone_number) {
      return c.json({ data: { error: 'Missing required fields' } }, 400);
    }

    const [agent, lead] = await Promise.all([
      base44.asServiceRole.entities.Agent.get(agent_id),
      base44.asServiceRole.entities.Lead.get(lead_id)
    ]);
    if (!agent) return c.json({ data: { error: 'Agent not found' } }, 404);
    if (!lead) return c.json({ data: { error: 'Lead not found' } }, 404);

    // Ownership check
    if (!service_call && user?.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      const userClientIds = clients.map(c => c.id);
      if (!userClientIds.includes(agent.client_id) || !userClientIds.includes(lead.client_id)) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const destCountry = detectCountry(phone_number);
    // Note: IN destinations are allowed here — US/UK clients without Smartflo
    // credentials are routed to Twilio by initiateCall regardless of callee
    // country. Twilio supports international dialing to +91 (at intl rates).

    // ─── Region-aware quota gate (US/UK minute-based; blocks expired/over-cap) ───
    const callerClients = await base44.asServiceRole.entities.Client.filter({ id: agent.client_id });
    const callerClient = callerClients?.[0];
    {
      const gate = checkCallQuota(callerClient);
      if (!gate.allowed) {
        return c.json({ data: { success: false, error: gate.error, block_reason: gate.block_reason } }, gate.http_status);
      }
    }

    const callerDID = pickTwilioDID(agent, destCountry);
    if (!callerDID) {
      return c.json({ data: {
        success: false,
        error: `No Twilio DID assigned to agent for ${destCountry}. Add a Twilio number to agent.twilio_dids.`
      } }, 400);
    }

    const calleeE164 = toE164(phone_number, destCountry === 'UNKNOWN' ? 'US' : destCountry);

    // ─── Build slim agent_config_cache (delegate to buildAgentContext fn) ───
    let slimCache = null;
    try {
      const ctxRes = await base44.asServiceRole.functions.invoke('buildAgentContext', {
        agent_id, lead_id, extra_instructions: context_override || ''
      });
      slimCache = ctxRes?.data?.cache || ctxRes?.data || null;
    } catch (e) {
      console.error('[twilioInitiateCall] buildAgentContext failed:', e.message);
    }

    if (!slimCache) {
      slimCache = {
        agent_name: agent.name,
        agent_id: agent.id,
        client_id: agent.client_id,
        lead_id,
        core_prompt: (agent.system_prompt || 'You are a helpful AI voice assistant.').substring(0, 1500),
        greeting_message: (agent.greeting_message || '').replace(/\{name\}/g, lead?.name || ''),
        persona: agent.persona || {},
        tool_flags: {
          has_kb: !!(agent.knowledge_base_ids && agent.knowledge_base_ids.length > 0),
          has_call_history: true,
          has_transfer: !!agent.human_transfer_number,
          has_end_call: true
        },
        kb_file_uri: agent.kb_file_uri || '',
        human_transfer_number: agent.human_transfer_number || '',
        enable_auto_transfer: agent.enable_auto_transfer !== false,
        is_screening_call: false
      };
    }

    // ─── Create CallLog (provider='twilio') ───
    const internalCallSid = `tw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const callLog = await base44.asServiceRole.entities.CallLog.create({
      client_id: agent.client_id,
      agent_id,
      lead_id,
      call_sid: internalCallSid,
      caller_id: callerDID,
      callee_number: calleeE164,
      direction: 'outbound',
      status: 'initiated',
      call_start_time: new Date().toISOString(),
      provider: 'twilio',
      country_code: destCountry,
      conversation_summary: slimCache.lead_snapshot ? `[LEAD SNAPSHOT] ${slimCache.lead_snapshot}` : '',
      agent_config_cache: {
        ...slimCache,
        system_prompt: slimCache.core_prompt,
        knowledge_base_content: '',
        lead_context: slimCache.lead_snapshot || ''
      }
    });

    // ─── Place the Twilio call ───
    const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const streamWss = Deno.env.get('TWILIO_STREAM_WSS_URL');
    const statusCb = Deno.env.get('TWILIO_STATUS_CALLBACK_URL');

    console.log('[twilioInitiateCall] 🔎 Secrets check:', JSON.stringify({
      TWILIO_STREAM_WSS_URL: streamWss,
      TWILIO_STATUS_CALLBACK_URL: statusCb
    }));

    if (!twilioSid || !twilioToken || !streamWss) {
      await base44.asServiceRole.entities.CallLog.update(callLog.id, { status: 'failed' });
      return c.json({ data: {
        success: false,
        error: 'Twilio secrets not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_STREAM_WSS_URL required)'
      } }, 500);
    }

    // TwiML: open a bidirectional Media Stream to our brain.
    // We pass call_log_id and call_sid as custom parameters so the stream
    // function can hydrate the agent config without hitting the DB by phone.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamWss}">
      <Parameter name="call_log_id" value="${callLog.id}" />
      <Parameter name="call_sid" value="${internalCallSid}" />
    </Stream>
  </Connect>
</Response>`;

    // Strip any accidental whitespace/newlines that may have been pasted with secrets
    const cleanSid = String(twilioSid).trim();
    const cleanToken = String(twilioToken).trim();
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${cleanSid}/Calls.json`;
    // Latin1-safe base64 (btoa fails if secret has non-ASCII chars accidentally pasted)
    const auth = btoa(unescape(encodeURIComponent(`${cleanSid}:${cleanToken}`)));

    const form = new URLSearchParams();
    form.set('To', calleeE164);
    form.set('From', callerDID);
    form.set('Twiml', twiml);
    if (statusCb) {
      form.set('StatusCallback', statusCb);
      form.set('StatusCallbackEvent', 'initiated');
      form.set('StatusCallbackEvent', 'ringing');
      form.set('StatusCallbackEvent', 'answered');
      form.set('StatusCallbackEvent', 'completed');
      form.set('StatusCallbackMethod', 'POST');
    }
    form.set('Record', 'true');
    form.set('RecordingChannels', 'dual');

    const twResp = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    const twData = await twResp.json();
    if (!twResp.ok) {
      console.error('[twilioInitiateCall] ❌ Twilio rejected call:', JSON.stringify({
        http_status: twResp.status,
        twilio_code: twData.code,
        twilio_message: twData.message,
        twilio_more_info: twData.more_info,
        from: callerDID,
        to: calleeE164,
        full_response: twData
      }, null, 2));
      await base44.asServiceRole.entities.CallLog.update(callLog.id, { status: 'failed' });
      return c.json({ data: {
        success: false,
        error: `Twilio API error (code ${twData.code}): ${twData.message || JSON.stringify(twData)}`,
        twilio_more_info: twData.more_info
      } }, 400);
    }

    // Update CallLog with Twilio's real SID
    await base44.asServiceRole.entities.CallLog.update(callLog.id, {
      call_sid: twData.sid,
      status: 'ringing'
    });

    // Fire-and-forget lead status update
    base44.asServiceRole.entities.Lead.update(lead_id, {
      status: 'contacted',
      last_call_date: new Date().toISOString()
    }).catch(e => console.error('[twilioInitiateCall] Lead update failed:', e.message));

    console.log(`[twilioInitiateCall] ✅ Call placed: ${twData.sid}, to=${calleeE164}, from=${callerDID}`);
    return c.json({ data: {
      success: true,
      call_id: callLog.id,
      call_log_id: callLog.id,
      call_sid: twData.sid,
      provider: 'twilio',
      country: destCountry,
      message: 'Twilio call initiated successfully'
    } });

  } catch (error) {
    console.error('[twilioInitiateCall] Error:', error);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};