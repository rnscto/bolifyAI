import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// twilioInboundWebhook — Handles incoming voice calls to Twilio DIDs.
// Configure this URL in Twilio Console:
//   Phone Numbers → Manage → Active Numbers → [number] → Voice Configuration
//   "A call comes in" → Webhook → https://<app>/functions/twilioInboundWebhook
//   HTTP POST
//
// Flow:
//   1. Twilio POSTs form-encoded body: From, To, CallSid, ...
//   2. We look up the DID by `To` to find the assigned agent
//   3. Auto-create a Lead from the inbound caller (if missing)
//   4. Create a CallLog (provider='twilio', direction='inbound')
//   5. Return TwiML <Connect><Stream> to streamTwilioOutgoing (same brain)
//
// We pass call_log_id as a <Parameter> so the stream function hydrates
// the agent config without doing a phone-number DB lookup.
// ═══════════════════════════════════════════════════════════════════════



// ─── Twilio signature validation (HMAC-SHA1) ───
async function validateTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) data += k + params[k];
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const bin = Array.from(new Uint8Array(sig)).map(b => String.fromCharCode(b)).join('');
  return btoa(bin) === signature;
}

function twiml(body) {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' }
  });
}

function rejectTwiml(reason = 'No agent available') {
  return twiml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${reason}</Say>
  <Hangup/>
</Response>`);
}

export default async function twilioInboundWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    if (req.method !== 'POST') {
      return twiml(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }

    // Twilio sends application/x-www-form-urlencoded
    const formText = await req.text();
    const params = new URLSearchParams(formText);
    const paramsObj = {};
    params.forEach((v, k) => { paramsObj[k] = v; });
    const from = params.get('From') || '';
    const to = params.get('To') || '';
    const twilioCallSid = params.get('CallSid') || '';

    console.log(`[twilioInboundWebhook] Inbound: from=${from}, to=${to}, sid=${twilioCallSid}`);

    // ─── Signature validation ───
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const signature = req.headers.get('x-twilio-signature');
    const insecure = Deno.env.get('TWILIO_WEBHOOK_INSECURE') === '1';
    if (!insecure) {
      if (!twilioToken || !signature) {
        console.warn('[twilioInboundWebhook] Missing token or signature — rejecting');
        return rejectTwiml('Unauthorized');
      }
      // Base44's proxy rewrites req.url, so also try the public URL
      // reconstructed from forwarded headers (what Twilio actually POSTed to).
      const reqUrl = new URL(req.url);
      const fwdHost = req.headers.get('x-forwarded-host') || req.headers.get('host');
      const fwdProto = req.headers.get('x-forwarded-proto') || 'https';
      const publicUrl = fwdHost ? `${fwdProto}://${fwdHost}${reqUrl.pathname}${reqUrl.search}` : null;
      const publicUrlNoQuery = fwdHost ? `${fwdProto}://${fwdHost}${reqUrl.pathname}` : null;

      const candidates = [publicUrl, publicUrlNoQuery, reqUrl.toString()].filter(Boolean);
      let valid = false;
      for (const c of candidates) {
        if (await validateTwilioSignature(twilioToken, c, paramsObj, signature)) { valid = true; break; }
      }
      if (!valid) {
        console.warn(`[twilioInboundWebhook] ❌ Invalid signature for CallSid=${twilioCallSid}. Tried: ${JSON.stringify(candidates)}`);
        return rejectTwiml('Unauthorized');
      }
    }

    if (!to) return rejectTwiml('Invalid request');

    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // 1. Find the DID record
    const dids = await svc.entities.DID.filter({ number: to, provider: 'twilio' }).catch(() => []);
    const did = dids[0];
    if (!did || !did.agent_id) {
      console.log(`[twilioInboundWebhook] No agent assigned for ${to}`);
      return rejectTwiml('This number is not currently configured. Please try again later.');
    }

    // 2. Check concurrency cap on this DID (counts BOTH inbound + outbound — same DID can't do both)
    const cap = did.max_inbound_concurrent_calls || 1;
    const recent = await svc.entities.CallLog.filter({ caller_id: to }, '-created_date', 40).catch(() => []);
    const activeOnDID = recent.filter(c => ['initiated', 'ringing', 'answered'].includes(c.status)).length;
    if (activeOnDID >= cap) {
      console.log(`[twilioInboundWebhook] DID busy (${activeOnDID}/${cap} active in/out) for ${to}`);
      return rejectTwiml('All agents are currently busy. Please call back shortly.');
    }

    // 3. Find/create lead by caller's phone
    let lead = null;
    if (from) {
      const leadMatches = await svc.entities.Lead.filter({
        client_id: did.client_id, phone: from
      }).catch(() => []);
      lead = leadMatches[0] || null;
      if (!lead) {
        try {
          lead = await svc.entities.Lead.create({
            client_id: did.client_id,
            phone: from,
            name: from,
            source: 'inbound_call',
            status: 'new'
          });
          console.log(`[twilioInboundWebhook] Auto-created lead ${lead.id} for ${from}`);
        } catch (e) {
          console.error(`[twilioInboundWebhook] Lead create failed: ${e.message}`);
        }
      }
    }

    // 4. Build slim agent_config_cache via existing function
    let slimCache = null;
    try {
      const ctxRes = await svc.functions.invoke('buildAgentContext', {
        agent_id: did.agent_id,
        lead_id: lead?.id || null,
        extra_instructions: '\n\n[INBOUND CALL] The customer called YOU. Greet them warmly and ask how you can help.'
      });
      slimCache = ctxRes?.data?.cache || ctxRes?.data || null;
    } catch (e) {
      console.error(`[twilioInboundWebhook] buildAgentContext failed: ${e.message}`);
    }

    if (!slimCache) {
      const agent = await svc.entities.Agent.get(did.agent_id).catch(() => null);
      slimCache = {
        agent_name: agent?.name || 'AI Assistant',
        agent_id: did.agent_id,
        client_id: did.client_id,
        lead_id: lead?.id || null,
        core_prompt: (agent?.system_prompt || 'You are a helpful AI voice assistant. The customer just called you.').substring(0, 1500),
        greeting_message: agent?.greeting_message || '',
        persona: agent?.persona || {},
        tool_flags: { has_kb: !!agent?.knowledge_base_ids?.length, has_call_history: !!lead?.id, has_transfer: !!agent?.human_transfer_number, has_end_call: true },
        kb_file_uri: agent?.kb_file_uri || '',
        human_transfer_number: agent?.human_transfer_number || '',
        enable_auto_transfer: agent?.enable_auto_transfer !== false,
        is_screening_call: false
      };
    }

    // 5. Create CallLog
    const internalCallSid = `tw_in_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const callLog = await svc.entities.CallLog.create({
      client_id: did.client_id,
      agent_id: did.agent_id,
      lead_id: lead?.id || null,
      call_sid: twilioCallSid || internalCallSid,
      caller_id: to,                // our DID
      callee_number: from,          // the customer
      direction: 'inbound',
      status: 'answered',
      call_start_time: new Date().toISOString(),
      provider: 'twilio',
      country_code: did.country_code,
      agent_config_cache: {
        ...slimCache,
        system_prompt: slimCache.core_prompt,
        knowledge_base_content: '',
        lead_context: slimCache.lead_snapshot || ''
      }
    });

    // 6. Return TwiML to bridge into our Realtime brain
    const streamWss = Deno.env.get('TWILIO_STREAM_WSS_URL');
    if (!streamWss) {
      console.error('[twilioInboundWebhook] TWILIO_STREAM_WSS_URL not set');
      return rejectTwiml('Service misconfiguration. Please try again later.');
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamWss}">
      <Parameter name="call_log_id" value="${callLog.id}" />
      <Parameter name="call_sid" value="${twilioCallSid}" />
      <Parameter name="from" value="${from}" />
      <Parameter name="to" value="${to}" />
      <Parameter name="direction" value="inbound" />
    </Stream>
  </Connect>
</Response>`;
    return twiml(xml);

  } catch (error) {
    console.error('[twilioInboundWebhook] Error:', error);
    return rejectTwiml('An error occurred. Please try again.');
  }

};