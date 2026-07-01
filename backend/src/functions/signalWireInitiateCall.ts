import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// signalWireInitiateCall — Outbound call via SignalWire LaML REST API.
// Parallel to functions/twilioInitiateCall. Used for US calls when
// SignalWire is the active provider.
//
// Credentials come from the SignalWireConfig entity (single row, admin-set).
// LaML protocol is wire-compatible with TwiML — same <Connect><Stream> shape.
// ═══════════════════════════════════════════════════════════════════════



function detectCountry(phone) {
  const clean = String(phone || '').replace(/[^0-9+]/g, '');
  if (clean.startsWith('+1') || /^1\d{10}$/.test(clean)) return 'US';
  if (clean.startsWith('+44') || /^44\d{9,10}$/.test(clean)) return 'GB';
  if (clean.startsWith('+91') || /^91\d{10}$/.test(clean)) return 'IN';
  return 'UNKNOWN';
}

function toE164(phone, defaultCountry = 'US') {
  let clean = String(phone || '').replace(/[^0-9+]/g, '');
  if (clean.startsWith('+')) return clean;
  if (defaultCountry === 'US' && clean.length === 10) return '+1' + clean;
  if (defaultCountry === 'GB' && (clean.length === 10 || clean.length === 11)) return '+44' + clean.replace(/^0/, '');
  if (defaultCountry === 'IN' && clean.length === 10) return '+91' + clean;
  return '+' + clean;
}

export default async function signalWireInitiateCall(c: any) {
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

    if (!service_call && user?.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      const userClientIds = clients.map(c => c.id);
      if (!userClientIds.includes(agent.client_id) || !userClientIds.includes(lead.client_id)) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    // ─── Load platform SignalWire config ───
    const configs = await base44.asServiceRole.entities.SignalWireConfig.list('-created_date', 1);
    const cfg = configs?.[0];
    if (!cfg || !cfg.is_active) {
      return c.json({ data: {
        success: false,
        error: 'SignalWire is not configured or not active. Set it up in Admin → Twilio Coverage → SignalWire Setup.'
      } }, 400);
    }
    if (!cfg.project_id || !cfg.api_token || !cfg.space_url) {
      return c.json({ data: {
        success: false,
        error: 'SignalWire config incomplete (project_id, api_token, space_url required)'
      } }, 400);
    }

    const destCountry = detectCountry(phone_number);
    const calleeE164 = toE164(phone_number, destCountry === 'UNKNOWN' ? 'US' : destCountry);

    // ─── Pick caller DID ───
    // Prefer agent-specific SignalWire DIDs (dedicated field), then legacy
    // twilio_dids (for older agents), then platform default.
    let callerDID = null;
    const swDids = Array.isArray(agent.signalwire_dids) ? agent.signalwire_dids : [];
    const legacyDids = Array.isArray(agent.twilio_dids) ? agent.twilio_dids : [];
    const agentDids = swDids.length > 0 ? swDids : legacyDids;
    if (destCountry === 'US') {
      callerDID = agentDids.find(d => d.startsWith('+1')) || cfg.default_did || (cfg.available_dids || []).find(d => d.startsWith('+1'));
    } else {
      callerDID = agentDids[0] || cfg.default_did || (cfg.available_dids || [])[0];
    }
    if (!callerDID) {
      return c.json({ data: {
        success: false,
        error: 'No SignalWire DID available. Add a default DID in SignalWire Setup.'
      } }, 400);
    }

    // Sanitize caller DID to strict E.164 (strip spaces, hyphens, parens, etc.)
    callerDID = '+' + String(callerDID).replace(/[^0-9]/g, '');

    // ─── Build slim agent_config_cache (reuse buildAgentContext) ───
    let slimCache = null;
    try {
      const ctxRes = await base44.asServiceRole.functions.invoke('buildAgentContext', {
        agent_id, lead_id, extra_instructions: context_override || ''
      });
      slimCache = ctxRes?.data?.cache || ctxRes?.data || null;
    } catch (e) {
      console.error('[signalWireInitiateCall] buildAgentContext failed:', e.message);
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

    // ─── Create CallLog (provider='signalwire') ───
    const internalCallSid = `sw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
      provider: 'signalwire',
      country_code: destCountry,
      conversation_summary: slimCache.lead_snapshot ? `[LEAD SNAPSHOT] ${slimCache.lead_snapshot}` : '',
      agent_config_cache: {
        ...slimCache,
        system_prompt: slimCache.core_prompt,
        knowledge_base_content: '',
        lead_context: slimCache.lead_snapshot || ''
      }
    });

    // ─── Derive WSS + Status URLs ───
    // IMPORTANT: the runtime request host is an ephemeral deploy host that does
    // NOT reliably serve our functions to external providers — SignalWire then
    // reports "Stream Error – Connection Refused" and every status callback
    // fails. We anchor the URLs to the SAME stable public hosts that the proven
    // Twilio path uses (its TWILIO_* secrets point at the app's stable deploy
    // host + custom domain), just swapping the function name. Priority:
    //   1. Explicit value configured in SignalWireConfig (admin override)
    //   2. Stable host derived from the working Twilio secrets
    const swapFn = (url, fromFn, toFn) => {
      try { return url.replace(fromFn, toFn); } catch (_) { return ''; }
    };
    const twilioWss = (Deno.env.get('TWILIO_STREAM_WSS_URL') || '').trim();
    const twilioCb = (Deno.env.get('TWILIO_STATUS_CALLBACK_URL') || '').trim();

    const streamWss = (cfg.stream_wss_url && cfg.stream_wss_url.trim())
      || swapFn(twilioWss, 'streamTwilioOutgoing', 'streamSignalWireOutgoing');
    const statusCb = (cfg.status_callback_url && cfg.status_callback_url.trim())
      || swapFn(twilioCb, 'twilioWebhook', 'signalWireWebhook');

    console.log(`[signalWireInitiateCall] 🔗 streamWss=${streamWss} statusCb=${statusCb}`);

    if (!streamWss) {
      await base44.asServiceRole.entities.CallLog.update(callLog.id, { status: 'failed' });
      return c.json({ data: { success: false, error: 'Stream WSS URL unavailable' } }, 500);
    }

    // LaML — identical to TwiML
    const laml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamWss}">
      <Parameter name="call_log_id" value="${callLog.id}" />
      <Parameter name="call_sid" value="${internalCallSid}" />
    </Stream>
  </Connect>
</Response>`;

    // ─── Place the SignalWire call ───
    const spaceUrl = String(cfg.space_url).trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    const projectId = String(cfg.project_id).trim();
    const apiToken = String(cfg.api_token).trim();
    const swUrl = `https://${spaceUrl}/api/laml/2010-04-01/Accounts/${projectId}/Calls.json`;
    const auth = btoa(`${projectId}:${apiToken}`);

    const form = new URLSearchParams();
    form.set('To', calleeE164);
    form.set('From', callerDID);
    form.set('Twiml', laml);
    if (statusCb) {
      form.set('StatusCallback', statusCb);
      form.append('StatusCallbackEvent', 'initiated');
      form.append('StatusCallbackEvent', 'ringing');
      form.append('StatusCallbackEvent', 'answered');
      form.append('StatusCallbackEvent', 'completed');
      form.set('StatusCallbackMethod', 'POST');
    }
    form.set('Record', 'true');
    form.set('RecordingChannels', 'dual');
    // SignalWire delivers the recording URL on a SEPARATE callback once the
    // recording is ready (it rarely arrives on the 'completed' status event).
    // Point it at the same webhook so recording_url gets saved on the CallLog.
    if (statusCb) {
      form.set('RecordingStatusCallback', statusCb);
      form.set('RecordingStatusCallbackMethod', 'POST');
      form.append('RecordingStatusCallbackEvent', 'completed');
    }

    const swResp = await fetch(swUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    const swData = await swResp.json().catch(() => ({}));
    if (!swResp.ok) {
      console.error('[signalWireInitiateCall] ❌ SignalWire rejected:', JSON.stringify({
        http_status: swResp.status,
        code: swData.code,
        message: swData.message,
        from: callerDID,
        to: calleeE164,
        full: swData
      }, null, 2));
      await base44.asServiceRole.entities.CallLog.update(callLog.id, { status: 'failed' });
      return c.json({ data: {
        success: false,
        error: `SignalWire API error (code ${swData.code}): ${swData.message || JSON.stringify(swData)}`,
      } }, 400);
    }

    // Update CallLog with the real SignalWire SID
    await base44.asServiceRole.entities.CallLog.update(callLog.id, {
      call_sid: swData.sid,
      status: 'ringing'
    });

    base44.asServiceRole.entities.Lead.update(lead_id, {
      status: 'contacted',
      last_call_date: new Date().toISOString()
    }).catch(e => console.error('[signalWireInitiateCall] Lead update failed:', e.message));

    console.log(`[signalWireInitiateCall] ✅ Call placed: ${swData.sid}, to=${calleeE164}, from=${callerDID}`);
    return c.json({ data: {
      success: true,
      call_id: callLog.id,
      call_log_id: callLog.id,
      call_sid: swData.sid,
      provider: 'signalwire',
      country: destCountry,
      message: 'SignalWire call initiated successfully'
    } });
  } catch (error) {
    console.error('[signalWireInitiateCall] Error:', error);
    return c.json({ data: { success: false, error: error.message } }, 500);
  }

};