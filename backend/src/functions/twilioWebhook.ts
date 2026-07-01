import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// twilioWebhook — Receives Twilio StatusCallback events.
// Parallel to functions/smartfloWebhook.
//
// Twilio POSTs application/x-www-form-urlencoded with:
//   CallSid, CallStatus (initiated|ringing|in-progress|completed|busy|no-answer|failed|canceled),
//   CallDuration, From, To, Direction, RecordingUrl (when Record=true on completion)
//
// We map Twilio statuses → our CallLog enum and fire the same downstream
// pipeline that smartfloWebhook uses (fetchTwilioRecording, postCallActionExtractor).
// ═══════════════════════════════════════════════════════════════════════



// Twilio CallStatus → CallLog.status mapping
const STATUS_MAP = {
  'initiated': 'initiated',
  'queued': 'initiated',
  'ringing': 'ringing',
  'in-progress': 'answered',
  'completed': 'completed',
  'busy': 'no_answer',
  'no-answer': 'no_answer',
  'failed': 'failed',
  'canceled': 'failed'
};

// ─── Twilio signature validation (HMAC-SHA1) ───
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
async function validateTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  // Twilio's algorithm: full URL + sorted form params concatenated as key+value
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) data += k + params[k];
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  // Base64-encode the signature
  const bin = Array.from(new Uint8Array(sig)).map(b => String.fromCharCode(b)).join('');
  const computed = btoa(bin);
  return computed === signature;
}

export default async function twilioWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    if (req.method !== 'POST') {
      return c.json({ data: { error: 'POST only' } }, 405);
    }

    const contentType = req.headers.get('content-type') || '';
    let params = {};
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await req.text();
      const usp = new URLSearchParams(text);
      usp.forEach((v, k) => { params[k] = v; });
    } else {
      params = await c.req.json().catch(() => ({}));
    }

    const callSid = params.CallSid;
    const callStatus = params.CallStatus;
    if (!callSid) return c.json({ data: { error: 'CallSid required' } }, 400);

    // ─── Signature validation (HMAC-SHA1) ───
    // Reject unsigned/invalid requests to prevent webhook spoofing.
    // Set TWILIO_WEBHOOK_INSECURE=1 only for local debugging.
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const signature = req.headers.get('x-twilio-signature');
    const insecure = Deno.env.get('TWILIO_WEBHOOK_INSECURE') === '1';
    if (!insecure) {
      if (!twilioToken) {
        console.error('[twilioWebhook] TWILIO_AUTH_TOKEN not configured');
        return c.json({ data: { error: 'Server misconfigured' } }, 500);
      }
      if (!signature) {
        console.warn(`[twilioWebhook] Missing x-twilio-signature for CallSid=${callSid}`);
        return c.json({ data: { error: 'Signature required' } }, 403);
      }
      // Twilio signs against the EXACT URL it POSTed to (the StatusCallback URL
      // we gave it). Base44's proxy rewrites req.url internally, so we must
      // also try the public URL reconstructed from forwarded headers, plus
      // the configured TWILIO_STATUS_CALLBACK_URL fallback.
      const reqUrl = new URL(req.url);
      const fwdHost = req.headers.get('x-forwarded-host') || req.headers.get('host');
      const fwdProto = req.headers.get('x-forwarded-proto') || 'https';
      const publicUrl = fwdHost ? `${fwdProto}://${fwdHost}${reqUrl.pathname}${reqUrl.search}` : null;
      // Also try without query string (Twilio sometimes signs path-only variant)
      const publicUrlNoQuery = fwdHost ? `${fwdProto}://${fwdHost}${reqUrl.pathname}` : null;

      const candidates = [
        publicUrl,
        publicUrlNoQuery,
        Deno.env.get('TWILIO_STATUS_CALLBACK_URL'),
        reqUrl.toString(),
      ].filter(Boolean);

      let valid = false;
      let triedUrls = [];
      for (const candidate of candidates) {
        triedUrls.push(candidate);
        if (await validateTwilioSignature(twilioToken, candidate, params, signature)) {
          valid = true;
          break;
        }
      }

      if (!valid) {
        console.warn(`[twilioWebhook] ❌ Invalid signature for CallSid=${callSid}. Tried URLs: ${JSON.stringify(triedUrls)}, sig=${signature}`);
        return c.json({ data: { error: 'Invalid signature', tried_urls: triedUrls } }, 403);
      }
    }

    /* const base44 = ... */;

    // Find the CallLog by Twilio CallSid
    const logs = await base44.entities.CallLog.filter({ call_sid: callSid }).catch(() => []);
    if (!logs.length) {
      console.log(`[twilioWebhook] No CallLog for CallSid=${callSid} (event=${callStatus}) — ignoring`);
      return c.json({ data: { success: true, ignored: 'no_call_log' } });
    }
    const callLog = logs[0];

    const mappedStatus = STATUS_MAP[callStatus] || callLog.status;
    const update = { status: mappedStatus };

    if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'canceled' ||
        callStatus === 'busy' || callStatus === 'no-answer') {
      update.call_end_time = new Date().toISOString();
      if (params.CallDuration) update.duration = parseInt(params.CallDuration, 10);
      // Twilio sends Price (negative string e.g. "-0.0140") and PriceUnit on completion
      if (params.Price) {
        const priceNum = Math.abs(parseFloat(params.Price));
        if (!isNaN(priceNum)) update.provider_cost = priceNum;
      }
      if (params.PriceUnit) update.provider_currency = params.PriceUnit;
    }
    if (params.RecordingUrl) update.recording_url = params.RecordingUrl + '.mp3';

    await base44.entities.CallLog.update(callLog.id, update);
    console.log(`[twilioWebhook] CallSid=${callSid} status=${callStatus} → ${mappedStatus}`);

    // ─── International minute-usage accounting ───
    // Increment client.minutes_used_this_period for completed answered calls.
    // Fire-and-forget — overage billing reconciles monthly via stripe-webhook.
    if (mappedStatus === 'completed' && update.duration && callLog.client_id) {
      const minutes = Math.ceil(update.duration / 60);
      try {
        const client = await base44.entities.Client.get(callLog.client_id);
        if (client && (client.region === 'US' || client.region === 'UK')) {
          const used = Number(client.minutes_used_this_period || 0) + minutes;
          base44.entities.Client.update(client.id, { minutes_used_this_period: used })
            .catch((e) => console.error('[twilioWebhook] minute counter failed:', e.message));
        }
      } catch (e) {
        console.error('[twilioWebhook] minute accounting skipped:', e.message);
      }
    }

    // Trigger post-call pipeline on terminal states (fire-and-forget)
    if (['completed', 'no_answer', 'failed'].includes(mappedStatus)) {
      // Fetch & store recording (waits 20s like Smartflo path)
      setTimeout(() => {
        base44.functions.invoke('fetchTwilioRecording', { call_log_id: callLog.id })
          .catch(e => console.error(`[twilioWebhook] fetchTwilioRecording failed: ${e.message}`));
      }, 20000);

      // Re-read fresh CallLog so campaignPostCall sees the final status/duration
      const freshCallLog = await base44.entities.CallLog.get(callLog.id).catch(() => callLog);

      // ─── Campaign post-call: progress lead + trigger next call in the campaign ───
      // Mirrors what smartfloWebhook does for Smartflo terminal events. Fire-and-forget.
      try {
        base44.functions.invoke('campaignPostCall', {
          event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
          data: freshCallLog,
          old_data: { ...freshCallLog, status: callLog.status }
        }).catch(e => console.error(`[twilioWebhook] campaignPostCall failed: ${e.message}`));
      } catch (_) {}

      // ─── Non-campaign post-call follow-ups (email/RCS outreach, action extractor) ───
      try {
        base44.functions.invoke('postCallFollowup', {
          event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
          data: freshCallLog,
          old_data: { ...freshCallLog, status: callLog.status }
        }).catch(e => console.error(`[twilioWebhook] postCallFollowup failed: ${e.message}`));
      } catch (_) {}

      if (freshCallLog.transcript && freshCallLog.transcript.length > 50) {
        try {
          base44.functions.invoke('postCallActionExtractor', {
            event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
            data: freshCallLog,
            old_data: { ...freshCallLog, transcript: null }
          }).catch(e => console.error(`[twilioWebhook] postCallActionExtractor failed: ${e.message}`));
        } catch (_) {}
      }
    }

    return c.json({ data: { success: true, status: mappedStatus } });
  } catch (error) {
    console.error('[twilioWebhook] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};