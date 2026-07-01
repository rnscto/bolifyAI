import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// signalWireWebhook — Receives SignalWire StatusCallback events.
// Parallel to functions/twilioWebhook. LaML uses Twilio-style
// CallSid / CallStatus / RecordingUrl payloads.
//
// Signature: SignalWire signs with HMAC-SHA1 using the Project's signing key
// (PSKxxxx...) — same algorithm as Twilio. We read it from SignalWireConfig.
// ═══════════════════════════════════════════════════════════════════════



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

async function validateSignature(signingKey, url, params, signature) {
  if (!signingKey || !signature) return false;
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) data += k + params[k];
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const bin = Array.from(new Uint8Array(sig)).map(b => String.fromCharCode(b)).join('');
  const computed = btoa(bin);
  return computed === signature;
}

export default async function signalWireWebhook(c: any) {
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

    /* const base44 = ... */;

    // ─── Signature validation against SignalWireConfig.signing_key ───
    const insecure = Deno.env.get('SIGNALWIRE_WEBHOOK_INSECURE') === '1';
    if (!insecure) {
      const configs = await base44.entities.SignalWireConfig.list('-created_date', 1);
      const signingKey = configs?.[0]?.signing_key;
      const signature = req.headers.get('x-signalwire-signature') || req.headers.get('x-twilio-signature');

      if (!signingKey) {
        console.warn('[signalWireWebhook] No signing_key configured — skipping signature check');
      } else if (!signature) {
        console.warn(`[signalWireWebhook] Missing signature header for CallSid=${callSid}`);
        return c.json({ data: { error: 'Signature required' } }, 403);
      } else {
        const reqUrl = new URL(req.url);
        const fwdHost = req.headers.get('x-forwarded-host') || req.headers.get('host');
        const fwdProto = req.headers.get('x-forwarded-proto') || 'https';
        const publicUrl = fwdHost ? `${fwdProto}://${fwdHost}${reqUrl.pathname}${reqUrl.search}` : null;
        const publicUrlNoQuery = fwdHost ? `${fwdProto}://${fwdHost}${reqUrl.pathname}` : null;
        // SignalWire signs using the EXACT callback URL it was configured with
        // (the value we stored in status_callback_url). On Base44's stable
        // domain the inbound x-forwarded-host is an ephemeral deploy host, so
        // publicUrl won't match — the configured URL is the authoritative one.
        const candidates = [
          configs?.[0]?.status_callback_url,
          publicUrl,
          publicUrlNoQuery,
          reqUrl.toString(),
        ].filter(Boolean);

        let valid = false;
        for (const candidate of candidates) {
          if (await validateSignature(signingKey, candidate, params, signature)) { valid = true; break; }
        }
        if (!valid) {
          console.warn(`[signalWireWebhook] ❌ Invalid signature for CallSid=${callSid}. Tried: ${candidates.join(' | ')}`);
          return c.json({ data: { error: 'Invalid signature' } }, 403);
        }
      }
    }

    const logs = await base44.entities.CallLog.filter({ call_sid: callSid }).catch(() => []);
    if (!logs.length) {
      console.log(`[signalWireWebhook] No CallLog for CallSid=${callSid} (event=${callStatus}) — ignoring`);
      return c.json({ data: { success: true, ignored: 'no_call_log' } });
    }
    const callLog = logs[0];

    // Recording callbacks arrive with RecordingUrl but no CallStatus.
    // Detect them so we save the recording without touching call status.
    const isRecordingCallback = !!params.RecordingUrl && !callStatus;
    const mappedStatus = STATUS_MAP[callStatus] || callLog.status;
    const update = isRecordingCallback ? {} : { status: mappedStatus };

    if (['completed', 'failed', 'canceled', 'busy', 'no-answer'].includes(callStatus)) {
      update.call_end_time = new Date().toISOString();
      if (params.CallDuration) update.duration = parseInt(params.CallDuration, 10);
      if (params.Price) {
        const priceNum = Math.abs(parseFloat(params.Price));
        if (!isNaN(priceNum)) update.provider_cost = priceNum;
      }
      if (params.PriceUnit) update.provider_currency = params.PriceUnit;
    }
    if (params.RecordingUrl) {
      // Avoid double-appending .mp3 if SignalWire already includes an extension.
      const rec = params.RecordingUrl;
      update.recording_url = /\.(mp3|wav)$/i.test(rec) ? rec : rec + '.mp3';
    }

    await base44.entities.CallLog.update(callLog.id, update);
    console.log(`[signalWireWebhook] CallSid=${callSid} status=${callStatus || 'recording'} → ${isRecordingCallback ? 'recording_saved' : mappedStatus}`);

    // Recording-only callback: nothing else to do (no status change / post-call fan-out).
    if (isRecordingCallback) {
      return c.json({ data: { success: true, recording_saved: true } });
    }

    // International minute accounting (US/UK clients)
    if (mappedStatus === 'completed' && update.duration && callLog.client_id) {
      const minutes = Math.ceil(update.duration / 60);
      try {
        const client = await base44.entities.Client.get(callLog.client_id);
        if (client && (client.region === 'US' || client.region === 'UK')) {
          const used = Number(client.minutes_used_this_period || 0) + minutes;
          base44.entities.Client.update(client.id, { minutes_used_this_period: used })
            .catch((e) => console.error('[signalWireWebhook] minute counter failed:', e.message));
        }
      } catch (e) {
        console.error('[signalWireWebhook] minute accounting skipped:', e.message);
      }
    }

    if (['completed', 'no_answer', 'failed'].includes(mappedStatus)) {
      const freshCallLog = await base44.entities.CallLog.get(callLog.id).catch(() => callLog);

      try {
        base44.functions.invoke('campaignPostCall', {
          event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
          data: freshCallLog,
          old_data: { ...freshCallLog, status: callLog.status }
        }).catch(e => console.error(`[signalWireWebhook] campaignPostCall failed: ${e.message}`));
      } catch (_) {}

      try {
        base44.functions.invoke('postCallFollowup', {
          event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
          data: freshCallLog,
          old_data: { ...freshCallLog, status: callLog.status }
        }).catch(e => console.error(`[signalWireWebhook] postCallFollowup failed: ${e.message}`));
      } catch (_) {}

      if (freshCallLog.transcript && freshCallLog.transcript.length > 50) {
        try {
          base44.functions.invoke('postCallActionExtractor', {
            event: { type: 'update', entity_name: 'CallLog', entity_id: callLog.id },
            data: freshCallLog,
            old_data: { ...freshCallLog, transcript: null }
          }).catch(e => console.error(`[signalWireWebhook] postCallActionExtractor failed: ${e.message}`));
        } catch (_) {}
      }
    }

    return c.json({ data: { success: true, status: mappedStatus } });
  } catch (error) {
    console.error('[signalWireWebhook] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};