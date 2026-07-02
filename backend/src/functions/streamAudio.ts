import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";
// ╔══════════════════════════════════════════════════════════════════════╗
// ║  ⚠️  DEPRECATED — LEGACY MONOLITHIC STREAM  ⚠️                       ║
// ║                                                                      ║
// ║  As of Phase 4 (2026-05), this function is replaced by 5 dedicated   ║
// ║  channels for better isolation and faster startup:                   ║
// ║                                                                      ║
// ║   • streamGeminiPersonal    — Personal AI (Gemini, in+out)           ║
// ║   • streamGeminiOutgoing    — Business outbound (Gemini)             ║
// ║   • streamGeminiIncoming    — Business inbound (Gemini)              ║
// ║   • streamRealtimeOutgoing  — Business outbound (Realtime/Azure)     ║
// ║   • streamRealtimeIncoming  — Business inbound (Realtime/Azure)      ║
// ║                                                                      ║
// ║  KEPT ONLINE for safety: any Smartflo channel still pointing at      ║
// ║  /functions/streamAudio will keep working until you migrate it.      ║
// ║  Look for `⚠️ LEGACY streamAudio HIT` in logs to find old bindings.  ║
// ║                                                                      ║
// ║  DO NOT add features here. Modify the dedicated streams instead.     ║
// ╚══════════════════════════════════════════════════════════════════════╝



// ─── Audio Conversion Helpers ───

function decodeMulaw(mulawByte) {
  const MULAW_BIAS = 33;
  let mu = ~mulawByte & 0xFF;
  const sign = (mu & 0x80) ? -1 : 1;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign * sample;
}

function encodeMulaw(sample) {
  const MULAW_MAX = 32635;
  const MULAW_BIAS = 33;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;
  let exponent = 7;
  const expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & expMask) break;
    sample <<= 1;
  }
  const mantissa = (sample >> 10) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Realtime API uses 24kHz PCM16, Smartflo uses 8kHz mu-law
// We need to upsample 8k→24k on input, downsample 24k→8k on output
//
// CRITICAL: Resampling state MUST be per-session — declaring it at module scope
// shares it across ALL concurrent calls in the same Deno isolate, causing
// audio samples from one call to leak into another → breaking/glitchy voice.

// Convert mu-law 8kHz → PCM16 24kHz LE base64 (upsample 3x with linear interpolation)
// `state` is a per-session object: { prevUpsample: number }
function mulawToBase64PCM16_24k(mulawBytes, state) {
  const len = mulawBytes.length;
  const pcm8k = new Int16Array(len);
  for (let i = 0; i < len; i++) pcm8k[i] = decodeMulaw(mulawBytes[i]);

  // Linear interpolation 8k→24k: for each pair of 8k samples, produce 3 output samples
  const pcm24k = new Int16Array(len * 3);
  for (let i = 0; i < len; i++) {
    const prev = i === 0 ? state.prevUpsample : pcm8k[i - 1];
    const curr = pcm8k[i];
    pcm24k[i * 3]     = Math.round(prev + (curr - prev) * (1/3));
    pcm24k[i * 3 + 1] = Math.round(prev + (curr - prev) * (2/3));
    pcm24k[i * 3 + 2] = curr;
  }
  if (len > 0) state.prevUpsample = pcm8k[len - 1];

  // Convert Int16Array to base64
  const buf = new Uint8Array(pcm24k.length * 2);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < pcm24k.length; i++) dv.setInt16(i * 2, pcm24k[i], true);
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

// Convert PCM16 24kHz LE base64 → mu-law 8kHz bytes (downsample 3x)
// Uses 5-tap symmetric FIR low-pass [1,2,3,2,1]/9 before decimation to prevent aliasing
// `state` is a per-session object: { downRemainder: number[] }
function base64PCM16_24kToMulaw(base64Pcm16, state) {
  const raw = atob(base64Pcm16);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  const numSamples = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Prepend leftover from previous chunk
  const remainder = state.downRemainder;
  const total = remainder.length + numSamples;
  const all = new Int16Array(total);
  for (let i = 0; i < remainder.length; i++) all[i] = remainder[i];
  for (let i = 0; i < numSamples; i++) all[remainder.length + i] = view.getInt16(i * 2, true);

  const outLen = Math.floor(total / 3);
  const mulaw = new Uint8Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const c = i * 3; // center sample index
    // 5-tap symmetric FIR: [1,2,3,2,1]/9
    const s_m2 = c >= 2 ? all[c - 2] : (c >= 1 ? all[c - 1] : all[c]);
    const s_m1 = c >= 1 ? all[c - 1] : all[c];
    const s_0  = all[c];
    const s_p1 = c + 1 < total ? all[c + 1] : s_0;
    const s_p2 = c + 2 < total ? all[c + 2] : s_p1;
    const filtered = Math.round((s_m2 + 2*s_m1 + 3*s_0 + 2*s_p1 + s_p2) / 9);
    const clamped = Math.max(-32768, Math.min(32767, filtered));
    mulaw[i] = encodeMulaw(clamped);
  }

  // Save remainder per-session
  const consumed = outLen * 3;
  const newRemainder = [];
  for (let i = consumed; i < total; i++) newRemainder.push(all[i]);
  state.downRemainder = newRemainder;

  return mulaw;
}

// ─── Filler audio cache (cold-start hider) ───
// Single pre-recorded "Hello" mu-law 8kHz clip stored in private storage.
// Fetched ONCE per isolate at module load (kicks off in background), then served
// from in-memory Uint8Array for every subsequent call. Zero per-call network/TTS.
const FILLER_URI = 'mp/private/698823c19043e168a5daaa86/69ee309a0_filler_hello.mulaw';
let _fillerCache = null;
let _fillerLoadPromise = null;

async function loadFillerFromStorage(uri, label, sdk) {
  try {
    const { signed_url } = await sdk.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: 3600 });
    const res = await fetch(signed_url);
    if (!res.ok) { console.error(`[filler] fetch failed for ${label}: ${res.status}`); return null; }
    const buf = new Uint8Array(await res.arrayBuffer());
    console.log(`[filler] Loaded ${label}: ${buf.length} bytes (~${Math.round(buf.length/8000*1000)}ms)`);
    return buf;
  } catch (e) {
    console.error(`[filler] load error for ${label}: ${e.message}`);
    return null;
  }
}

async function getFillerAudio(sdk) {
  if (_fillerCache) return _fillerCache;
  if (!_fillerLoadPromise && sdk) _fillerLoadPromise = loadFillerFromStorage(FILLER_URI, 'hello', sdk);
  if (_fillerLoadPromise) _fillerCache = await _fillerLoadPromise;
  return _fillerCache;
}

// ─── Save call record (reused from original) ───

async function saveCallRecord(session, reqId, duration, serviceClient) {
  if (!session.callLogId) {
    console.log(`[${reqId}] ⚠️ No callLogId, skipping save`);
    return;
  }
  if (session._saved) return;
  session._saved = true;

  try {
    const transcript = session.transcript
      .map(t => `${t.speaker}: ${t.text}`)
      .join('\n');

    const rawEndpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT') || '';
            // Normalize Azure endpoint: strip trailing slash and any /openai/... suffix to get just the base
    let baseUrl = rawEndpoint.replace(/\/+$/, '');
    // If endpoint already contains /openai/ path (e.g. from Azure AI Foundry), strip it
    const openaiIdx = baseUrl.indexOf('/openai/');
    if (openaiIdx > 0) baseUrl = baseUrl.substring(0, openaiIdx);
    // Also strip /api/projects/... paths from AI Foundry endpoints
    const apiProjIdx = baseUrl.indexOf('/api/projects');
    if (apiProjIdx > 0) baseUrl = baseUrl.substring(0, apiProjIdx);

    console.log(`[${reqId}] 🔗 Azure OpenAI base: ${baseUrl.substring(0, 60)}..., deployment: ${deployment}`);

    // ===== STEP 1: AI Analysis — summary + scoring + intent (single LLM call) =====
    let summary = '';
    let leadStatus = 'contacted';
    let sentiment = 'neutral';
    let leadScore = 0;
    let intentSignals = [];
    let scoreBreakdown = {};
    let keyTopics = [];
    let objections = [];

    if (transcript && transcript.trim().length > 30) {
      try {
        const analysisUrl = "__CHAT_COMPLETIONS_MIGRATED__";
        console.log(`[${reqId}] 🧠 AI Analysis URL: ${analysisUrl.substring(0, 100)}...`);
        const analysisRes = await fetch(
          analysisUrl,
          {
            method: 'POST',
            headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [
                {
                  role: 'system',
                  content: `You are an expert sales call analyst. Analyze the transcript and provide a comprehensive analysis.

                  IMPORTANT TRANSCRIPTION NOTES:
                  - Speech-to-text can MISINTERPRET short words. Common errors: "Hi" heard as "Bye-bye", "Haan" as "Nah", "Hello" as various words.
                  - If the transcript is very short (1-2 lines) and the customer only said a single word like "Bye-bye", "Bye", or similar — consider that it might actually be a greeting ("Hi", "Hello") that was misheard by the speech recognition system.
                  - Do NOT mark a lead as "do_not_call" or "very_negative" based on a single ambiguous short word. Use "contacted" or "no_answer" for such cases.
                  - Only use "do_not_call" when the customer EXPLICITLY and CLEARLY says they don't want to be called (e.g., "Don't call me again", "Remove my number", "I'm not interested, stop calling").
                  - For very short calls (under 30 seconds) with minimal customer speech, default to lead_status "contacted" and sentiment "neutral".

                  SCORING (total 100):
                  - Sentiment (0-25): very_negative=0, negative=5, neutral=12, positive=20, very_positive=25
                  - Intent signals (0-30): pricing_inquiry=+10, demo_request=+15, budget_confirmed=+15, timeline_mentioned=+10, decision_maker=+10
                  - Engagement (0-25): short_answers=5, asked_questions=15, highly_engaged=25
                  - Keywords (0-20): positive="interested","sign up","sounds good"=+5 each; negative="not interested","too expensive"=-5 each

                  Respond ONLY in valid JSON.`
                },
                {
                  role: 'user',
                  content: `Analyze this call transcript:\n\n${transcript}\n\nReturn JSON:
{
  "summary": "2-3 sentence summary of the call",
  "lead_status": "interested|not_interested|callback|no_answer|converted|contacted|do_not_call",
  "sentiment": "very_positive|positive|neutral|negative|very_negative",
  "lead_score": 0-100,
  "intent_signals": ["pricing_inquiry","demo_request","budget_confirmed","timeline_mentioned","decision_maker","referral","objection_price","objection_timing","follow_up_requested"],
  "score_breakdown": {"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},
  "key_topics": ["topic1","topic2"],
  "objections": ["objection1"],
  "recommended_next_action": "..."
}`
                }
              ],
              max_completion_tokens: 800,
              response_format: { type: "json_object" }
            })
          }
        );

        if (analysisRes.ok) {
          const analysisData = await analysisRes.json();
          const analysis = JSON.parse(analysisData.choices?.[0]?.message?.content || '{}');
          summary = analysis.summary || '';
          leadStatus = analysis.lead_status || 'contacted';
          sentiment = analysis.sentiment || 'neutral';
          leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
          intentSignals = analysis.intent_signals || [];
          scoreBreakdown = {
            ...(analysis.score_breakdown || {}),
            objections: analysis.objections || [],
            recommended_next_action: analysis.recommended_next_action || '',
            key_topics: analysis.key_topics || []
          };
          keyTopics = analysis.key_topics || [];
          objections = analysis.objections || [];
          console.log(`[${reqId}] 🧠 AI Analysis: score=${leadScore}, status=${leadStatus}, sentiment=${sentiment}`);
        } else {
          console.error(`[${reqId}] ⚠️ AI analysis failed: ${analysisRes.status}`);
        }
      } catch (analysisErr) {
        console.error(`[${reqId}] ⚠️ AI analysis error: ${analysisErr.message}`);
      }
    } else if (!transcript || transcript.trim().length <= 30) {
      summary = 'Call ended with minimal or no conversation captured via WebSocket.';
    }

    // ===== STEP 2: Determine qualification tier =====
    let qualificationTier = 'cold';
    let qualificationReason = '';

    const highIntents = ['demo_request', 'budget_confirmed', 'timeline_mentioned', 'decision_maker']
      .filter(s => intentSignals.includes(s));

    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) {
      qualificationTier = 'hot';
      qualificationReason = `Score ${leadScore}/100, ${sentiment}, signals: ${highIntents.join(', ') || 'high engagement'}`;
    } else if (leadScore >= 50) {
      qualificationTier = 'warm';
      qualificationReason = `Score ${leadScore}/100, ${sentiment} sentiment`;
    } else if (leadScore >= 25) {
      qualificationTier = 'nurture';
      qualificationReason = `Score ${leadScore}/100 — needs nurturing`;
    } else if (['negative', 'very_negative'].includes(sentiment)) {
      qualificationTier = 'disqualified';
      qualificationReason = `Low score ${leadScore}/100, ${sentiment}`;
    } else {
      qualificationTier = 'cold';
      qualificationReason = `Low score ${leadScore}/100 — minimal engagement`;
    }
    if (leadStatus === 'converted') { qualificationTier = 'hot'; qualificationReason = 'Converted'; }

    // ── Safeguard: prevent misclassification from very short/ambiguous calls ──
    const customerLines = session.transcript.filter(t => t.speaker === 'Customer');
    const totalCustomerWords = customerLines.reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);
    if (totalCustomerWords <= 5 && duration < 30) {
      if (leadStatus === 'do_not_call' || leadStatus === 'not_interested') {
        console.log(`[${reqId}] ⚠️ Short call safeguard: overriding ${leadStatus}→contacted (only ${totalCustomerWords} customer words in ${duration}s)`);
        leadStatus = 'contacted';
        sentiment = 'neutral';
        leadScore = Math.max(leadScore, 10);
        qualificationTier = 'cold';
        qualificationReason = `Short call (${duration}s) with minimal response — needs follow-up`;
      }
    }

    if (leadStatus === 'do_not_call') { qualificationTier = 'disqualified'; qualificationReason = 'Do not call'; }

    // ===== STEP 3: Save CallLog with full analysis =====
    const currentLog = await serviceClient.entities.CallLog.get(session.callLogId);
    const wasAlreadyCompleted = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);

    const enrichedSummary = summary
      ? `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Tier: ${qualificationTier} | Signals: ${intentSignals.join(', ')}`
      : '';

    const callLogUpdate = wasAlreadyCompleted
      ? {
          transcript: transcript || '',
          duration: duration,
          lead_status_updated: leadStatus,
          conversation_summary: enrichedSummary || summary || ''
        }
      : {
          status: 'completed',
          transcript: transcript || '',
          duration: duration,
          call_end_time: new Date().toISOString(),
          lead_status_updated: leadStatus,
          conversation_summary: enrichedSummary || summary || ''
        };

    // ── POSTGRES-PRIMARY WRITE ──
    // The transcript + AI summary are the most valuable call data. Write them
    // to the Azure Postgres mirror FIRST (awaited) so they survive a Base44 429.
    try {
      await serviceClient.functions.invoke('pgLeadSync', { call_log: { ...currentLog, ...callLogUpdate } });
      console.log(`[${reqId}] 🐘 PG-primary transcript write ok: ${session.callLogId}`);
    } catch (pgErr) {
      console.error(`[${reqId}] ⚠️ PG-primary write failed: ${pgErr.message}`);
    }
    // Mirror to Base44 (still awaited — downstream steps re-read this CallLog).
    await serviceClient.entities.CallLog.update(session.callLogId, callLogUpdate);
    console.log(`[${reqId}] 💾 Call ${wasAlreadyCompleted ? `already ${currentLog.status}, added transcript` : 'saved as completed'}: ${session.callLogId}, score=${leadScore}`);

    // ===== STEP 4: Update Lead with AI scoring (if lead exists) =====
    if (currentLog.lead_id) {
      try {
        const existingLead = await serviceClient.entities.Lead.get(currentLog.lead_id);
        const existingTags = existingLead.tags || [];
        const mergedTags = [...new Set([...existingTags, ...keyTopics.slice(0, 10)])];

        await serviceClient.entities.Lead.update(currentLog.lead_id, {
          status: leadStatus,
          score: leadScore,
          sentiment: sentiment,
          intent_signals: intentSignals,
          score_breakdown: scoreBreakdown,
          qualification_tier: qualificationTier,
          qualification_reason: qualificationReason,
          tags: mergedTags,
          last_call_date: new Date().toISOString(),
          last_engagement_date: new Date().toISOString(),
          engagement_count: (existingLead.engagement_count || 0) + 1,
          notes: `[Score: ${leadScore}/100 | ${sentiment} | ${qualificationTier}] ${summary.substring(0, 300)}`
        });
        console.log(`[${reqId}] 📊 Lead ${currentLog.lead_id} updated: score=${leadScore}, tier=${qualificationTier}`);
      } catch (leadErr) {
        console.error(`[${reqId}] ⚠️ Lead update failed: ${leadErr.message}`);
      }
    }

    // ===== STEP 4.5: Save VoicemailMessage for personal accounts =====
    if (session._personalMode && session._personalClientId) {
      try {
        const customerMsgs = session.transcript.filter(t => t.speaker === 'Customer').map(t => t.text);
        const callerName = (() => {
          for (const line of customerMsgs) {
            const nameMatch = line.match(/(?:my name is|this is|I am|main|mera naam)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);
            if (nameMatch) return nameMatch[1];
          }
          return '';
        })();

        const summaryLower = (summary || '').toLowerCase();
        let category = 'unknown';
        if (summaryLower.includes('spam') || summaryLower.includes('telemarketing')) category = 'spam';
        else if (summaryLower.includes('promotional') || summaryLower.includes('offer')) category = 'promotional';
        else if (summaryLower.includes('family') || summaryLower.includes('friend')) category = 'family';
        else if (summaryLower.includes('business') || summaryLower.includes('meeting') || summaryLower.includes('work')) category = 'business';

        let urgency = 'medium';
        if (summaryLower.includes('urgent') || summaryLower.includes('emergency') || summaryLower.includes('important')) urgency = 'urgent';
        else if (sentiment === 'very_positive' || summaryLower.includes('asap')) urgency = 'high';
        else if (category === 'spam' || category === 'promotional') urgency = 'low';

        const messageText = customerMsgs.join(' ').substring(0, 1000) || summary || 'No message content captured';

        await serviceClient.entities.VoicemailMessage.create({ client_id: session._personalClientId, call_log_id: session.callLogId, caller_number: currentLog.caller_id || currentLog.callee_number || '', caller_name: callerName, message: summary || messageText, urgency, category, is_read: false });
        console.log(`[${reqId}] 📨 VoicemailMessage saved: category=${category}, urgency=${urgency}`);
        // Send post-call Telegram summary directly
        const tgTk = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgTk) { try { const pCl = await serviceClient.entities.Client.get(session._personalClientId);
          if (pCl?.telegram_connected && pCl?.telegram_chat_id && !pCl.dnd_enabled && pCl.owner_notification_channel === 'telegram') {
            const emj = category === 'spam' ? '🚫' : category === 'family' ? '👨‍👩‍👧' : category === 'business' ? '💼' : '📋';
            const tgS = `${emj} <b>Call Summary</b>\n\n📱 From: <b>${callerName || currentLog.caller_id || 'Unknown'}</b>\n🏷️ ${category}${urgency !== 'medium' ? ' | ⚡ ' + urgency.toUpperCase() : ''}\n\n💬 ${(summary || messageText).substring(0, 500)}`;
            fetch(`https://api.telegram.org/bot${tgTk}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: pCl.telegram_chat_id, text: tgS, parse_mode: 'HTML' }) }).then(r => r.json()).then(r => console.log(`[${reqId}] 📱 TG summary: ok=${r.ok}`)).catch(() => {});
          } } catch (_) {} }
      } catch (vmErr) {
        console.error(`[${reqId}] ⚠️ VoicemailMessage save failed: ${vmErr.message}`);
      }
    }

    // ===== STEP 5: Auto-create Lead for inbound calls from unknown numbers (fire-and-forget) =====
    // Only for business accounts (personal accounts use voicemail instead).
    // Only if: inbound + no existing lead + has transcript + not a screening call.
    if (
      currentLog?.direction === 'inbound' &&
      !currentLog?.lead_id &&
      transcript.length > 50 &&
      !session._personalMode &&
      !currentLog?.agent_config_cache?.is_screening_call
    ) {
      serviceClient.functions.invoke('autoCreateLeadFromInbound', {
        call_log_id: session.callLogId
      }).then(r => console.log(`[${reqId}] 🆕 autoCreateLeadFromInbound: ${JSON.stringify(r?.data || {}).substring(0, 150)}`))
        .catch(e => console.error(`[${reqId}] ⚠️ autoCreateLeadFromInbound failed: ${e.message}`));
    }

    // ===== STEP 6: Trigger post-call action extraction (fire-and-forget) =====
    if (transcript.length > 50) {
      serviceClient.functions.invoke('postCallActionExtractor', {
        call_log_id: session.callLogId
      }).then(() => console.log(`[${reqId}] 📋 Action extraction triggered`))
        .catch(e => console.error(`[${reqId}] ⚠️ Action extraction failed: ${e.message}`));
    }

    // Process screening result if this was a screening call
    if (currentLog?.agent_config_cache?.is_screening_call) {
      console.log(`[${reqId}] 🔬 Triggering processScreeningResult for screening call (log=${session.callLogId})`);
      serviceClient.functions.invoke('processScreeningResult', { call_log_id: session.callLogId })
        .then(r => console.log(`[${reqId}] ✅ processScreeningResult result:`, JSON.stringify(r?.data || {}).substring(0, 200)))
        .catch(e => console.error(`[${reqId}] ❌ processScreeningResult FAILED: ${e.message}`));
    }

    try { serviceClient.cleanup(); } catch (_) { /* ignore */ }
  } catch (err) {
    console.error(`[${reqId}] ❌ Save failed:`, err.message);
  }
}

// ─── Main Handler ───

export default async function streamAudio(c: any) {
  const req = c.req.raw || c.req;
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWebSocket = upgrade === 'websocket';

  console.log(`[${reqId}] 📨 ${req.method} ${req.url}, ws=${isWebSocket}`);

  // Inject Base44 App ID
  let base44Req = req;
  if (!req.headers.get('Base44-App-Id')) {
    const appId = Deno.env.get('BASE44_APP_ID');
    if (appId) {
      const newHeaders = new Headers(req.headers);
      newHeaders.set('Base44-App-Id', appId);
      base44Req = new Request(req.url, { method: req.method, headers: newHeaders });
    }
  }
  /* const base44 = ... */;
  const serviceClient = base44.asServiceRole;
  // Kick off filler pre-warm once we have a valid service client
  if (!_fillerLoadPromise) {
    _fillerLoadPromise = loadFillerFromStorage(FILLER_URI, 'hello', serviceClient).then(b => { _fillerCache = b; return b; });
  }

  // Non-WebSocket: Smartflo Dynamic endpoint or status check
  if (!isWebSocket) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    const wssUrl = `wss://${host}/functions/streamAudio`;
    if (req.method === 'POST') {
      try { const bd = await c.req.json(); console.log(`[${reqId}] 📨 Dynamic POST:`, JSON.stringify(bd)); } catch (_) {}
    }
    // Smartflo Dynamic endpoint requires exactly {"sucess": true, "wss_url": "wss://..."} — note: "sucess" with one 's' is Smartflo's spec
    return c.json({ data: { sucess: true, wss_url: wssUrl } }, 200);
  }

  // ⚠️  LEGACY DEPRECATION WARNING — emit on every WSS upgrade so you can spot
  // any Smartflo channel still bound to this old monolithic stream and migrate
  // it to the dedicated stream functions (streamGemini*/streamRealtime*).
  console.warn(`[${reqId}] ⚠️ LEGACY streamAudio HIT — migrate the Smartflo channel that opened this WSS to a dedicated stream (streamGeminiOutgoing/Incoming/Personal or streamRealtimeOutgoing/Incoming).`);

  // ─── Upgrade Smartflo WebSocket ───
  let smartfloSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    smartfloSocket = upgraded.socket;
    response = upgraded.response;
    console.log(`[${reqId}] ✅ Smartflo WebSocket upgraded`);
  } catch (err) {
    console.error(`[${reqId}] ❌ Upgrade failed: ${err.message}`);
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  // ─── Session State ───
  const session = {
    streamSid: null,
    callSid: null,
    callLogId: null,
    clientId: null,
    transcript: [],
    startTime: Date.now(),
    systemPrompt: 'You are a friendly AI voice assistant. Be professional and concise. Keep responses to 1-3 sentences.',
    greetingMessage: '',
    voiceEngine: 'realtime',
    voiceType: 'alloy',
    _saved: false,
    smartfloCallId: null,
    realtimeWs: null,
    realtimeReady: false,
    isSpeaking: false,
    _ttsAbort: null,
    chatHistory: [],
    tools: [],
    hasShopify: false,
    humanTransferNumber: '',
    enableAutoTransfer: true,
    _realtimeReconnectAttempts: 0,
    _callEnded: false,
    _awaitingOwnerDecision: false,
    _ownerDecisionExecuted: false,
    _ownerName: '',
    _agentConfigReady: false,
    calleeNumber: '',
    callerNumber: '',
    _personalMode: null,
    _personalClientId: null,
    _isTrustedCaller: false,
    _trustedContactName: '',
    _midCallTgSent: false,
    // ── Slim-cache additions ──
    _kbChunks: [],
    _kbFileUri: '',
    _kbLoadPromise: null,
    _leadId: null,
    _toolFlags: {},
    // ── Filler audio (cold-start hider) ──
    _fillerStarted: false,
    _fillerPlaying: false,
    _fillerAborted: false,
    // ── Per-session audio resample state (CRITICAL: must NOT be shared across calls) ──
    _resampleState: { prevUpsample: 0, downRemainder: [] }
  };

  // ─── Play filler audio (real-time paced, interruptible) ───
  // Only plays if first real audio hasn't arrived within 800ms (cold-start hider).
  // Streams 20ms chunks every 20ms = real-time pacing → no buffer pile-up in Smartflo.
  // On stop: aborts the loop AND sends 'clear' event so Smartflo flushes any queued filler.
  async function playFillerAudio() {
    if (session._fillerPlaying || session._fillerStarted) return;
    session._fillerStarted = true;
    // Wait 800ms first — if real audio arrived by then, skip filler entirely.
    await new Promise(r => setTimeout(r, 800));
    if (session._fillerAborted || session.isSpeaking || session._callEnded) return;
    if (smartfloSocket.readyState !== WebSocket.OPEN || !session.streamSid) return;

    session._fillerPlaying = true;
    try {
      const filler = await getFillerAudio(serviceClient);
      if (!filler || session._fillerAborted || session.isSpeaking) { session._fillerPlaying = false; return; }
      console.log(`[${reqId}] 🎙️ FILLER playing: ${filler.length} bytes (~${Math.round(filler.length/8000*1000)}ms) at t=${Date.now()-session.startTime}ms`);
      // Real-time pacing: 160 bytes (20ms @ 8kHz mu-law) every 20ms.
      // This matches playback speed → Smartflo's jitter buffer stays minimal,
      // so when we abort, almost nothing is left to flush.
      for (let i = 0; i < filler.length; i += 160) {
        if (session._fillerAborted || session.isSpeaking || session._callEnded) break;
        if (smartfloSocket.readyState !== WebSocket.OPEN) break;
        let chunk = filler.slice(i, Math.min(i + 160, filler.length));
        if (chunk.length < 160) {
          const padded = new Uint8Array(160);
          padded.set(chunk); padded.fill(0xFF, chunk.length);  // 0xFF = true mu-law silence
          chunk = padded;
        }
        smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
        await new Promise(r => setTimeout(r, 20));
      }
    } catch (e) { console.error(`[${reqId}] ❌ Filler playback error: ${e.message}`); }
    finally { session._fillerPlaying = false; }
  }

  // Stop filler playback. If filler was actively playing, send `clear` to Smartflo
  // to flush any queued bytes so they don't bleed into the real LLM audio.
  function stopFiller() {
    const wasPlaying = session._fillerPlaying;
    session._fillerAborted = true;
    if (wasPlaying && smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
      smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
  }

  // ─── Simple KB chunker (matches Gemini version — ~400-600 chars per chunk) ───
  function splitKBIntoChunks(kbContent) {
    if (!kbContent || kbContent.length < 100) return [];
    const chunks = [];
    const docs = kbContent.split(/\n---\n/);
    for (const doc of docs) {
      const trimmed = doc.trim();
      if (!trimmed) continue;
      if (trimmed.length <= 600) { chunks.push(trimmed); continue; }
      const paragraphs = trimmed.split(/\n\n+/);
      let buffer = '';
      for (const p of paragraphs) {
        if ((buffer + '\n\n' + p).length > 600 && buffer) { chunks.push(buffer.trim()); buffer = p; }
        else { buffer = buffer ? buffer + '\n\n' + p : p; }
      }
      if (buffer.trim()) chunks.push(buffer.trim());
    }
    return chunks.filter(c => c.length >= 30);
  }

  // ─── Keyword-scored KB search (top-3 chunks) ───
  function searchKBChunks(query) {
    if (!session._kbChunks || session._kbChunks.length === 0) return '';
    const keywords = (query || '').toLowerCase()
      .replace(/[^\w\s\u0900-\u097F]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3);
    if (keywords.length === 0) return session._kbChunks.slice(0, 2).join('\n\n---\n\n');
    const scored = session._kbChunks.map(chunk => {
      const lower = chunk.toLowerCase();
      let score = 0;
      for (const kw of keywords) score += lower.split(kw).length - 1;
      return { chunk, score };
    });
    const top = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
    if (top.length === 0) return session._kbChunks.slice(0, 2).join('\n\n---\n\n');
    return top.map(t => t.chunk).join('\n\n---\n\n');
  }

  // ─── Lazy-load KB from private file ───
  async function loadKBLazy() {
    if (session._kbChunks && session._kbChunks.length > 0) return;
    if (!session._kbFileUri) return;
    if (session._kbLoadPromise) { await session._kbLoadPromise; return; }
    session._kbLoadPromise = (async () => {
      const t0 = Date.now();
      try {
        const svc = serviceClient;
        const signed = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: session._kbFileUri, expires_in: 300 });
        const url = signed?.signed_url;
        if (!url) return;
        const res = await fetch(url);
        if (!res.ok) return;
        const text = await res.text();
        session._kbChunks = splitKBIntoChunks(text);
        console.log(`[${reqId}] 📚 KB lazy-loaded: ${text.length} chars → ${session._kbChunks.length} chunks in ${Date.now()-t0}ms`);
      } catch (e) {
        console.log(`[${reqId}] ⚠️ KB lazy-load error: ${e.message}`);
      }
    })();
    await session._kbLoadPromise;
  }

  // ─── Connect to Azure Realtime API ───
  function connectRealtime() {
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_KEY');

    if (!realtimeUrl || !realtimeKey) {
      console.error(`[${reqId}] ❌ Missing AZURE_REALTIME_ENDPOINT or AZURE_REALTIME_KEY`);
      return;
    }

    // Extract just the host from the endpoint (strip any path like /openai/deployments/...)
    let baseHost = realtimeUrl.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
    // Remove any path after the hostname
    const slashIdx = baseHost.indexOf('/');
    if (slashIdx > 0) baseHost = baseHost.substring(0, slashIdx);
    
    const realtimeDeployment = Deno.env.get('AZURE_REALTIME_DEPLOYMENT') || 'gpt-4o-realtime-preview';
    // Azure Realtime API version — allow override via env, default to widely-supported preview
    const apiVersion = Deno.env.get('AZURE_REALTIME_API_VERSION') || '2024-10-01-preview';
    const wsUrl = `wss://${baseHost}/openai/realtime?api-version=${apiVersion}&deployment=${realtimeDeployment}&api-key=${encodeURIComponent(realtimeKey)}`;
    console.log(`[${reqId}] 🔌 Connecting to Azure Realtime: wss://${baseHost}/openai/realtime?api-version=${apiVersion}&deployment=${realtimeDeployment}`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${reqId}] ✅ Azure Realtime WebSocket connected (attempt ${session._realtimeReconnectAttempts})`);
      session._realtimeReconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeMessage(msg);
      } catch (err) {
        console.error(`[${reqId}] ❌ Realtime message parse error: ${err.message}`);
      }
    };

    ws.onclose = (event) => {
      console.log(`[${reqId}] 🔴 Azure Realtime closed: code=${event.code} reason="${event.reason || '(empty)'}" wasClean=${event.wasClean} deployment=${realtimeDeployment} apiVersion=${apiVersion}`);
      session.realtimeReady = false;
      const MAX_RECONNECT = 3;
      if (!session._callEnded && session._realtimeReconnectAttempts < MAX_RECONNECT) {
        session._realtimeReconnectAttempts++;
        const delay = session._realtimeReconnectAttempts * 1000;
        console.log(`[${reqId}] 🔄 Reconnecting Azure Realtime (attempt ${session._realtimeReconnectAttempts}/${MAX_RECONNECT}) in ${delay}ms...`);
        setTimeout(() => {
          if (!session._callEnded) connectRealtime();
        }, delay);
      } else if (!session._callEnded) {
        console.error(`[${reqId}] ❌ Azure Realtime reconnect exhausted (${MAX_RECONNECT} attempts). Call voice is dead.`);
      }
    };

    ws.onerror = () => { console.error(`[${reqId}] ❌ Azure Realtime error`); };
    session.realtimeWs = ws;
  }

  // ─── Hang up call via Smartflo API ───
  async function hangupCall(reason) {
    console.log(`[${reqId}] 📴 Hanging up: "${reason}", callSid=${session.callSid}, smartfloCallId=${session.smartfloCallId || 'none'}`);
    session._callEnded = true;
    try {
      const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
      if (sfE && sfP) {
        const lr = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ email: sfE, password: sfP })
        });
        const ld = await lr.json();
        const tk = ld.access_token || ld.token;
        if (tk) {
          const liveCallId = await findLiveCallId(tk);
          const callIdCandidates = [...new Set([liveCallId, session.smartfloCallId, session.callSid].filter(Boolean))];
          let hungUp = false;
          for (const candidateId of callIdCandidates) {
            if (hungUp) break;
            const hr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/hangup', {
              method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
              body: JSON.stringify({ call_id: candidateId })
            });
            const hBody = await hr.json().catch(() => ({}));
            const success = hr.ok && hBody.success !== false;
            console.log(`[${reqId}] 📴 Hangup id=${String(candidateId).substring(0, 40)}: ${hr.status} ${JSON.stringify(hBody).substring(0, 200)}`);
            if (success) { hungUp = true; break; }
          }
          if (!hungUp) console.error(`[${reqId}] ❌ All hangup attempts failed`);
        }
      }
    } catch (e) { console.error(`[${reqId}] ⚠️ Hangup failed: ${e.message}`); }
    if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
  }

  async function findLiveCallId(token) {
    try {
      const r = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      });
      if (!r.ok) return null;
      const d = await r.json();
      const calls = Array.isArray(d) ? d : (d.data || []);
      const ce = (session.calleeNumber || '').replace(/\D/g, '').slice(-10);
      const cr = (session.callerNumber || '').replace(/\D/g, '').slice(-10);
      const m = calls.find(c => {
        const cn = (c.customer_number || '').replace(/\D/g, '').slice(-10);
        const did = (c.did || '').replace(/\D/g, '').slice(-10);
        return (ce && (cn === ce || did === ce)) || (cr && (cn === cr || did === cr));
      });
      if (m?.call_id) { console.log(`[${reqId}] 🔍 Live call_id: ${m.call_id}`); return m.call_id; }
    } catch (_) {}
    return null;
  }

  function buildToolDefinitions() {
    const tools = [];
    tools.push({type:'function',name:'end_call',description:'End/disconnect the call. Use when: conversation concluded with goodbye, spam declined, or caller asked to end. Say goodbye BEFORE calling this.',parameters:{type:'object',properties:{reason:{type:'string',description:'Brief reason'}},required:['reason']}});
    if (session.humanTransferNumber) {
      tools.push({type:'function',name:'transfer_to_human',description:'Transfer the call to a human agent. Use when customer explicitly asks or is very frustrated. Always confirm before transferring.',parameters:{type:'object',properties:{reason:{type:'string',description:'Brief reason for the transfer'}},required:['reason']}});
    }
    if (session.hasShopify) {
      tools.push({type:'function',name:'shopify_lookup',description:'Look up order status, tracking, products, or refunds from the Shopify store.',parameters:{type:'object',properties:{lookup_type:{type:'string',enum:['order_by_number','order_by_phone','order_by_email','product_search','refund_status','tracking'],description:'Type of lookup'},query:{type:'string',description:'Search query'}},required:['lookup_type','query']}});
    }
    // Knowledge base search — lazy-loaded, enabled whenever KB is configured
    if (session._toolFlags?.has_kb || (session._kbChunks && session._kbChunks.length > 0) || session._kbFileUri) {
      tools.push({type:'function',name:'search_knowledge_base',description:'Search the company knowledge base for product info, pricing, features, policies, FAQs. USE THIS whenever the customer asks about specific products, prices, features, timelines, policies, or anything company-specific. Do NOT answer from memory.',parameters:{type:'object',properties:{query:{type:'string',description:'Concise search query (2-6 keywords)'}},required:['query']}});
    }
    // Past call history — enabled when we have a lead_id
    if (session._toolFlags?.has_call_history && session._leadId) {
      tools.push({type:'function',name:'get_call_history',description:'Fetch detailed history of previous calls with this lead. USE THIS whenever the customer references past conversations ("as we discussed", "remember the quote", "last time"). Returns up to 5 previous call summaries.',parameters:{type:'object',properties:{},required:[]}});
    }
    session.tools = tools;
    return tools;
  }

  async function executeToolCall(callId, functionName, argsStr) {
    console.log(`[${reqId}] 🔧 Tool call: ${functionName}(${argsStr.substring(0, 200)})`);
    let result = { error: `Unknown tool: ${functionName}` };

    // Knowledge base search (lazy-loads KB file on first call)
    if (functionName === 'search_knowledge_base') {
      try {
        const args = JSON.parse(argsStr);
        const query = args.query || '';
        if ((!session._kbChunks || session._kbChunks.length === 0) && session._kbFileUri) {
          await loadKBLazy();
        }
        const results = searchKBChunks(query);
        result = { results: results || 'No relevant information found in knowledge base.' };
        console.log(`[${reqId}] 📚 KB search: "${query.substring(0, 60)}" → ${results.length} chars`);
      } catch (e) { result = { error: e.message }; }
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
      sendToRealtime({ type: 'response.create' });
      return;
    }

    // Call history tool
    if (functionName === 'get_call_history') {
      try {
        if (!session._leadId) { result = { error: 'No lead associated with this call' }; }
        else {
          const svc = serviceClient;
          const res = await svc.functions.invoke('getLeadCallHistory', { lead_id: session._leadId, limit: 5 });
          result = res?.data || { error: 'Failed to fetch call history' };
          console.log(`[${reqId}] 📞 Call history fetched: ${res?.data?.call_count || 0} calls`);
        }
      } catch (e) { result = { error: e.message }; }
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
      sendToRealtime({ type: 'response.create' });
      return;
    }

    if (functionName === 'end_call') {
      const a = JSON.parse(argsStr);
      result = { success: true };
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
      session.transcript.push({ speaker: 'System', text: `[Call ended: ${a.reason}]` });
      setTimeout(() => hangupCall(a.reason || 'ended'), 1500);
      return;
    }
    if (functionName === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const args = JSON.parse(argsStr);
        const reason = args.reason || 'customer requested';
        const sfEmail = Deno.env.get('SMARTFLO_EMAIL'), sfPassword = Deno.env.get('SMARTFLO_PASSWORD');
        if (sfEmail && sfPassword) {
          const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ email: sfEmail, password: sfPassword }) });
          const loginData = await loginResp.json();
          const token = loginData.access_token || loginData.token;
          if (token) {
            const txCallId = await findLiveCallId(token) || session.smartfloCallId || session.callSid;
            const transferResp = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ type: 4, call_id: txCallId, intercom: String(session.humanTransferNumber) }) });
            const transferData = await transferResp.json();
            if (transferResp.ok) {
            result = { success: true, message: 'Call is being transferred to a human agent.' };
            if (session.callLogId) { serviceClient.entities.CallLog.update(session.callLogId, { transferred_to: `Human agent (intercom: ${session.humanTransferNumber}, reason: ${reason})` }).catch(() => {}); }
              session.transcript.push({ speaker: 'System', text: `[Call transferred to human agent. Reason: ${reason}]` });
            } else { result = { error: `Transfer failed: ${transferData.message || transferResp.status}` }; }
          } else { result = { error: 'Smartflo login failed' }; }
        } else { result = { error: 'Transfer not configured' }; }
      } catch (err) { result = { error: err.message }; }
    }
    if (functionName === 'shopify_lookup' && session.clientId) {
      try {
        const args = JSON.parse(argsStr);
        const svc = serviceClient;
        const integrations = await svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, platform: 'shopify', status: 'active' });
        if (integrations.length > 0) {
          const shop = integrations[0];
          const storeUrl = shop.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const apiV = shop.api_version || '2024-01';
          const baseUrl = `https://${storeUrl}/admin/api/${apiV}`;
          const headers = { 'X-Shopify-Access-Token': shop.api_access_token, 'Content-Type': 'application/json' };
          if (args.lookup_type === 'order_by_number') { const on = args.query.startsWith('#') ? args.query : `#${args.query}`; const res = await fetch(`${baseUrl}/orders.json?name=${encodeURIComponent(on)}&status=any&limit=3`, { headers }); if (res.ok) { const d = await res.json(); result = { orders: (d.orders||[]).map(formatShopifyOrder) }; } }
          else if (args.lookup_type === 'order_by_phone') { const res = await fetch(`${baseUrl}/orders.json?status=any&limit=20`, { headers }); if (res.ok) { const d = await res.json(); const cQ = args.query.replace(/[^0-9]/g, ''); result = { orders: (d.orders||[]).filter(o => (o.customer?.phone||o.phone||'').replace(/[^0-9]/g, '').includes(cQ)).slice(0,5).map(formatShopifyOrder) }; } }
          else if (args.lookup_type === 'order_by_email') { const cr = await fetch(`${baseUrl}/customers/search.json?query=email:${encodeURIComponent(args.query)}&limit=1`, { headers }); if (cr.ok) { const cd = await cr.json(); if (cd.customers?.length>0) { const or = await fetch(`${baseUrl}/customers/${cd.customers[0].id}/orders.json?status=any&limit=5`, { headers }); const od = await or.json(); result = { customer_name: `${cd.customers[0].first_name||''} ${cd.customers[0].last_name||''}`.trim(), orders: (od.orders||[]).map(formatShopifyOrder) }; } else { result = { orders: [], message: 'No customer found' }; } } }
          else if (args.lookup_type === 'product_search') { const res = await fetch(`${baseUrl}/products.json?title=${encodeURIComponent(args.query)}&limit=5`, { headers }); if (res.ok) { const d = await res.json(); result = { products: (d.products||[]).map(p => ({ title: p.title, available: p.variants?.some(v => (v.inventory_quantity||0)>0), variants: p.variants?.map(v => ({ title: v.title, price: v.price, stock: v.inventory_quantity })) })) }; } }
          else if (args.lookup_type === 'tracking') { const res = await fetch(`${baseUrl}/orders/${args.query}/fulfillments.json`, { headers }); if (res.ok) { const d = await res.json(); result = { fulfillments: (d.fulfillments||[]).map(f => ({ tracking_number: f.tracking_number, tracking_company: f.tracking_company, tracking_url: f.tracking_url, status: f.shipment_status||f.status })) }; } }
          else if (args.lookup_type === 'refund_status') { const res = await fetch(`${baseUrl}/orders/${args.query}/refunds.json`, { headers }); if (res.ok) { const d = await res.json(); result = { refunds: (d.refunds||[]).map(r => ({ created_at: r.created_at, note: r.note, items: r.refund_line_items?.map(li => li.line_item?.title) })) }; } }
        } else { result = { error: 'No active Shopify integration' }; }
      } catch (err) { result = { error: err.message }; }
    }
    sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
    sendToRealtime({ type: 'response.create' });
  }

  function formatShopifyOrder(o) {
    const t = (o.fulfillments||[]).filter(f=>f.tracking_number).map(f=>({tracking_number:f.tracking_number,company:f.tracking_company,url:f.tracking_url,status:f.shipment_status||f.status}));
    return { order_number:o.name||`#${o.order_number}`, date:o.created_at?.substring(0,10), status:o.cancelled_at?'cancelled':(o.fulfillment_status||'unfulfilled'), payment:o.financial_status, total:`${o.currency} ${o.total_price}`, items:(o.line_items||[]).map(li=>`${li.title} x${li.quantity}`).join(', '), tracking:t.length>0?t:'no tracking yet' };
  }

  function applySessionConfig() {
    const isHybrid = session.voiceEngine === 'azure_speech';
    const tools = buildToolDefinitions();
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}.\n`;
    const noiseHandling = `\n[AUDIO RULES] ONLY respond to CLEAR, DIRECTED human speech. IGNORE background noise. If unclear, ask to repeat. NEVER end the call based on a single unclear word.\n`;

    let transferInstructions = '';
    if (session.humanTransferNumber && session.enableAutoTransfer) {
      transferInstructions = `\n\n--- HUMAN AGENT TRANSFER ---\nYou can transfer this call using the transfer_to_human tool when customer explicitly asks to speak to a human or is very frustrated. Always inform them before transferring.`;
    }
    const endCallRules = '\n\n--- CALL ENDING ---\nWhen the conversation is naturally finished (caller says bye/thanks/ok bye/accha theek hai/namaste etc., or you have completed taking their message), say your final goodbye politely and then IMMEDIATELY call the end_call tool to disconnect. Do NOT keep the call going after goodbyes.';

    const sessionConfig = {
      input_audio_format: 'pcm16',
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 }
    };

    if (isHybrid) {
      sessionConfig.instructions = 'You are a transcription-only assistant. Do not respond.';
      sessionConfig.modalities = ['text'];
      sessionConfig.voice = 'alloy';
      session.chatHistory = [{ role: 'system', content: timeInjection + noiseHandling + session.systemPrompt + transferInstructions + endCallRules }];
    } else {
      sessionConfig.modalities = ['text', 'audio'];
      sessionConfig.instructions = timeInjection + noiseHandling + session.systemPrompt + transferInstructions + endCallRules;
      sessionConfig.voice = session.voiceType;
      sessionConfig.output_audio_format = 'pcm16';
    }

    if (tools.length > 0) { sessionConfig.tools = tools; sessionConfig.tool_choice = 'auto'; }
    sendToRealtime({ type: 'session.update', session: sessionConfig });
    console.log(`[${reqId}] 📤 Session configured: engine=${session.voiceEngine}, voice=${session.voiceType}, tools=${tools.length}, t=${Date.now()-session.startTime}ms`);
    // Fire greeting IMMEDIATELY — Azure Realtime queues it behind session.update (~300ms faster than waiting for session.updated)
    triggerGreeting();
  }

  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Realtime session created`);
      session.realtimeReady = true;
      const isReconnect = session._agentConfigReady && session.transcript.length > 0;
      if (isReconnect) {
        const tools = buildToolDefinitions();
        const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const sc = { input_audio_format: 'pcm16', input_audio_transcription: { model: 'whisper-1' }, turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 } };
        if (session.voiceEngine === 'azure_speech') { sc.instructions = 'Transcription-only.'; sc.modalities = ['text']; sc.voice = 'alloy'; }
        else { sc.modalities = ['text', 'audio']; sc.instructions = `\n[LIVE CLOCK] ${nowIST}\n` + session.systemPrompt; sc.voice = session.voiceType; sc.output_audio_format = 'pcm16'; }
        if (tools.length > 0) { sc.tools = tools; sc.tool_choice = 'auto'; }
        sendToRealtime({ type: 'session.update', session: sc });
      } else if (session._agentConfigReady) {
        applySessionConfig();
      }
      // If config isn't ready yet — DO NOTHING. Wait for loadAgentConfig to finish and call applySessionConfig.
      // This eliminates the wasteful 2nd session.update round-trip (~500ms savings).
      return;
    }
    if (type === 'session.updated') { console.log(`[${reqId}] ✅ Realtime session updated`); return; }

    if (type === 'response.audio.delta' && msg.delta) {
      if (!session._firstAudioLogged) { session._firstAudioLogged = true; console.log(`[${reqId}] 🎵 First audio byte at t=${Date.now()-session.startTime}ms`); }
      // Stop filler the moment real LLM audio arrives
      stopFiller();
      session.isSpeaking = true;
      const mulawBytes = base64PCM16_24kToMulaw(msg.delta, session._resampleState);
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) { sendMulawToSmartflo(mulawBytes); }
      return;
    }
    if (type === 'response.audio.done') { session.isSpeaking = false; return; }
    if (type === 'conversation.item.input_audio_transcription.failed') { console.error(`[${reqId}] ❌ STT fail`); return; }
    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        const clean = text.toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g, '').trim();
        const wc = clean.split(/\s+/).filter(w => w).length;
        // Only filter single filler words — be very conservative to avoid losing real speech
        if (wc === 1 && /^(hmm+|uh+|um+|ah+|oh+|huh|tch|shh|ss+|mm+)$/i.test(clean)) { console.log(`[${reqId}] 🔇 Noise: "${text}"`); return; }
        console.log(`[${reqId}] 🗣️ Customer: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'Customer', text });
        if (session.voiceEngine === 'azure_speech') { generateGpt5NanoResponse(text); }
        // Personal screening: probe Telegram only when owner is reachable (DND off + connected).
        // When DND is on, the AI is in message-taking mode and there's no point pinging the owner.
        if (session._personalMode && session._personalClientId && session._ownerReachable && !session._midCallTgSent) {
          const custCount = session.transcript.filter(t => t.speaker === 'Customer').length;
          if (custCount >= 1) { session._midCallTgSent = true; sendMidCallTelegramUpdate(); }
        }
      }
      return;
    }
    if (type === 'response.audio_transcript.done' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) { console.log(`[${reqId}] 🤖 AI: "${text.substring(0, 100)}"`); session.transcript.push({ speaker: 'AI', text }); }
      return;
    }
    if (type === 'response.text.done' && session.voiceEngine === 'azure_speech') return;
    if (type === 'input_audio_buffer.speech_started') {
      // Stop filler if user starts speaking
      stopFiller();
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) { smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid })); }
      if (session._ttsAbort) { session._ttsAbort.abort(); session._ttsAbort = null; }
      session.isSpeaking = false; return;
    }
    if (type === 'input_audio_buffer.speech_stopped') return;
    if (type === 'response.function_call_arguments.done') { executeToolCall(msg.call_id, msg.name, msg.arguments || '{}'); return; }
    if (type === 'error') { console.error(`[${reqId}] ❌ Realtime error:`, JSON.stringify(msg.error || msg)); return; }
  }

  // ─── Mid-call Telegram ───
  async function sendMidCallTelegramUpdate() {
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!tgT || !session.callLogId) return;
    try {
      const svc = serviceClient;
      const cl = await svc.entities.Client.get(session._personalClientId);
      if (!cl?.telegram_connected || !cl?.telegram_chat_id || cl.dnd_enabled || cl.owner_notification_channel !== 'telegram') return;
      const convo = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
      let bUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
      const oI = bUrl.indexOf('/openai/'); if (oI > 0) bUrl = bUrl.substring(0, oI);
      const pI = bUrl.indexOf('/api/projects'); if (pI > 0) bUrl = bUrl.substring(0, pI);
      const dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT'), ak = Deno.env.get('AZURE_OPENAI_KEY');
      const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
        method: 'POST', headers: { 'api-key': ak, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: 'Classify this live call. Return JSON: {"reason":"label","emoji":"1 emoji","detail":"1 sentence","urgency":"low|medium|high|urgent","caller_name":"name if said"}' },
          { role: 'user', content: convo }
        ], max_completion_tokens: 100, response_format: { type: "json_object" } })
      });
      if (!res.ok) return;
      const d = await res.json(), r = JSON.parse(d.choices?.[0]?.message?.content || '{}');
      let midCallName = session._isTrustedCaller && session._trustedContactName ? session._trustedContactName : (r.caller_name || '');
      const callerLabel = midCallName || session.callerNumber || 'Unknown';
      const clId = session.callLogId;
      const m = `${r.emoji||'📞'} <b>Live Call — What should I do?</b>\n\n📱 From: <b>${callerLabel}</b>${midCallName && session.callerNumber ? '\n📞 '+session.callerNumber : ''}\n📋 <b>${r.reason||'Unknown'}</b>${r.detail?'\n💬 '+r.detail:''}\n\n👇 <b>Choose action:</b>`;
      const kb = { inline_keyboard: [[{ text: '📞 Transfer to Me', callback_data: `decision:${clId}:transfer` }, { text: '⏰ Call Back', callback_data: `decision:${clId}:callback` }], [{ text: '📝 Take Message', callback_data: `decision:${clId}:take_message` }, { text: '🚫 Block/End', callback_data: `decision:${clId}:block` }]] };
      fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: m, parse_mode: 'HTML', reply_markup: kb }) })
        .then(x => x.json()).then(x => { if (x.ok) { session._awaitingOwnerDecision = true; pollOwnerDecision(svc); } }).catch(() => {});
    } catch (e) { console.error(`[${reqId}] ⚠️ Mid-call TG: ${e.message}`); }
  }

  async function pollOwnerDecision(svc) {
    if (!session.callLogId || !session._personalClientId) return;
    if (session._pollingDecisions) return;  // dedupe — only one poller per call
    session._pollingDecisions = true;
    let polls = 0;
    const iv = setInterval(async () => {
      polls++;
      // Keep polling for entire call duration (~4 minutes at 2s interval = 120 polls)
      // so the owner can send MULTIPLE instructions during one call (e.g. first "ask them to wait",
      // then "tell them I'll call back at 5pm"). Don't stop after the first decision.
      if (polls > 120 || session._callEnded) { clearInterval(iv); session._pollingDecisions = false; return; }
      try {
        const decs = await svc.entities.CallDecision.filter({ call_log_id: session.callLogId, status: 'pending' });
        const readyDecs = decs.filter(d => d.custom_message !== '__AWAITING_TIME__' && d.custom_message !== '__AWAITING_MESSAGE__');
        for (const dec of readyDecs) {
          await svc.entities.CallDecision.update(dec.id, { status: 'delivered' });
          executeOwnerDecision(dec);
        }
      } catch (_) {}
    }, 2000);
  }

  function executeOwnerDecision(dec) {
    const ownerName = session._ownerName || 'Sir';
    let inst = '';
    if (dec.decision === 'transfer') {
      inst = session.humanTransferNumber
        ? `[OWNER INSTRUCTION] ${ownerName} ji ne call transfer karne bola hai. Caller ko boliye: "Sir, ${ownerName} ji aapka call transfer kar rahe hain." Phir transfer_to_human tool use karo.`
        : `[OWNER INSTRUCTION] ${ownerName} ji aapko jald call back karenge.`;
    } else if (dec.decision === 'callback') {
      const t = dec.callback_time || dec.custom_message || 'kuch der mein';
      inst = `[OWNER INSTRUCTION] ${ownerName} ji ne kaha ki wo ${t} mein call back karenge. Caller ko batao.`;
    } else if (dec.decision === 'take_message') {
      inst = `[OWNER INSTRUCTION] ${ownerName} ji busy hain. Caller ka message lo — naam, purpose, details.`;
    } else if (dec.decision === 'block') {
      inst = `[OWNER INSTRUCTION] Politely end: "${ownerName} ji abhi available nahi hain. Dhanyavaad. Namaste."`;
    } else if (dec.custom_message) {
      inst = `[OWNER INSTRUCTION] ${ownerName} ji ka message: "${dec.custom_message}". Relay naturally.`;
    }
    if (!inst) return;
    console.log(`[${reqId}] 📨 Owner instruction → AI: "${inst.substring(0, 150)}"`);
    if (session.voiceEngine === 'azure_speech') {
      // Stop any in-progress TTS, then generate response from new instruction
      if (session._ttsAbort) { session._ttsAbort.abort(); session._ttsAbort = null; }
      generateGpt5NanoResponse(inst);
    } else {
      // Cancel any in-progress response, then inject the new owner instruction and force a new response
      sendToRealtime({ type: 'response.cancel' });
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
      }
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: inst }] } });
      sendToRealtime({ type: 'response.create' });
    }
  }

  function triggerGreeting() {
    const isHybrid = session.voiceEngine === 'azure_speech';
    const greeting = session.greetingMessage || '';
    if (isHybrid) {
      if (greeting) { session.transcript.push({ speaker: 'AI', text: greeting }); session.chatHistory.push({ role: 'assistant', content: greeting }); synthesizeWithAzureSpeech(greeting); }
      else { generateGpt5NanoResponse('[SYSTEM: The call just connected. Greet the customer warmly.]'); }
    } else {
      // FAST PATH: use response.create with direct instructions override — skips conversation.item round-trip (~300ms faster)
      if (greeting) {
        session.transcript.push({ speaker: 'AI', text: greeting });
        sendToRealtime({ type: 'response.create', response: { modalities: ['text', 'audio'], instructions: `Say exactly this greeting now, do not add or change anything: "${greeting}"` } });
      } else {
        sendToRealtime({ type: 'response.create', response: { modalities: ['text', 'audio'], instructions: 'The call just connected. Greet the customer warmly in 1 sentence.' } });
      }
    }
  }

  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    }
  }

  function uint8ToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function sendMulawToSmartflo(mulawBytes) {
    const CHUNK_SIZE = 960;
    for (let i = 0; i < mulawBytes.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, mulawBytes.length);
      let chunk = mulawBytes.slice(i, end);
      if (chunk.length % 160 !== 0) {
        const paddedLen = Math.ceil(chunk.length / 160) * 160;
        const padded = new Uint8Array(paddedLen);
        padded.set(chunk);
        padded.fill(0x7F, chunk.length);  // 0x7F = mu-law silence (zero amplitude)
        chunk = padded;
      }
      smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
    }
  }

  async function synthesizeWithAzureSpeech(text) {
    const speechKey = Deno.env.get('AZURE_SPEECH_KEY'), speechRegion = Deno.env.get('AZURE_SPEECH_REGION');
    if (!speechKey || !speechRegion) return;
    const xmlLang = /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-IN';
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'><voice name='${session.voiceType}'>${escaped}</voice></speak>`;
    // Stop filler before real TTS plays
    stopFiller();
    const controller = new AbortController(); session._ttsAbort = controller; session.isSpeaking = true;
    try {
      const response = await fetch(`https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': speechKey, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'raw-8khz-8bit-mono-mulaw' }, body: ssml, signal: controller.signal
      });
      if (!response.ok) { session.isSpeaking = false; return; }
      const audioBuffer = new Uint8Array(await response.arrayBuffer());
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        for (let i = 0; i < audioBuffer.length; i += 1600) {
          if (controller.signal.aborted) break;
          let chunk = audioBuffer.slice(i, Math.min(i + 1600, audioBuffer.length));
          if (chunk.length % 160 !== 0) { const p = new Uint8Array(Math.ceil(chunk.length/160)*160); p.set(chunk); p.fill(0x7F,chunk.length); chunk = p; }
          smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
        }
      }
    } catch (err) { if (err.name !== 'AbortError') console.error(`[${reqId}] ❌ TTS failed: ${err.message}`); }
    finally { session.isSpeaking = false; session._ttsAbort = null; }
  }

  const cleanTextForTTS = t => t.replace(/\*\*([^*]+)\*\*/g,'$1').replace(/\*([^*]+)\*/g,'$1').replace(/#{1,6}\s*/g,'').replace(/```[\s\S]*?```/g,'').replace(/`([^`]+)`/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,'').replace(/\n{2,}/g,'. ').replace(/\n/g,' ').replace(/\s{2,}/g,' ').trim();

  async function generateGpt5NanoResponse(userText) {
    const nanoEndpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const nanoKey = Deno.env.get('AZURE_OPENAI_KEY');
    const nanoDeployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    if (!nanoEndpoint || !nanoKey || !nanoDeployment) return;
    session.chatHistory.push({ role: 'user', content: userText });
    try {
      let bUrl = nanoEndpoint; const oI = bUrl.indexOf('/openai/'); if (oI > 0) bUrl = bUrl.substring(0, oI); const pI = bUrl.indexOf('/api/projects'); if (pI > 0) bUrl = bUrl.substring(0, pI);
            const response = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
        method: 'POST', headers: { 'api-key': nanoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...session.chatHistory.slice(0, 1), { role: 'system', content: 'VOICE CALL RULES: Respond in Hindi (Devanagari). Short (1-2 sentences). No markdown/emojis. Plain text only.' }, ...session.chatHistory.slice(1)], max_completion_tokens: 150, stream: true })
      });
      if (!response.ok) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '', sentenceBuffer = '', sentencesSent = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
            if (!delta) continue;
            fullText += delta; sentenceBuffer += delta;
            const sm = sentenceBuffer.match(/^(.*?[.?!।\n])\s*(.*)/s);
            if (sm) {
              const sentence = cleanTextForTTS(sm[1]); sentenceBuffer = sm[2] || '';
              if (sentence && sentence.length > 3) { sentencesSent++; synthesizeWithAzureSpeech(sentence); }
            }
          } catch (_) {}
        }
      }
      const remaining = cleanTextForTTS(sentenceBuffer);
      if (remaining && remaining.length > 3) synthesizeWithAzureSpeech(remaining);
      const cleanFull = cleanTextForTTS(fullText);
      session.chatHistory.push({ role: 'assistant', content: fullText });
      session.transcript.push({ speaker: 'AI', text: cleanFull });
    } catch (err) { console.error(`[${reqId}] ❌ LLM failed: ${err.message}`); }
  }

  // ─── Load agent config (optimized for <2s startup) ───
  async function loadAgentConfig() {
    const t0 = Date.now();
    try {
      const svc = serviceClient;
      let callLog = null;
      const cutoff = new Date(Date.now() - 120000).toISOString();

      // FAST PATH 1: call_sid match (outbound calls — cache is pre-built by initiateCall)
      if (session.callSid) {
        try {
          const logs = await svc.entities.CallLog.filter({ call_sid: session.callSid });
          if (logs.length > 0) { callLog = logs[0]; console.log(`[${reqId}] ⚡ call_sid match in ${Date.now()-t0}ms: ${callLog.id}`); }
        } catch (_) {}
        // Digits-only fallback for Smartflo-generated IDs
        if (!callLog) {
          const digitsOnly = session.callSid.replace(/\D/g, '');
          if (digitsOnly && digitsOnly.length > 5 && digitsOnly !== session.callSid) {
            try { const logs = await svc.entities.CallLog.filter({ call_sid: digitsOnly }); if (logs.length > 0) { callLog = logs[0]; console.log(`[${reqId}] ⚡ digits call_sid match: ${callLog.id}`); } } catch (_) {}
          }
        }
      }

      // FAST PATH 2: Recent unclaimed OUTBOUND call matched STRICTLY by phone.
      // CRITICAL: Must require BOTH callee & caller(DID) to match — a single-key match or any "latest unclaimed"
      // will hijack another client's outbound call config on inbound calls.
      if (!callLog) {
        const cleanCallee = session.calleeNumber ? session.calleeNumber.replace(/[^0-9]/g, '').slice(-10) : '';
        const cleanCaller = session.callerNumber ? session.callerNumber.replace(/[^0-9]/g, '').slice(-10) : '';
        if (cleanCallee && cleanCaller) {
          try {
            const [ringing, initiated] = await Promise.all([
              svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 10).catch(() => []),
              svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 10).catch(() => [])
            ]);
            const pickMatch = (list) => {
              const unclaimed = (Array.isArray(list) ? list : []).filter(l => !l.stream_sid && l.created_date >= cutoff && l.direction === 'outbound');
              // STRICT: require BOTH callee + caller (DID) to match this specific outbound call
              return unclaimed.find(l =>
                (l.callee_number||'').replace(/\D/g,'').slice(-10) === cleanCallee &&
                (l.caller_id||'').replace(/\D/g,'').slice(-10) === cleanCaller
              ) || null;
            };
            callLog = pickMatch(ringing) || pickMatch(initiated);
            if (callLog) console.log(`[${reqId}] ⚡ Strict outbound match in ${Date.now()-t0}ms: ${callLog.id}`);
          } catch (_) {}
        }
      }

      // INBOUND PATH: DID→Agent (only when no CallLog found — truly inbound call)
      if (!callLog && (session.calleeNumber || session.callerNumber)) {
        const cleanCalleeDID = (session.calleeNumber || '').replace(/[^0-9]/g, '').slice(-10);
        const callerDID = (session.callerNumber || '').replace(/[^0-9]/g, '').slice(-10);
        if (cleanCalleeDID) {
          const allDIDs = await svc.entities.DID.list('-created_date', 200);
          const matchedDID = (Array.isArray(allDIDs)?allDIDs:[]).find(d => { const n=(d.number||'').replace(/\D/g,'').slice(-10); return n===cleanCalleeDID||n===callerDID; });
          let didAgent = null, didClient = null;
          if (matchedDID?.agent_id || matchedDID?.client_id) {
            const [_a, _c] = await Promise.all([matchedDID.agent_id ? svc.entities.Agent.get(matchedDID.agent_id).catch(()=>null) : null, matchedDID.client_id ? svc.entities.Client.get(matchedDID.client_id).catch(()=>null) : null]);
            didAgent = _a; didClient = _c;
          }
          if (!didAgent) {
            const allAgents = await svc.entities.Agent.list('-created_date', 100);
            didAgent = (Array.isArray(allAgents)?allAgents:[]).find(a => { const dids = a.assigned_dids||(a.assigned_did?[a.assigned_did]:[]); return dids.some(d=>(d||'').replace(/\D/g,'').slice(-10)===cleanCalleeDID||(d||'').replace(/\D/g,'').slice(-10)===callerDID); });
            if (didAgent && !didClient && didAgent.client_id) { try { didClient = await svc.entities.Client.get(didAgent.client_id); } catch(_){} }
          }
          if (didAgent) {
            // Fix Smartflo swap
            const agentDids = (didAgent.assigned_dids||[]).concat(didAgent.assigned_did?[didAgent.assigned_did]:[]);
            if (agentDids.some(d=>(d||'').replace(/\D/g,'').slice(-10)===callerDID) && session.callerNumber && session.calleeNumber) {
              const tmp=session.callerNumber; session.callerNumber=session.calleeNumber; session.calleeNumber=tmp;
            }
            session.clientId = didClient?.id || didAgent.client_id;

            // ── Trial gate (inbound): block if trial expired or call cap reached ──
            if (didClient && (didClient.account_status === 'trial' || didClient.account_status === 'expired')) {
              const _now = new Date();
              const _tEnd = didClient.trial_end_date ? new Date(didClient.trial_end_date) : null;
              const _uUntil = didClient.trial_topup_unlimited_until ? new Date(didClient.trial_topup_unlimited_until) : null;
              const _isUnlimited = _uUntil && _uUntil > _now;
              const _callsUsed = Number(didClient.trial_calls_used || 0);
              const _callLimit = Number(didClient.trial_call_limit ?? 10);
              const _expired = didClient.account_status === 'expired' || (_tEnd && _tEnd <= _now && !_isUnlimited);
              const _capHit = !_isUnlimited && _callsUsed >= _callLimit;
              if (_expired || _capHit) {
                console.log(`[${reqId}] 🚫 Trial gate blocked inbound call: ${_expired ? 'trial_expired' : 'cap_reached'} (client=${didClient.id})`);
                try { smartfloSocket.close(); } catch (_) {}
                session._callEnded = true;
                return;
              }
              // Increment counter for inbound trial call
              if (!_isUnlimited) {
                svc.entities.Client.update(didClient.id, { trial_calls_used: _callsUsed + 1 }).catch(() => {});
              }
            }

            // Apply voice/engine/transfer config IMMEDIATELY (sync work, no DB)
            if (didAgent.greeting_message) session.greetingMessage = didAgent.greeting_message;
            if (didAgent.human_transfer_number) session.humanTransferNumber = didAgent.human_transfer_number;
            else if (didClient?.account_type === 'personal' && didClient?.phone) session.humanTransferNumber = didClient.phone;
            if (didAgent.enable_auto_transfer === false) session.enableAutoTransfer = false;
            if (didAgent.persona) {
              if (didAgent.persona.voice_engine) session.voiceEngine = didAgent.persona.voice_engine;
              if (didAgent.persona.voice_type) {
                if (session.voiceEngine === 'azure_speech') {
                  session.voiceType = didAgent.persona.voice_type;
                } else {
                  const validVoices = ['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'];
                  const dm = { 'nova':'shimmer','onyx':'ash','fable':'ballad','aoede':'shimmer','puck':'verse','charon':'ash','kore':'coral','fenrir':'cedar' };
                  let v = didAgent.persona.voice_type.toLowerCase(); if (dm[v]) v = dm[v]; if (validVoices.includes(v)) session.voiceType = v;
                }
              }
            }

            // PARALLELIZE all inbound DB work: KB, Lead match, Shopify, TrustedContact, OwnerStatus
            const kbIds = didAgent.knowledge_base_ids || [];
            const cleanCaller = session.callerNumber ? session.callerNumber.replace(/\D/g,'').slice(-10) : '';
            const isPersonal = didClient?.account_type === 'personal';

            const [kbDocs, leads, shopifyInt, trustedContacts, ownerStatuses] = await Promise.all([
              kbIds.length > 0 ? Promise.all(kbIds.map(id => svc.entities.KnowledgeBase.get(id).catch(()=>null))) : Promise.resolve([]),
              cleanCaller && didClient ? svc.entities.Lead.filter({ client_id: didClient.id }).catch(()=>[]) : Promise.resolve([]),
              session.clientId ? svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, platform: 'shopify', status: 'active' }).catch(()=>[]) : Promise.resolve([]),
              (isPersonal && cleanCaller) ? svc.entities.TrustedContact.filter({ client_id: didClient.id }).catch(()=>[]) : Promise.resolve([]),
              isPersonal ? svc.entities.OwnerStatus.filter({ client_id: didClient.id, is_active: true }).catch(()=>[]) : Promise.resolve([])
            ]);

            // Assemble KB content
            let kbContent = '';
            (Array.isArray(kbDocs)?kbDocs:[]).filter(Boolean).forEach(d => { if (d.content) kbContent += `[${d.title}]\n${d.content}\n\n---\n\n`; });

            // Match lead by phone
            let callerContext = '';
            if (cleanCaller && Array.isArray(leads)) {
              const ml = leads.find(l=>l.phone&&l.phone.replace(/\D/g,'').slice(-10)===cleanCaller);
              if (ml) {
                session._inboundLeadId = ml.id;
                session._leadId = ml.id;  // enable get_call_history tool
                callerContext = `\n\n--- INBOUND - RETURNING LEAD ---\n- Name: ${ml.name||'Unknown'}\n- Status: ${ml.status||'new'}\n- Score: ${ml.score||0}/100\nCRITICAL: Address by name "${ml.name||'Sir/Madam'}". If customer references past chats, call get_call_history tool.`;
              }
            }
            // Enable lazy KB loading + tool flags for inbound
            if (didAgent.kb_file_uri) session._kbFileUri = didAgent.kb_file_uri;
            session._toolFlags = {
              has_kb: !!(session._kbFileUri || (didAgent.knowledge_base_ids && didAgent.knowledge_base_ids.length > 0)),
              has_shopify: false,  // set later based on shopifyInt
              has_unicommerce: false,
              has_call_history: !!session._leadId,
              has_transfer: !!(didAgent.human_transfer_number || (didClient?.account_type === 'personal' && didClient?.phone)),
              has_end_call: true
            };

            // Build system prompt
            session.systemPrompt = (didAgent.system_prompt || 'You are a helpful AI voice assistant.') + callerContext + (kbContent ? `\n\nKNOWLEDGE BASE:\n${kbContent}` : '');

            // Shopify (prose kept short — tool description carries the details)
            if (Array.isArray(shopifyInt) && shopifyInt.length > 0) {
              session.hasShopify = true;
              session._toolFlags.has_shopify = true;
              session.systemPrompt += '\n\n[SHOPIFY ACTIVE] Use shopify_lookup tool for real-time data. Never invent statuses.';
            }

            // Personal account mode
            if (isPersonal) {
              const aiMode = didClient.ai_response_mode || 'screen_all';
              const dndEnabled = didClient.dnd_enabled || false;
              let isTrusted = false, trustedName = '';
              if (cleanCaller && Array.isArray(trustedContacts)) {
                const m = trustedContacts.find(tc=>tc.phone&&tc.phone.replace(/\D/g,'').slice(-10)===cleanCaller);
                if (m) { isTrusted = true; trustedName = m.name || ''; }
              }
              // Owner is reachable on Telegram only if connected AND DND is OFF.
              // When unreachable, AI must take a message and end — never tell caller to hold.
              const ownerReachable = !!(
                didClient.telegram_connected &&
                didClient.telegram_chat_id &&
                didClient.owner_notification_channel === 'telegram' &&
                !dndEnabled
              );
              session._ownerReachable = ownerReachable;
              const ownerLabel = didClient.company_name || 'Sir';
              let pi = '\n\n--- PERSONAL AI ASSISTANT MODE ---';
              if (aiMode==='block_all') pi+='\nMODE: BLOCK ALL.';
              else if (aiMode==='take_messages') pi+='\nMODE: TAKE MESSAGES.';
              else if (isTrusted) pi+=`\nMODE: SCREEN ALL. "${trustedName}" is TRUSTED.`;
              else pi+='\nMODE: SCREEN ALL. Classify as family/business/promotional/spam.';
              if (dndEnabled) pi+='\nDND IS ON.';

              // Screening script — branches on whether the owner is reachable for live confirmation
              if (!isTrusted && aiMode !== 'block_all') {
                if (ownerReachable) {
                  pi += `\n\n--- MANDATORY SCREENING SCRIPT (FOLLOW IN ORDER) ---
You are ${ownerLabel} ji's personal AI assistant. NEVER pretend to be ${ownerLabel} ji.

GENDER: You are FEMALE. Use feminine Hindi verb forms for yourself: "kar rahi hoon", "bol rahi hoon", "aati hoon", "jaati hoon". NEVER use masculine forms (raha/aata/jaata) for yourself.

STEP 1 — GREET (opening): "Namaste! Main ${ownerLabel} ji ki personal AI assistant hoon. ${ownerLabel} ji abhi available nahi hain — main aapki call screen kar rahi hoon."
STEP 2 — ASK NAME: "Aap apna naam bata sakte hain please?" Wait for answer.
STEP 3 — ASK PURPOSE: "<Name> ji, aap kis silsile mein call kar rahe hain?" Wait for answer.
STEP 4 — PARK ON HOLD (after BOTH name + reason): "Theek hai <Name> ji, ek minute line par rahiye — main ${ownerLabel} ji se confirm karke abhi aati hoon. Kripya hold kariye." Then STOP TALKING.
STEP 5 — SILENT WAIT: Stay silent until you receive an [OWNER INSTRUCTION] system message. If caller speaks, briefly say "Bas ek minute aur, ${ownerLabel} ji se confirm ho raha hai" and go silent again.

CRITICAL: Do NOT promise transfers/callbacks until you get [OWNER INSTRUCTION]. Do NOT skip steps. Always: greet → name → reason → hold → wait.`;
                } else {
                  pi += `\n\n--- MESSAGE-TAKING SCRIPT (OWNER UNREACHABLE — DND OR NOT CONNECTED) ---
You are ${ownerLabel} ji's personal AI assistant. ${ownerLabel} ji is currently NOT reachable for live confirmation. Take a message and end the call.

GENDER: You are FEMALE. Use feminine Hindi forms (rahi hoon, aati hoon, leti hoon).

STEP 1 — GREET: "Namaste! Main ${ownerLabel} ji ki personal AI assistant hoon. ${ownerLabel} ji abhi available nahi hain. Main aapka message le sakti hoon."
STEP 2 — ASK NAME: "Aap apna naam bata sakte hain please?"
STEP 3 — ASK MESSAGE: "<Name> ji, aap apna message bata dijiye — main ${ownerLabel} ji ko de dungi. Wo free hote hi aapko call back karenge."
STEP 4 — CONFIRM & END: "Theek hai <Name> ji, maine note kar liya hai. Dhanyavaad, namaste." Then call end_call tool with reason="message_taken".

ABSOLUTE RULES:
- NEVER say "main confirm karke aati hoon", "ek minute hold kariye", "${ownerLabel} ji se baat kar rahi hoon" — no live confirmation possible.
- NEVER fabricate that ${ownerLabel} ji is "in a meeting" / "driving" / "busy" — you do NOT know.
- Keep call SHORT (under 60 seconds). Take message → confirm → end.`;
                }
              }
              // Trusted family/friend caller — also branch on reachability
              if (isTrusted && trustedName && !ownerReachable) {
                pi += `\n\n--- TRUSTED CALLER + OWNER UNREACHABLE ---
${trustedName} is a trusted contact, but ${ownerLabel} ji is NOT reachable for live confirmation right now.
Greet them warmly by name, take their message, confirm, and end the call. NEVER say you'll confirm with ${ownerLabel} ji or put them on hold — owner cannot respond.
Use feminine Hindi forms. Keep it warm, short, and end with end_call tool.`;
              }
              if (Array.isArray(ownerStatuses) && ownerStatuses.length > 0) {
                pi += `\n\n--- OWNER STATUS: ${ownerStatuses[0].icon} ${ownerStatuses[0].title} ---\nTell callers: "${ownerStatuses[0].caller_message_hindi}"`;
              }
              session.systemPrompt += pi;
              session._personalMode = aiMode; session._isTrustedCaller = isTrusted; session._trustedContactName = trustedName; session._personalClientId = didClient.id; session._ownerName = didClient.company_name || '';

              // Fire-and-forget Telegram notification (only when owner is reachable)
              if (ownerReachable) {
                const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
                if (tgToken) { const nd = trustedName || session.callerNumber || 'Unknown'; fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: didClient.telegram_chat_id, text: `📞 <b>Incoming Call</b>\n\n📱 From: <b>${nd}</b>\n\n💬 AI is screening...`, parse_mode: 'HTML' }) }).catch(()=>{}); }
              }
            }

            // NOTE: Inbound calls are NEVER screening calls.
            // Screening calls are ALWAYS outbound and pre-configured by initiateScreeningCall
            // with a valid ScreeningCall record and screening_call_id. Flagging inbound calls
            // as screening based on keyword matching ("screening"/"interview" in prompt) creates
            // garbage ScreeningCall/ServiceProvider records with empty template_id.

            // Fire-and-forget CallLog create (don't block greeting on DB write)
            svc.entities.CallLog.create({ client_id: session.clientId, agent_id: didAgent.id, lead_id: session._inboundLeadId || null, call_sid: session.callSid || `inbound_${Date.now()}`, stream_sid: session.streamSid || null, caller_id: session.callerNumber || '', callee_number: session.calleeNumber, direction: 'inbound', status: 'answered', call_start_time: new Date().toISOString(), agent_config_cache: { agent_name: didAgent.name, system_prompt: session.systemPrompt, persona: didAgent.persona || {}, knowledge_base_content: kbContent.substring(0, 2000), greeting_message: didAgent.greeting_message || '', human_transfer_number: didAgent.human_transfer_number || '', enable_auto_transfer: didAgent.enable_auto_transfer !== false } })
              .then(newLog => { session.callLogId = newLog.id; })
              .catch(e => console.error(`[${reqId}] ⚠️ CallLog create failed: ${e.message}`));

            console.log(`[${reqId}] ✅ INBOUND ready in ${Date.now()-t0}ms: Agent="${didAgent.name}", voice=${session.voiceType}`);
            return;
          }
        }
      }

      if (!callLog) { console.log(`[${reqId}] ⚠️ No call log found in ${Date.now()-t0}ms — default prompt`); return; }

      // Apply config from pre-cached CallLog (fast path for outbound calls)
      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      if (callLog.call_sid && callLog.call_sid !== session.callSid) session.smartfloCallId = callLog.call_sid;
      const cache = callLog.agent_config_cache || {};

      // ═══ NEW SLIM CACHE PATH ═══
      if (cache.core_prompt) {
        session.systemPrompt = cache.core_prompt;
        session._kbFileUri = cache.kb_file_uri || '';
        session._leadId = cache.lead_id || callLog.lead_id || null;
        session._toolFlags = cache.tool_flags || {};
        session.hasShopify = !!cache.tool_flags?.has_shopify;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        console.log(`[${reqId}] ✅ SLIM cache: prompt=${session.systemPrompt.length}ch, kb_uri=${session._kbFileUri ? 'yes' : 'no'}, lead=${session._leadId ? 'yes' : 'no'}`);
      }
      // ═══ LEGACY CACHE PATH (backward compat) ═══
      else if (cache.system_prompt) {
        session.systemPrompt = cache.system_prompt;
        if (cache.knowledge_base_content && !session.systemPrompt.includes(cache.knowledge_base_content.substring(0, 50))) {
          session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${cache.knowledge_base_content}`;
        }
        session._leadId = callLog.lead_id || null;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (session.systemPrompt.includes('SHOPIFY')) session.hasShopify = true;
      }

      // Voice mapping
      if (cache?.persona) {
        if (cache.persona.voice_engine) session.voiceEngine = cache.persona.voice_engine;
        if (cache.persona.voice_type) {
          if (session.voiceEngine === 'azure_speech') {
            session.voiceType = cache.persona.voice_type;
          } else {
            const validVoices = ['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'];
            const dm = { 'nova':'shimmer','onyx':'ash','fable':'ballad','aoede':'shimmer','puck':'verse','charon':'ash','kore':'coral','fenrir':'cedar' };
            let v = cache.persona.voice_type.toLowerCase(); if (dm[v]) v = dm[v]; if (validVoices.includes(v)) session.voiceType = v;
          }
        }
      }
      console.log(`[${reqId}] ✅ Config ready in ${Date.now()-t0}ms: engine=${session.voiceEngine}, voice=${session.voiceType}`);

      // Claim CallLog (fire-and-forget — don't block greeting)
      const uf = {};
      if (session.streamSid) uf.stream_sid = session.streamSid;
      if (session.callSid && callLog.call_sid !== session.callSid) uf.call_sid = session.callSid;
      if (Object.keys(uf).length > 0) svc.entities.CallLog.update(callLog.id, uf).catch(() => {});
    } catch (e) { console.error(`[${reqId}] ❌ Agent config failed: ${e.message}`); }
  }

  // ─── Pre-warm Realtime connection ───
  connectRealtime();

  // ─── Smartflo WebSocket Handlers ───
  smartfloSocket.onopen = () => { console.log(`[${reqId}] 🟢 Smartflo socket opened`); };

  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.event === 'connected') { console.log(`[${reqId}] ✅ Smartflo connected`); return; }
      if (msg.event === 'start') {
        const sd = msg.start || {};
        session.streamSid = sd.streamSid;
        session.callSid = sd.callSid;
        // Smartflo semantics:
        //  - sd.to / sd.customParameters.called_number = DID (your number) — this is the CALLEE for inbound
        //  - sd.from = the caller (customer's number) for inbound
        //  - sd.customParameters.customer_number = the customer (could be caller OR callee depending on direction)
        // Resolve both sides from most-reliable Smartflo fields
        const rawFrom = sd.from || sd.customParameters?.caller_number || sd.customParameters?.from || '';
        const rawTo = sd.to || sd.customParameters?.called_number || sd.customParameters?.did || '';
        const customerNum = sd.customParameters?.customer_number || '';
        // Default: from→caller, to→callee (standard telephony)
        session.callerNumber = rawFrom || customerNum || '';
        session.calleeNumber = rawTo || '';
        // Log raw Smartflo start payload for debugging caller/callee issues
        console.log(`[${reqId}] 📞 START raw: from=${rawFrom}, to=${rawTo}, customer_number=${customerNum}, stream=${session.streamSid}`);
        console.log(`[${reqId}] 📞 START resolved: callee(DID)=${session.calleeNumber}, caller(customer)=${session.callerNumber}`);
        // 🚀 FIRE FILLER AUDIO IMMEDIATELY (don't await) — hides cold-start latency
        playFillerAudio();
        loadAgentConfig().then(() => {
          session._agentConfigReady = true;
          console.log(`[${reqId}] 🚀 Agent config ready: voice=${session.voiceType}`);
          if (session.realtimeReady) applySessionConfig();
        });
        return;
      }
      // Audio from Smartflo → convert mu-law 8kHz → PCM16 24kHz → Realtime API
      if (msg.event === 'media' && msg.media?.payload) {
        if (!session.realtimeReady) return;
        const raw = atob(msg.media.payload);
        const mulawBytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) mulawBytes[i] = raw.charCodeAt(i);
        const pcm24kB64 = mulawToBase64PCM16_24k(mulawBytes, session._resampleState);
        sendToRealtime({ type: 'input_audio_buffer.append', audio: pcm24kB64 });
        return;
      }
      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Smartflo stop`);
        session._callEnded = true;
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
        await saveCallRecord(session, reqId, duration, serviceClient);
        return;
      }
    } catch (err) { console.error(`[${reqId}] ❌ Smartflo msg error: ${err.message}`); }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Smartflo closed, ${duration}s`);
    if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
    if (session.callLogId) await saveCallRecord(session, reqId, duration, serviceClient);
  };

  smartfloSocket.onerror = () => {
    console.error(`[${reqId}] ❌ Smartflo error`);
    if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
  };

  return response;

};