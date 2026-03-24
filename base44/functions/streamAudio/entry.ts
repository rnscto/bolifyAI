import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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

// ─── Persistent state for cross-chunk continuity (avoids clicks at boundaries) ───
let _lastUpsampleValue = 0;  // Last sample from previous upsampling chunk
let _lastDownsampleRemainder = []; // Leftover samples from previous downsampling chunk

// Convert mu-law 8kHz → PCM16 24kHz LE base64 (upsample 3x for Realtime API)
function mulawToBase64PCM16_24k(mulawBytes) {
  // Decode mu-law to PCM16 at 8kHz
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm8k[i] = decodeMulaw(mulawBytes[i]);
  }

  // Upsample 8kHz → 24kHz using cubic-style interpolation with cross-chunk continuity
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = i === 0 ? _lastUpsampleValue : pcm8k[i - 1];
    const s1 = pcm8k[i];
    const s2 = i < pcm8k.length - 1 ? pcm8k[i + 1] : s1;

    // 3-point interpolation: smoother than linear, avoids metallic artifacts
    pcm24k[i * 3] = s1;
    pcm24k[i * 3 + 1] = Math.round(s1 + (s2 - s0) / 6);
    pcm24k[i * 3 + 2] = Math.round(s1 + (s2 - s0) / 3);
  }
  if (pcm8k.length > 0) {
    _lastUpsampleValue = pcm8k[pcm8k.length - 1];
  }

  // Convert to base64 (little-endian bytes)
  const buffer = new Uint8Array(pcm24k.length * 2);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < pcm24k.length; i++) {
    view.setInt16(i * 2, pcm24k[i], true);
  }
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary);
}

// Convert PCM16 24kHz LE base64 (from Realtime API) → mu-law 8kHz bytes (downsample 3x)
// Uses a 3-tap averaging low-pass filter before decimation to prevent aliasing
function base64PCM16_24kToMulaw(base64Pcm16) {
  const raw = atob(base64Pcm16);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }

  // Read PCM16 LE samples safely using DataView
  const numSamples = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Prepend leftover samples from previous chunk for continuity
  const allSamples = new Int16Array(_lastDownsampleRemainder.length + numSamples);
  for (let i = 0; i < _lastDownsampleRemainder.length; i++) {
    allSamples[i] = _lastDownsampleRemainder[i];
  }
  for (let i = 0; i < numSamples; i++) {
    allSamples[_lastDownsampleRemainder.length + i] = view.getInt16(i * 2, true);
  }

  const totalSamples = allSamples.length;
  // How many complete groups of 3 we can process
  const downsampledLen = Math.floor(totalSamples / 3);
  const mulaw = new Uint8Array(downsampledLen);

  for (let i = 0; i < downsampledLen; i++) {
    const idx = i * 3;
    // 3-tap averaging filter: (s[n-1] + 2*s[n] + s[n+1]) / 4
    const prev = idx > 0 ? allSamples[idx - 1] : allSamples[idx];
    const curr = allSamples[idx];
    const next = idx + 1 < totalSamples ? allSamples[idx + 1] : curr;
    const filtered = Math.round((prev + 2 * curr + next) / 4);
    // Clamp to Int16 range
    const clamped = Math.max(-32768, Math.min(32767, filtered));
    mulaw[i] = encodeMulaw(clamped);
  }

  // Save leftover samples for next chunk
  const consumed = downsampledLen * 3;
  _lastDownsampleRemainder = [];
  for (let i = consumed; i < totalSamples; i++) {
    _lastDownsampleRemainder.push(allSamples[i]);
  }

  return mulaw;
}

// ─── Save call record (reused from original) ───

async function saveCallRecord(session, reqId, duration) {
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

    const { createClient } = await import('npm:@base44/sdk@0.8.20');
    const appId = Deno.env.get('BASE44_APP_ID');
    const serviceClient = createClient({ appId, asServiceRole: true });

    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

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
        const analysisRes = await fetch(
          `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`,
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
    // If transcript has fewer than 3 customer lines and call was under 30s,
    // override aggressive statuses that are likely STT misinterpretation
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

    if (wasAlreadyCompleted) {
      await serviceClient.entities.CallLog.update(session.callLogId, {
        transcript: transcript || '',
        duration: duration,
        lead_status_updated: leadStatus,
        ...(enrichedSummary ? { conversation_summary: enrichedSummary } : {})
      });
      console.log(`[${reqId}] 💾 Call already ${currentLog.status}, added transcript+analysis: ${session.callLogId}`);
    } else {
      await serviceClient.entities.CallLog.update(session.callLogId, {
        status: 'completed',
        transcript: transcript || '',
        duration: duration,
        call_end_time: new Date().toISOString(),
        lead_status_updated: leadStatus,
        ...(enrichedSummary ? { conversation_summary: enrichedSummary } : {})
      });
      console.log(`[${reqId}] 💾 Call saved as completed with analysis: ${session.callLogId}, score=${leadScore}`);
    }

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

    // NOTE: Auto-enroll in email sequence is handled EXCLUSIVELY by campaignPostCall.
    // streamAudio only owns: CallLog (transcript/summary/AI) + Lead (scoring/status).

    // ===== STEP 6: Trigger post-call action extraction (fire-and-forget) =====
    if (transcript.length > 50) {
      serviceClient.functions.invoke('postCallActionExtractor', {
        call_log_id: session.callLogId
      }).then(() => console.log(`[${reqId}] 📋 Action extraction triggered`))
        .catch(e => console.error(`[${reqId}] ⚠️ Action extraction failed: ${e.message}`));
    }

    // NOTE: CampaignLead updates and next-batch triggering are handled EXCLUSIVELY
    // by the campaignPostCall entity automation (triggers on CallLog update).
    // streamAudio only owns: CallLog transcript/summary/AI-analysis + Lead scoring.
    // This avoids race conditions where both streamAudio and campaignPostCall
    // were updating the same CampaignLead record simultaneously.

    try { serviceClient.cleanup(); } catch (_) { /* ignore */ }
  } catch (err) {
    console.error(`[${reqId}] ❌ Save failed:`, err.message);
  }
}

// ─── Main Handler ───

Deno.serve(async (req) => {
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
  const base44 = createClientFromRequest(base44Req);

  // Non-WebSocket: return status
  if (!isWebSocket) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    const protocol = req.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
    return new Response(JSON.stringify({
      status: 'ready',
      version: 'v7.0-hybrid-gpt5nano',
      wss_url: `${protocol}://${host}/functions/streamAudio`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

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
    clientId: null,           // Client ID for marketplace lookups
    transcript: [],
    startTime: Date.now(),
    systemPrompt: 'You are a friendly AI voice assistant. Be professional and concise. Keep responses to 1-3 sentences.',
    greetingMessage: '',      // Custom greeting spoken first when call connects
    voiceEngine: 'realtime',  // 'realtime' or 'azure_speech'
    voiceType: 'alloy',       // Default voice, overridden from agent config
    _saved: false,
    realtimeWs: null,         // WebSocket connection to Azure Realtime API
    realtimeReady: false,     // Whether session.created has been received
    isSpeaking: false,        // Track if model is currently outputting audio
    _ttsAbort: null,          // AbortController for Azure Speech TTS (hybrid mode)
    chatHistory: [],          // GPT-5-nano conversation history (azure_speech mode)
    tools: [],                // Registered tools (e.g. shopify_order_lookup)
    hasShopify: false,        // Whether Shopify marketplace is connected
    humanTransferNumber: '',  // Intercom/extension for human transfer
    enableAutoTransfer: true, // Whether AI can auto-offer transfers
    _realtimeReconnectAttempts: 0, // Track reconnection attempts
    _callEnded: false         // Whether the call has ended (prevent reconnect after hangup)
  };

  // ─── Connect to Azure Realtime API ───
  function connectRealtime() {
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_KEY');

    if (!realtimeUrl || !realtimeKey) {
      console.error(`[${reqId}] ❌ Missing AZURE_REALTIME_ENDPOINT or AZURE_REALTIME_KEY`);
      return;
    }

    // Convert https:// to wss:// for WebSocket
    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    // Ensure the URL includes the /openai/realtime path and required query params
    // If the endpoint is just a base URI (no /openai/realtime), append deployment path
    if (!wsUrl.includes('/openai/realtime')) {
      wsUrl = wsUrl.replace(/\/+$/, '') + '/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-1.5';
    }
    // Ensure api-version uses preview (required for WebSocket realtime on Azure)
    wsUrl = wsUrl.replace('api-version=2025-04-01&', 'api-version=2025-04-01-preview&');
    // Append api-key to URL since Deno WebSocket doesn't support custom headers
    const separator = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${separator}api-key=${encodeURIComponent(realtimeKey)}`;
    console.log(`[${reqId}] 🔌 Connecting to Azure Realtime: ${wsUrl.substring(0, 80)}...`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${reqId}] ✅ Azure Realtime WebSocket connected (attempt ${session._realtimeReconnectAttempts})`);
      // Reset reconnect counter on successful connection
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
      console.log(`[${reqId}] 🔴 Azure Realtime closed: code=${event.code} reason=${event.reason}`);
      session.realtimeReady = false;

      // Auto-reconnect if call is still active and we haven't exhausted retries
      const MAX_RECONNECT = 3;
      if (!session._callEnded && session._realtimeReconnectAttempts < MAX_RECONNECT) {
        session._realtimeReconnectAttempts++;
        const delay = session._realtimeReconnectAttempts * 1000; // 1s, 2s, 3s backoff
        console.log(`[${reqId}] 🔄 Reconnecting Azure Realtime (attempt ${session._realtimeReconnectAttempts}/${MAX_RECONNECT}) in ${delay}ms...`);
        setTimeout(() => {
          if (!session._callEnded) {
            connectRealtime();
          }
        }, delay);
      } else if (!session._callEnded) {
        console.error(`[${reqId}] ❌ Azure Realtime reconnect exhausted (${MAX_RECONNECT} attempts). Call voice is dead.`);
      }
    };

    ws.onerror = (event) => {
      console.error(`[${reqId}] ❌ Azure Realtime error`);
    };

    session.realtimeWs = ws;
  }

  // ─── Build marketplace tool definitions ───
  function buildToolDefinitions() {
    const tools = [];

    // Transfer to human agent tool — always available if transfer number is configured
    if (session.humanTransferNumber) {
      tools.push({
        type: 'function',
        name: 'transfer_to_human',
        description: 'Transfer the call to a human agent. Use this when: (1) Customer explicitly asks to speak to a real person/human/manager, (2) Customer is very frustrated and you cannot resolve their issue, (3) The query is beyond your knowledge and requires human expertise. IMPORTANT: Before transferring, always confirm with the customer: "Let me transfer you to a human agent. Please hold." Never transfer without informing the customer.',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Brief reason for the transfer (e.g. "customer requested human agent", "complex billing issue", "frustrated customer")'
            }
          },
          required: ['reason']
        }
      });
      console.log(`[${reqId}] 📞 Transfer-to-human tool registered (intercom: ${session.humanTransferNumber})`);
    }

    if (session.hasShopify) {
      tools.push({
        type: 'function',
        name: 'shopify_lookup',
        description: 'Look up information from the customer\'s Shopify store. Use this when the customer asks about their order status, tracking, products, or refunds.',
        parameters: {
          type: 'object',
          properties: {
            lookup_type: {
              type: 'string',
              enum: ['order_by_number', 'order_by_phone', 'order_by_email', 'product_search', 'refund_status', 'tracking'],
              description: 'Type of lookup. Use order_by_number for order #, order_by_phone for phone-based search, order_by_email for email-based search, product_search for product availability, refund_status for refund info (needs order ID), tracking for shipment tracking (needs order ID).'
            },
            query: {
              type: 'string',
              description: 'The search query: order number (e.g. #1234 or 1234), phone number, email, product name, or Shopify order ID (for refund_status/tracking).'
            }
          },
          required: ['lookup_type', 'query']
        }
      });
      console.log(`[${reqId}] 🛒 Shopify tool registered for client ${session.clientId}`);
    }
    session.tools = tools;
    return tools;
  }

  // ─── Execute a tool call from the Realtime API ───
  async function executeToolCall(callId, functionName, argsStr) {
    console.log(`[${reqId}] 🔧 Tool call: ${functionName}(${argsStr.substring(0, 200)})`);
    let result = { error: `Unknown tool: ${functionName}` };

    // ─── Transfer to human agent ───
    if (functionName === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const args = JSON.parse(argsStr);
        const reason = args.reason || 'customer requested';
        console.log(`[${reqId}] 📞 TRANSFER TO HUMAN: reason="${reason}", intercom=${session.humanTransferNumber}, call_sid=${session.callSid}`);

        // Dynamically get Smartflo JWT via login
        const sfEmail = Deno.env.get('SMARTFLO_EMAIL');
        const sfPassword = Deno.env.get('SMARTFLO_PASSWORD');
        if (!sfEmail || !sfPassword) {
          result = { error: 'Transfer not available — SMARTFLO_EMAIL/PASSWORD not configured' };
        } else {
          let smartfloToken;
          try {
            const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ email: sfEmail, password: sfPassword })
            });
            const loginData = await loginResp.json();
            const loginToken = loginData.access_token || loginData.token;
            if (!loginResp.ok || !loginToken) throw new Error(loginData.message || 'Login failed');
            smartfloToken = loginToken;
            console.log(`[${reqId}] 📞 Smartflo login OK for transfer`);
          } catch (loginErr) {
            result = { error: `Smartflo login failed: ${loginErr.message}` };
            // Send result and return early
            sendToRealtime({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) }
            });
            sendToRealtime({ type: 'response.create' });
            return;
          }
          const transferResp = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${smartfloToken}`
            },
            body: JSON.stringify({
              type: 4,
              call_id: session.callSid,
              intercom: String(session.humanTransferNumber)
            })
          });

          const transferData = await transferResp.json();
          console.log(`[${reqId}] 📞 Transfer API response: ${transferResp.status}`, JSON.stringify(transferData));

          if (transferResp.ok) {
            result = { success: true, message: 'Call is being transferred to a human agent. The customer will be connected shortly.' };

            // Update CallLog with transfer info (fire-and-forget)
            if (session.callLogId) {
              const { createClient } = await import('npm:@base44/sdk@0.8.20');
              const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
              svc.entities.CallLog.update(session.callLogId, {
                transferred_to: `Human agent (intercom: ${session.humanTransferNumber}, reason: ${reason})`
              }).catch(() => {});
            }

            // Add to transcript
            session.transcript.push({ speaker: 'System', text: `[Call transferred to human agent. Reason: ${reason}]` });
          } else {
            result = { error: `Transfer failed: ${transferData.message || transferResp.status}` };
            console.error(`[${reqId}] ❌ Transfer failed:`, transferData);
          }
        }
      } catch (err) {
        console.error(`[${reqId}] ❌ Transfer error: ${err.message}`);
        result = { error: `Transfer failed: ${err.message}` };
      }

      // Send result back to Realtime API
      sendToRealtime({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) }
      });
      sendToRealtime({ type: 'response.create' });
      return;
    }

    if (functionName === 'shopify_lookup' && session.clientId) {
      try {
        const args = JSON.parse(argsStr);
        const { createClient } = await import('npm:@base44/sdk@0.8.20');
        const appId = Deno.env.get('BASE44_APP_ID');
        const svc = createClient({ appId, asServiceRole: true });

        const integrations = await svc.entities.MarketplaceIntegration.filter({
          client_id: session.clientId,
          platform: 'shopify',
          status: 'active'
        });

        if (integrations.length === 0) {
          result = { error: 'No active Shopify integration' };
        } else {
          const shop = integrations[0];
          const storeUrl = shop.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const apiVersion = shop.api_version || '2024-01';
          const baseUrl = `https://${storeUrl}/admin/api/${apiVersion}`;
          const headers = {
            'X-Shopify-Access-Token': shop.api_access_token,
            'Content-Type': 'application/json'
          };

          if (args.lookup_type === 'order_by_number') {
            const orderName = args.query.startsWith('#') ? args.query : `#${args.query}`;
            const res = await fetch(`${baseUrl}/orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=3`, { headers });
            if (res.ok) {
              const data = await res.json();
              result = { orders: (data.orders || []).map(o => formatShopifyOrder(o)) };
            } else {
              result = { error: `Shopify API error: ${res.status}` };
            }
          } else if (args.lookup_type === 'order_by_phone') {
            const res = await fetch(`${baseUrl}/orders.json?status=any&limit=20`, { headers });
            if (res.ok) {
              const data = await res.json();
              const cleanQ = args.query.replace(/[^0-9]/g, '');
              const filtered = (data.orders || []).filter(o => {
                const ph = (o.customer?.phone || o.phone || o.billing_address?.phone || '').replace(/[^0-9]/g, '');
                return ph.includes(cleanQ) || cleanQ.includes(ph);
              });
              result = { orders: filtered.slice(0, 5).map(o => formatShopifyOrder(o)) };
            } else {
              result = { error: `Shopify API error: ${res.status}` };
            }
          } else if (args.lookup_type === 'order_by_email') {
            const custRes = await fetch(`${baseUrl}/customers/search.json?query=email:${encodeURIComponent(args.query)}&limit=1`, { headers });
            if (custRes.ok) {
              const custData = await custRes.json();
              if (custData.customers?.length > 0) {
                const cId = custData.customers[0].id;
                const ordRes = await fetch(`${baseUrl}/customers/${cId}/orders.json?status=any&limit=5`, { headers });
                const ordData = await ordRes.json();
                result = { customer_name: `${custData.customers[0].first_name || ''} ${custData.customers[0].last_name || ''}`.trim(), orders: (ordData.orders || []).map(o => formatShopifyOrder(o)) };
              } else {
                result = { orders: [], message: 'No customer found with that email' };
              }
            } else {
              result = { error: `Shopify API error: ${custRes.status}` };
            }
          } else if (args.lookup_type === 'product_search') {
            const res = await fetch(`${baseUrl}/products.json?title=${encodeURIComponent(args.query)}&limit=5`, { headers });
            if (res.ok) {
              const data = await res.json();
              result = { products: (data.products || []).map(p => ({ title: p.title, available: p.variants?.some(v => (v.inventory_quantity || 0) > 0), variants: p.variants?.map(v => ({ title: v.title, price: v.price, stock: v.inventory_quantity })) })) };
            } else {
              result = { error: `Shopify API error: ${res.status}` };
            }
          } else if (args.lookup_type === 'tracking') {
            const res = await fetch(`${baseUrl}/orders/${args.query}/fulfillments.json`, { headers });
            if (res.ok) {
              const data = await res.json();
              result = { fulfillments: (data.fulfillments || []).map(f => ({ tracking_number: f.tracking_number, tracking_company: f.tracking_company, tracking_url: f.tracking_url, status: f.status, shipment_status: f.shipment_status })) };
            } else {
              result = { error: `Shopify API error: ${res.status}` };
            }
          } else if (args.lookup_type === 'refund_status') {
            const res = await fetch(`${baseUrl}/orders/${args.query}/refunds.json`, { headers });
            if (res.ok) {
              const data = await res.json();
              result = { refunds: (data.refunds || []).map(r => ({ created_at: r.created_at, note: r.note, items: r.refund_line_items?.map(li => li.line_item?.title) })) };
            } else {
              result = { error: `Shopify API error: ${res.status}` };
            }
          } else {
            result = { error: `Unknown lookup_type: ${args.lookup_type}` };
          }
        }
      } catch (err) {
        console.error(`[${reqId}] ❌ Tool execution error: ${err.message}`);
        result = { error: err.message };
      }
    }

    console.log(`[${reqId}] 🔧 Tool result: ${JSON.stringify(result).substring(0, 300)}`);

    // Send the result back to the Realtime API
    sendToRealtime({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result)
      }
    });
    // Trigger a new response from the model with the tool result
    sendToRealtime({ type: 'response.create' });
  }

  // ─── Format Shopify order for concise voice response ───
  function formatShopifyOrder(order) {
    const fulfillment = order.fulfillment_status || 'unfulfilled';
    const tracking = (order.fulfillments || []).filter(f => f.tracking_number).map(f => ({
      tracking_number: f.tracking_number,
      company: f.tracking_company,
      url: f.tracking_url,
      status: f.shipment_status || f.status
    }));
    return {
      order_number: order.name || `#${order.order_number}`,
      date: order.created_at?.substring(0, 10),
      status: order.cancelled_at ? 'cancelled' : fulfillment,
      payment: order.financial_status,
      total: `${order.currency} ${order.total_price}`,
      items: (order.line_items || []).map(li => `${li.title} x${li.quantity}`).join(', '),
      tracking: tracking.length > 0 ? tracking : 'no tracking yet',
      shipping_city: order.shipping_address?.city || ''
    };
  }

  function applySessionConfig() {
    const isHybrid = session.voiceEngine === 'azure_speech';
    const tools = buildToolDefinitions();
    const sessionConfig = {
      input_audio_format: 'pcm16',
      input_audio_transcription: { model: 'whisper-1', language: 'hi' },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.65,
        prefix_padding_ms: 800,
        silence_duration_ms: 800
      }
    };

    // Inject live IST timestamp so the agent knows the current time
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}. Use this to compute relative times (e.g. "30 minutes later", "tomorrow 10 AM"). Always state callback times in IST.\n`;

    // Build transfer instructions if enabled
    let transferInstructions = '';
    if (session.humanTransferNumber && session.enableAutoTransfer) {
      transferInstructions = `\n\n--- HUMAN AGENT TRANSFER (AVAILABLE) ---
You can transfer this call to a human agent using the transfer_to_human tool.
WHEN TO TRANSFER:
- Customer EXPLICITLY asks to speak to a human/real person/manager ("mujhe kisi insaan se baat karni hai", "connect me to your manager", "I want to talk to a real person")
- Customer is clearly very frustrated and you cannot resolve their issue after 2+ attempts
- The query requires actions you cannot perform (account changes, payments, etc.)
WHEN NOT TO TRANSFER:
- Customer is just asking questions you can answer
- Customer is mildly confused — try to help first
- Never transfer without telling the customer first
BEFORE TRANSFERRING: Always say something like "Let me connect you to a human agent who can help you better. Please hold for a moment."`;
    }

    if (isHybrid) {
      sessionConfig.instructions = 'You are a transcription-only assistant. Do not respond.';
      sessionConfig.modalities = ['text'];
      sessionConfig.voice = 'alloy';
      session.chatHistory = [{ role: 'system', content: timeInjection + session.systemPrompt + transferInstructions }];
      console.log(`[${reqId}] 🔀 Hybrid mode: Realtime STT → LLM → Azure Speech TTS (${session.voiceType})`);
    } else {
      sessionConfig.modalities = ['text', 'audio'];
      sessionConfig.instructions = timeInjection + session.systemPrompt + transferInstructions;
      sessionConfig.voice = session.voiceType;
      sessionConfig.output_audio_format = 'pcm16';
    }

    // Add tools if any are registered
    if (tools.length > 0) {
      sessionConfig.tools = tools;
      sessionConfig.tool_choice = 'auto';
      console.log(`[${reqId}] 🔧 ${tools.length} tool(s) registered with Realtime session`);
    }

    sendToRealtime({ type: 'session.update', session: sessionConfig });
    console.log(`[${reqId}] 📤 Session configured: engine=${session.voiceEngine}, voice=${session.voiceType}, tools=${tools.length}`);

    // ─── TRIGGER INITIAL GREETING so the agent speaks first ───
    triggerGreeting();
  }

  // ─── Handle messages FROM Azure Realtime API ───
  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Realtime session created`);
      session.realtimeReady = true;
      const isReconnect = session._agentConfigReady && session.transcript.length > 0;

      if (isReconnect) {
        // Reconnection — re-apply full config WITHOUT re-triggering the greeting
        console.log(`[${reqId}] 🔄 Reconnected — re-applying session config (no greeting)`);
        const isHybrid = session.voiceEngine === 'azure_speech';
        const tools = buildToolDefinitions();
        const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}.\n`;
        const sessionConfig = {
          input_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1', language: 'hi' },
          turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 800, silence_duration_ms: 800 }
        };
        if (isHybrid) {
          sessionConfig.instructions = 'You are a transcription-only assistant. Do not respond.';
          sessionConfig.modalities = ['text'];
          sessionConfig.voice = 'alloy';
        } else {
          sessionConfig.modalities = ['text', 'audio'];
          sessionConfig.instructions = timeInjection + session.systemPrompt;
          sessionConfig.voice = session.voiceType;
          sessionConfig.output_audio_format = 'pcm16';
        }
        if (tools.length > 0) { sessionConfig.tools = tools; sessionConfig.tool_choice = 'auto'; }
        sendToRealtime({ type: 'session.update', session: sessionConfig });
      } else if (session._agentConfigReady) {
        // First connection, agent config already loaded
        console.log(`[${reqId}] ⚡ Agent config was ready before Realtime — applying immediately`);
        applySessionConfig();
      } else {
        // Realtime connected first — send minimal config so audio can flow
        sendToRealtime({ type: 'session.update', session: {
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          modalities: ['text', 'audio'],
          voice: 'alloy',
          instructions: 'You are a friendly AI voice assistant. Be professional and concise. Wait for the system to provide further instructions before speaking.',
          turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 800, silence_duration_ms: 800 }
        }});
        console.log(`[${reqId}] 📤 Minimal config sent (waiting for agent config before greeting)`);
      }
      return;
    }

    if (type === 'session.updated') {
      console.log(`[${reqId}] ✅ Realtime session updated`);
      return;
    }

    // ─── Audio output from model → send to Smartflo caller ───
    if (type === 'response.audio.delta' && msg.delta) {
      if (!session._audioLogCount) session._audioLogCount = 0;
      session._audioLogCount++;
      if (session._audioLogCount <= 5) {
        console.log(`[${reqId}] 🔊 Audio delta #${session._audioLogCount}: ${msg.delta.length} base64 chars, smartflo=${smartfloSocket.readyState === WebSocket.OPEN}, streamSid=${!!session.streamSid}`);
      }
      session.isSpeaking = true;
      // Convert PCM16 24kHz base64 from Realtime API → mu-law 8kHz for Smartflo
      const mulawBytes = base64PCM16_24kToMulaw(msg.delta);

      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        sendMulawToSmartflo(mulawBytes);
      }
      return;
    }

    if (type === 'response.audio.done') {
      session.isSpeaking = false;
      console.log(`[${reqId}] 🔊 Audio response complete`);
      return;
    }

    // ─── Transcription of user's speech ───
    // Log transcription failures with details
    if (type === 'conversation.item.input_audio_transcription.failed') {
      console.error(`[${reqId}] ❌ Input transcription FAILED:`, JSON.stringify(msg.error || msg));
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        console.log(`[${reqId}] 🗣️ Customer: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'Customer', text });

        // In hybrid mode, send transcribed text to GPT-5-nano for response
        if (session.voiceEngine === 'azure_speech') {
          generateGpt5NanoResponse(text);
        }
      }
      return;
    }

    // ─── Model's text output (for transcript logging) ───
    if (type === 'response.audio_transcript.done' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        console.log(`[${reqId}] 🤖 AI: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'AI', text });
      }
      return;
    }

    // ─── Hybrid mode: ignore Realtime text responses (GPT-5-nano handles this) ───
    if (type === 'response.text.done' && session.voiceEngine === 'azure_speech') {
      // Ignore - we use GPT-5-nano for text generation in hybrid mode
      return;
    }

    // ─── Barge-in: user started speaking while model is responding ───
    if (type === 'input_audio_buffer.speech_started') {
      console.log(`[${reqId}] 🛑 Barge-in: user speaking, clearing Smartflo buffer`);
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        smartfloSocket.send(JSON.stringify({
          event: 'clear',
          streamSid: session.streamSid
        }));
      }
      // Cancel any ongoing Azure Speech TTS
      if (session._ttsAbort) {
        session._ttsAbort.abort();
        session._ttsAbort = null;
      }
      session.isSpeaking = false;
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      console.log(`[${reqId}] 🔇 User speech ended`);
      return;
    }

    // ─── Tool/function call from Realtime API ───
    if (type === 'response.function_call_arguments.done') {
      const callId = msg.call_id;
      const fnName = msg.name;
      const fnArgs = msg.arguments || '{}';
      console.log(`[${reqId}] 🔧 Function call received: ${fnName} (call_id=${callId})`);
      executeToolCall(callId, fnName, fnArgs);
      return;
    }

    if (type === 'error') {
      console.error(`[${reqId}] ❌ Realtime API error:`, JSON.stringify(msg.error || msg));
      return;
    }

    // Log other events at debug level
    if (!['response.created', 'response.output_item.added', 'response.content_part.added',
          'response.output_item.done', 'response.content_part.done', 'response.done',
          'conversation.item.created', 'rate_limits.updated',
          'response.audio_transcript.delta', 'response.text.delta',
          'input_audio_buffer.committed'].includes(type)) {
      console.log(`[${reqId}] 📩 Realtime event: ${type}`);
    }
  }

  // ─── Trigger initial greeting so the AI speaks first ───
  function triggerGreeting() {
    const isHybrid = session.voiceEngine === 'azure_speech';
    const greeting = session.greetingMessage || '';

    if (isHybrid) {
      // In hybrid mode, directly synthesize the greeting via Azure Speech TTS
      if (greeting) {
        console.log(`[${reqId}] 🎙️ Sending custom greeting (hybrid): "${greeting.substring(0, 80)}"`);
        session.transcript.push({ speaker: 'AI', text: greeting });
        session.chatHistory.push({ role: 'assistant', content: greeting });
        synthesizeWithAzureSpeech(greeting);
      } else {
        // No custom greeting — ask LLM to generate one
        console.log(`[${reqId}] 🎙️ Generating AI greeting (hybrid)`);
        generateGpt5NanoResponse('[SYSTEM: The call just connected. Greet the customer warmly as your opening line. Do not wait for them to speak first.]');
      }
    } else {
      // In Realtime mode, inject a conversation item + trigger a response
      if (greeting) {
        // Custom greeting: inject it as a pre-written assistant message and speak it
        console.log(`[${reqId}] 🎙️ Sending custom greeting (realtime): "${greeting.substring(0, 80)}"`);
        session.transcript.push({ speaker: 'AI', text: greeting });
        sendToRealtime({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '[SYSTEM: The call just connected. Say this exact greeting to the customer: "' + greeting + '"]' }]
          }
        });
        sendToRealtime({ type: 'response.create' });
      } else {
        // No custom greeting — ask the model to generate one from its instructions
        console.log(`[${reqId}] 🎙️ Triggering AI greeting (realtime)`);
        sendToRealtime({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '[SYSTEM: The call just connected. Greet the customer warmly as your opening line. Do not wait for them to speak first.]' }]
          }
        });
        sendToRealtime({ type: 'response.create' });
      }
    }
  }

  // ─── Send message to Azure Realtime API ───
  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    }
  }

  // ─── Safe base64 encoding for large Uint8Array (avoids stack overflow from spread) ───
  function uint8ToBase64(bytes) {
    let binary = '';
    const len = bytes.length;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // ─── Send mu-law audio to Smartflo in 160-byte aligned chunks ───
  function sendMulawToSmartflo(mulawBytes) {
    const CHUNK_SIZE = 1600; // 200ms at 8kHz mu-law (larger = fewer sends, less overhead)
    for (let i = 0; i < mulawBytes.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, mulawBytes.length);
      let chunk = mulawBytes.slice(i, end);

      // Pad to 160-byte boundary (20ms frame alignment)
      if (chunk.length % 160 !== 0) {
        const paddedLen = Math.ceil(chunk.length / 160) * 160;
        const padded = new Uint8Array(paddedLen);
        padded.set(chunk);
        padded.fill(0xFF, chunk.length); // silence padding
        chunk = padded;
      }

      const payload = uint8ToBase64(chunk);
      smartfloSocket.send(JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: { payload }
      }));
    }
  }

  // ─── Azure Speech TTS (hybrid mode) ───
  async function synthesizeWithAzureSpeech(text) {
    const speechKey = Deno.env.get('AZURE_SPEECH_KEY');
    const speechRegion = Deno.env.get('AZURE_SPEECH_REGION');

    if (!speechKey || !speechRegion) {
      console.error(`[${reqId}] ❌ Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION for TTS`);
      return;
    }

    const voiceName = session.voiceType;
    // Auto-detect language from text content for correct SSML xml:lang
    // Devanagari Unicode range: \u0900-\u097F
    const hasDevanagari = /[\u0900-\u097F]/.test(text);
    const xmlLang = hasDevanagari ? 'hi-IN' : 'en-IN';
    const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>
      <voice name='${voiceName}'>${escapedText}</voice>
    </speak>`;
    console.log(`[${reqId}] 🗣️ TTS: voice=${voiceName}, lang=${xmlLang}, text="${text.substring(0, 60)}..."`);

    const controller = new AbortController();
    session._ttsAbort = controller;
    session.isSpeaking = true;

    try {
      const ttsUrl = `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
      const response = await fetch(ttsUrl, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'raw-8khz-8bit-mono-mulaw',
        },
        body: ssml,
        signal: controller.signal
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[${reqId}] ❌ Azure Speech TTS error: ${response.status} ${errText}`);
        session.isSpeaking = false;
        return;
      }

      // Stream the mu-law 8kHz audio directly to Smartflo (no conversion needed)
      const audioBuffer = new Uint8Array(await response.arrayBuffer());
      console.log(`[${reqId}] 🔊 Azure Speech TTS: ${audioBuffer.length} bytes of mu-law audio`);

      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        // Send in smaller chunks to allow barge-in checking
        const CHUNK_SIZE = 1600;
        for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
          if (controller.signal.aborted) {
            console.log(`[${reqId}] 🛑 TTS playback aborted (barge-in)`);
            break;
          }
          const end = Math.min(i + CHUNK_SIZE, audioBuffer.length);
          let chunk = audioBuffer.slice(i, end);

          if (chunk.length % 160 !== 0) {
            const paddedLen = Math.ceil(chunk.length / 160) * 160;
            const padded = new Uint8Array(paddedLen);
            padded.set(chunk);
            padded.fill(0xFF, chunk.length);
            chunk = padded;
          }

          const payload = uint8ToBase64(chunk);
          smartfloSocket.send(JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: { payload }
          }));
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log(`[${reqId}] 🛑 TTS aborted`);
      } else {
        console.error(`[${reqId}] ❌ Azure Speech TTS failed: ${err.message}`);
      }
    } finally {
      session.isSpeaking = false;
      session._ttsAbort = null;
    }
  }

  // ─── Clean text for TTS (remove markdown, emojis, special chars) ───
  function cleanTextForTTS(text) {
    return text
      .replace(/\*\*([^*]+)\*\*/g, '$1')  // **bold** → bold
      .replace(/\*([^*]+)\*/g, '$1')       // *italic* → italic
      .replace(/__([^_]+)__/g, '$1')       // __underline__ → underline
      .replace(/_([^_]+)_/g, '$1')         // _italic_ → italic
      .replace(/#{1,6}\s*/g, '')           // # headers
      .replace(/```[\s\S]*?```/g, '')      // code blocks
      .replace(/`([^`]+)`/g, '$1')         // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link](url) → link
      .replace(/[😊🙏👋✅❌🎯📋🕐⚠️💡🔊🎙️]/gu, '') // common emojis
      .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // emoticons
      .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // misc symbols
      .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // transport
      .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // flags
      .replace(/[\u{2600}-\u{26FF}]/gu, '')   // misc symbols
      .replace(/[\u{2700}-\u{27BF}]/gu, '')   // dingbats
      .replace(/\n{2,}/g, '. ')            // multiple newlines → pause
      .replace(/\n/g, ' ')                 // single newline → space
      .replace(/\s{2,}/g, ' ')            // multiple spaces
      .trim();
  }

  // ─── LLM text generation with streaming (hybrid mode) ───
  async function generateGpt5NanoResponse(userText) {
    const nanoEndpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const nanoKey = Deno.env.get('AZURE_OPENAI_KEY');
    const nanoDeployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');

    if (!nanoEndpoint || !nanoKey || !nanoDeployment) {
      console.error(`[${reqId}] ❌ Missing Azure OpenAI secrets: endpoint=${!!nanoEndpoint}, key=${!!nanoKey}, deployment=${!!nanoDeployment}`);
      return;
    }

    // Add user message to chat history
    session.chatHistory.push({ role: 'user', content: userText });

    try {
      const url = `${nanoEndpoint}/openai/deployments/${nanoDeployment}/chat/completions?api-version=2025-01-01-preview`;
      console.log(`[${reqId}] 🧠 LLM URL: ${url.substring(0, 120)}...`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'api-key': nanoKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            ...session.chatHistory.slice(0, 1), // system prompt
            { role: 'system', content: 'CRITICAL VOICE CALL RULES:\n1. You are on a LIVE PHONE CALL. Your text will be spoken by Hindi TTS.\n2. ALWAYS respond in Hindi script (देवनागरी). Example: "नमस्ते, मैं वाणी बोल रही हूँ" NOT "Namaste, main Vaani bol rahi hoon".\n3. NEVER use English words unless absolutely necessary (brand names OK).\n4. NEVER use markdown (**, *, #, ```, []), emojis, or special characters.\n5. Keep responses SHORT - maximum 2 sentences. Be conversational like a real phone call.\n6. Write plain text only. No bullet points, no lists, no formatting.' },
            ...session.chatHistory.slice(1) // rest of conversation
          ],
          max_completion_tokens: 150,
          stream: true
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[${reqId}] ❌ LLM error: ${response.status} ${errText}`);
        return;
      }

      // Stream the response - send first sentence to TTS immediately for lower latency
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let sentenceBuffer = '';
      let sentencesSent = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const json = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (!delta) continue;

            fullText += delta;
            sentenceBuffer += delta;

            // Check for sentence boundaries to send early TTS
            const sentenceMatch = sentenceBuffer.match(/^(.*?[.?!।\n])\s*(.*)/s);
            if (sentenceMatch) {
              const sentence = cleanTextForTTS(sentenceMatch[1]);
              sentenceBuffer = sentenceMatch[2] || '';

              if (sentence && sentence.length > 3) {
                sentencesSent++;
                if (sentencesSent === 1) {
                  console.log(`[${reqId}] 🧠 LLM first sentence: "${sentence.substring(0, 80)}"`);
                }
                // Fire TTS for this sentence without awaiting (parallel playback)
                synthesizeWithAzureSpeech(sentence);
              }
            }
          } catch (_) { /* skip parse errors in SSE */ }
        }
      }

      // Send any remaining text
      const remaining = cleanTextForTTS(sentenceBuffer);
      if (remaining && remaining.length > 3) {
        synthesizeWithAzureSpeech(remaining);
      }

      const cleanFull = cleanTextForTTS(fullText);
      console.log(`[${reqId}] 🧠 LLM complete: "${cleanFull.substring(0, 100)}" (${sentencesSent} sentences streamed)`);
      session.chatHistory.push({ role: 'assistant', content: fullText });
      session.transcript.push({ speaker: 'AI', text: cleanFull });

    } catch (err) {
      console.error(`[${reqId}] ❌ LLM failed: ${err.message}`);
    }
  }

  // ─── Load agent config from CallLog cache ───
  // Finds the matching CallLog for this WebSocket stream, extracts the cached agent config
  async function loadAgentConfig() {
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.20');
      const appId = Deno.env.get('BASE44_APP_ID');
      const svc = createClient({ appId, asServiceRole: true });

      let callLog = null;
      const cutoff = new Date(Date.now() - 120000).toISOString(); // 2 minute window

      // ── Strategy 1: call_sid match (most reliable when formats align) ──
      if (!callLog && session.callSid) {
        const variants = [session.callSid];
        // Smartflo WebSocket callSid may differ from API call_id — try numeric core
        const numericCore = session.callSid.replace(/^[^-]*-/, '').replace(/\.[^.]*$/, '');
        if (numericCore && numericCore !== session.callSid) variants.push(numericCore);
        // Also try just digits
        const digitsOnly = session.callSid.replace(/\D/g, '');
        if (digitsOnly && digitsOnly.length > 5) variants.push(digitsOnly);

        for (const sid of variants) {
          if (callLog) break;
          try {
            const logs = await svc.entities.CallLog.filter({ call_sid: sid });
            if (logs.length > 0) {
              callLog = logs[0];
              console.log(`[${reqId}] 🔍 call_sid match (${sid}): ${callLog.id}`);
            }
          } catch (e) {}
        }
      }

      // ── Strategy 2: Recent unclaimed ringing/initiated calls ──
      // When multiple calls are ringing (e.g. campaign batch), prefer matching by callee number
      if (!callLog) {
        try {
          const recentLogs = await svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 20);
          const unclaimed = recentLogs.filter(l => !l.stream_sid && l.created_date >= cutoff);
          console.log(`[${reqId}] 🔍 Ringing unclaimed: ${unclaimed.length} (total ringing: ${recentLogs.length}), calleeNumber=${session.calleeNumber}`);

          if (unclaimed.length >= 1) {
            // Try to match by callee_number first (critical for concurrent campaign calls)
            if (session.calleeNumber) {
              const cleanCallee = session.calleeNumber.replace(/[^0-9]/g, '');
              const phoneMatch = unclaimed.find(l => {
                const logPhone = (l.callee_number || '').replace(/[^0-9]/g, '');
                // Match last 10 digits (ignore country code differences)
                return logPhone.slice(-10) === cleanCallee.slice(-10);
              });
              if (phoneMatch) {
                callLog = phoneMatch;
                console.log(`[${reqId}] ⚡ Phone match: ringing call ${callLog.id} (${callLog.callee_number})`);
              }
            }
            // Fallback: pick most recent unclaimed
            if (!callLog) {
              callLog = unclaimed[0];
              console.log(`[${reqId}] ⚡ Recent match: ringing call ${callLog.id} (${callLog.callee_number})`);
            }
          }
        } catch (e) {
          console.log(`[${reqId}] ⚠️ Ringing lookup failed: ${e.message}`);
        }
      }

      if (!callLog) {
        try {
          const initLogs = await svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 20);
          const unclaimed = initLogs.filter(l => !l.stream_sid && l.created_date >= cutoff);
          console.log(`[${reqId}] 🔍 Initiated unclaimed: ${unclaimed.length}`);

          if (unclaimed.length >= 1) {
            if (session.calleeNumber) {
              const cleanCallee = session.calleeNumber.replace(/[^0-9]/g, '');
              const phoneMatch = unclaimed.find(l => {
                const logPhone = (l.callee_number || '').replace(/[^0-9]/g, '');
                return logPhone.slice(-10) === cleanCallee.slice(-10);
              });
              if (phoneMatch) {
                callLog = phoneMatch;
                console.log(`[${reqId}] ⚡ Phone match: initiated call ${callLog.id} (${callLog.callee_number})`);
              }
            }
            if (!callLog) {
              callLog = unclaimed[0];
              console.log(`[${reqId}] ⚡ Recent match: initiated call ${callLog.id} (${callLog.callee_number})`);
            }
          }
        } catch (e) {
          console.log(`[${reqId}] ⚠️ Initiated lookup failed: ${e.message}`);
        }
      }

      // ── Strategy 3: Broadest fallback ──
      if (!callLog) {
        try {
          const allRecent = await svc.entities.CallLog.list('-created_date', 15);
          const candidates = allRecent.filter(l =>
            !l.stream_sid &&
            l.created_date >= cutoff &&
            l.agent_config_cache?.system_prompt &&
            ['initiated', 'ringing', 'answered'].includes(l.status)
          );
          if (candidates.length > 0) {
            // Try phone match first
            if (session.calleeNumber) {
              const cleanCallee = session.calleeNumber.replace(/[^0-9]/g, '');
              const phoneMatch = candidates.find(l => {
                const logPhone = (l.callee_number || '').replace(/[^0-9]/g, '');
                return logPhone.slice(-10) === cleanCallee.slice(-10);
              });
              if (phoneMatch) {
                callLog = phoneMatch;
                console.log(`[${reqId}] 🔍 Broad phone match: ${callLog.id} (${callLog.callee_number})`);
              }
            }
            if (!callLog) {
              callLog = candidates[0];
              console.log(`[${reqId}] 🔍 Broad fallback match: ${callLog.id} (status=${callLog.status})`);
            }
          }
        } catch (e) {
          console.log(`[${reqId}] ⚠️ Broad fallback failed: ${e.message}`);
        }
      }

      // ── Strategy 4: INBOUND CALL — DID → Agent direct resolution ──
      // For inbound calls, the WebSocket connects BEFORE smartfloWebhook creates a CallLog.
      // Resolve the agent directly from the DID that was called.
      if (!callLog && session.calleeNumber) {
        console.log(`[${reqId}] 🔍 No CallLog found. Trying inbound DID→Agent resolution for: ${session.calleeNumber}`);
        const cleanCalleeDID = session.calleeNumber.replace(/[^0-9]/g, '').slice(-10);

        if (cleanCalleeDID) {
          // Try DID entity first
          const allDIDs = await svc.entities.DID.list('-created_date', 200);
          const matchedDID = allDIDs.find(d => (d.number || '').replace(/\D/g, '').slice(-10) === cleanCalleeDID);

          let didAgent = null;
          let didClient = null;

          if (matchedDID?.agent_id) {
            try { didAgent = await svc.entities.Agent.get(matchedDID.agent_id); } catch (_) {}
          }
          if (matchedDID?.client_id) {
            try { didClient = await svc.entities.Client.get(matchedDID.client_id); } catch (_) {}
          }

          // Fallback: search agents' assigned_dids arrays
          if (!didAgent) {
            const allAgents = await svc.entities.Agent.list('-created_date', 100);
            didAgent = allAgents.find(a => {
              const dids = a.assigned_dids || (a.assigned_did ? [a.assigned_did] : []);
              return dids.some(d => (d || '').replace(/\D/g, '').slice(-10) === cleanCalleeDID);
            });
            if (didAgent && !didClient && didAgent.client_id) {
              try { didClient = await svc.entities.Client.get(didAgent.client_id); } catch (_) {}
            }
          }

          if (didAgent) {
            console.log(`[${reqId}] ✅ INBOUND: DID ${session.calleeNumber} → Agent "${didAgent.name}" (${didAgent.id}), Client: ${didClient?.company_name || 'unknown'}`);

            // Build agent config directly (no CallLog yet — will be created by webhook later)
            session.clientId = didClient?.id || didAgent.client_id;

            let kbContent = '';
            if (didAgent.knowledge_base_ids?.length > 0) {
              for (const kbId of didAgent.knowledge_base_ids) {
                try {
                  const doc = await svc.entities.KnowledgeBase.get(kbId);
                  if (doc?.content) kbContent += `[${doc.title}]\n${doc.content}\n\n---\n\n`;
                } catch (_) {}
              }
            }

            // Check for caller identity (lead matching) using session.callerNumber if available
            let callerContext = '';
            if (session.callerNumber && didClient) {
              const cleanCaller = session.callerNumber.replace(/\D/g, '').slice(-10);
              if (cleanCaller) {
                try {
                  const clientLeads = await svc.entities.Lead.filter({ client_id: didClient.id });
                  const matchedLead = clientLeads.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === cleanCaller);
                  if (matchedLead) {
                    console.log(`[${reqId}] 🎯 Caller identified as Lead: "${matchedLead.name}" (score: ${matchedLead.score})`);
                    callerContext = [
                      `\n\n--- INBOUND CALL - RETURNING LEAD ---`,
                      `- Name: ${matchedLead.name || 'Unknown'}`,
                      `- Phone: ${matchedLead.phone}`,
                      matchedLead.email ? `- Email: ${matchedLead.email}` : null,
                      matchedLead.company ? `- Company: ${matchedLead.company}` : null,
                      `- Status: ${matchedLead.status || 'new'}`,
                      `- Score: ${matchedLead.score || 0}/100`,
                      matchedLead.qualification_tier ? `- Tier: ${matchedLead.qualification_tier}` : null,
                      matchedLead.notes ? `- Notes: ${matchedLead.notes.substring(0, 300)}` : null,
                      ``,
                      `CRITICAL: This is an INBOUND callback. Address them by name "${matchedLead.name || 'Sir/Madam'}".`,
                    ].filter(Boolean).join('\n');

                    // Also get recent call history for this lead
                    try {
                      const leadCalls = await svc.entities.CallLog.filter({ lead_id: matchedLead.id });
                      const recentCalls = leadCalls
                        .sort((a, b) => new Date(b.call_start_time || b.created_date) - new Date(a.call_start_time || a.created_date))
                        .slice(0, 3);
                      if (recentCalls.length > 0) {
                        callerContext += '\n\nLAST CALL HISTORY:';
                        recentCalls.forEach(c => {
                          callerContext += `\n- ${c.direction} | ${c.status} | ${(c.conversation_summary || 'No summary').substring(0, 150)}`;
                        });
                      }
                    } catch (_) {}

                    // Store lead_id for later CallLog association
                    session._inboundLeadId = matchedLead.id;
                  }
                } catch (e) {
                  console.log(`[${reqId}] ⚠️ Lead matching failed: ${e.message}`);
                }
              }
            }

            session.systemPrompt = (didAgent.system_prompt || 'You are a helpful AI voice assistant.') + callerContext;
            if (kbContent) session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${kbContent}`;
            if (didAgent.greeting_message) session.greetingMessage = didAgent.greeting_message;
            if (didAgent.human_transfer_number) session.humanTransferNumber = didAgent.human_transfer_number;
            if (didAgent.enable_auto_transfer === false) session.enableAutoTransfer = false;
            if (didAgent.persona) {
              if (didAgent.persona.voice_engine) session.voiceEngine = didAgent.persona.voice_engine;
              if (didAgent.persona.voice_type) {
                if (session.voiceEngine === 'realtime') {
                  const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
                  const deprecatedMap = { 'nova': 'shimmer', 'onyx': 'ash', 'fable': 'ballad' };
                  let voice = didAgent.persona.voice_type.toLowerCase();
                  if (deprecatedMap[voice]) voice = deprecatedMap[voice];
                  if (validVoices.includes(voice)) session.voiceType = voice;
                } else {
                  session.voiceType = didAgent.persona.voice_type;
                }
              }
            }

            // Create an inbound CallLog so saveCallRecord can persist transcript later
            try {
              const newInboundLog = await svc.entities.CallLog.create({
                client_id: session.clientId,
                agent_id: didAgent.id,
                lead_id: session._inboundLeadId || null,
                call_sid: session.callSid || `inbound_${Date.now()}`,
                stream_sid: session.streamSid || null,
                caller_id: session.callerNumber || '',
                callee_number: session.calleeNumber,
                direction: 'inbound',
                status: 'answered',
                call_start_time: new Date().toISOString(),
                agent_config_cache: {
                  agent_name: didAgent.name,
                  system_prompt: session.systemPrompt,
                  persona: didAgent.persona || {},
                  knowledge_base_content: kbContent,
                  lead_context: callerContext,
                  greeting_message: didAgent.greeting_message || '',
                  human_transfer_number: didAgent.human_transfer_number || '',
                  enable_auto_transfer: didAgent.enable_auto_transfer !== false
                }
              });
              session.callLogId = newInboundLog.id;
              console.log(`[${reqId}] ✅ Inbound CallLog created: ${newInboundLog.id} (Agent: ${didAgent.name})`);
            } catch (clErr) {
              console.error(`[${reqId}] ⚠️ Failed to create inbound CallLog: ${clErr.message}`);
            }

            console.log(`[${reqId}] ✅ INBOUND agent config loaded: engine=${session.voiceEngine}, voice=${session.voiceType}, prompt=${session.systemPrompt.length} chars`);
            return; // Config loaded successfully via DID→Agent
          }
        }
      }

      if (!callLog) {
        console.log(`[${reqId}] ⚠️ No call log found after all strategies. callSid=${session.callSid}, streamSid=${session.streamSid}, calleeNumber=${session.calleeNumber}`);
        console.log(`[${reqId}] ⚠️ Agent will use DEFAULT generic prompt — this call will NOT be personalized.`);
        return;
      }

      // ── IMMEDIATELY extract config and apply to session (before any DB writes) ──
      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      const cache = callLog.agent_config_cache;

      // ── Check for Shopify marketplace integration ──
      if (callLog.client_id) {
        try {
          const shopifyIntegrations = await svc.entities.MarketplaceIntegration.filter({
            client_id: callLog.client_id,
            platform: 'shopify',
            status: 'active'
          });
          if (shopifyIntegrations.length > 0) {
            session.hasShopify = true;
            console.log(`[${reqId}] 🛒 Shopify integration found for client ${callLog.client_id}`);
          }
        } catch (e) {
          console.log(`[${reqId}] ⚠️ Shopify check failed: ${e.message}`);
        }
      }

      if (cache && cache.system_prompt) {
        session.systemPrompt = cache.system_prompt;
        if (cache.knowledge_base_content) {
          session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${cache.knowledge_base_content}`;
        }
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        // Inject Shopify tool instructions if integration is active
        if (session.hasShopify && !session.systemPrompt.includes('SHOPIFY STORE INTEGRATION')) {
          session.systemPrompt += `\n\n--- SHOPIFY STORE INTEGRATION (ACTIVE) ---
You have a LIVE connection to the client's Shopify store. You can look up real-time data using the shopify_lookup tool.
WHEN TO USE:
- Customer asks about order status → use lookup_type "order_by_number" with the order number
- Customer gives phone/email but no order # → use "order_by_phone" or "order_by_email"
- Customer asks about product availability → use "product_search"
- Customer asks about refund → use "refund_status" with the Shopify order ID
- Customer asks about delivery/tracking → use "tracking" with the Shopify order ID
IMPORTANT: Ask for order number/phone/email, ALWAYS use the tool for real data, NEVER make up statuses.`;
          console.log(`[${reqId}] 🛒 Shopify tool instructions injected into system prompt`);
        }
        if (cache.greeting_message) {
          session.greetingMessage = cache.greeting_message;
        }
        console.log(`[${reqId}] ✅ Agent config loaded from CallLog ${callLog.id} (${session.systemPrompt.length} chars, agent=${cache.agent_name || 'unknown'}, greeting=${session.greetingMessage ? 'custom' : 'auto'})`);
      } else {
        console.log(`[${reqId}] ⚠️ CallLog ${callLog.id} found but has NO agent_config_cache — using default prompt`);
      }

      if (cache && cache.persona) {
        if (cache.persona.voice_engine) session.voiceEngine = cache.persona.voice_engine;
        if (cache.persona.voice_type) {
          if (session.voiceEngine === 'realtime') {
            const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
            const deprecatedMap = { 'nova': 'shimmer', 'onyx': 'ash', 'fable': 'ballad' };
            let voice = cache.persona.voice_type.toLowerCase();
            if (deprecatedMap[voice]) {
              console.log(`[${reqId}] ⚠️ Voice "${voice}" deprecated, using "${deprecatedMap[voice]}" instead`);
              voice = deprecatedMap[voice];
            }
            if (validVoices.includes(voice)) session.voiceType = voice;
          } else {
            session.voiceType = cache.persona.voice_type;
          }
        }
      }
      console.log(`[${reqId}] 🎙️ engine=${session.voiceEngine}, voice=${session.voiceType}`);

      // ── BACKGROUND: Claim CallLog with stream_sid (fire-and-forget, don't block) ──
      const updateFields = {};
      if (session.streamSid) updateFields.stream_sid = session.streamSid;
      if (session.callSid && callLog.call_sid !== session.callSid) updateFields.call_sid = session.callSid;
      if (Object.keys(updateFields).length > 0) {
        svc.entities.CallLog.update(callLog.id, updateFields)
          .then(() => console.log(`[${reqId}] 📍 Claimed CallLog ${callLog.id}`))
          .catch(() => {});
      }
    } catch (e) {
      console.error(`[${reqId}] ❌ Agent config load failed: ${e.message}`);
    }
  }

  // ─── PRE-WARM: Connect to Azure Realtime immediately (before Smartflo sends 'start') ───
  // This saves ~2-3 seconds by establishing the Realtime WebSocket during the ring phase
  connectRealtime();
  console.log(`[${reqId}] 🚀 Pre-warming Azure Realtime connection...`);

  // ─── Smartflo WebSocket Handlers ───

  smartfloSocket.onopen = () => {
    console.log(`[${reqId}] 🟢 Smartflo socket opened`);
  };

  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.event === 'connected') {
        console.log(`[${reqId}] ✅ Smartflo connected`);
        return;
      }

      if (msg.event === 'start') {
        const startData = msg.start || {};
        session.streamSid = startData.streamSid;
        session.callSid = startData.callSid;

        // Log ALL fields from start event for debugging inbound call routing
        console.log(`[${reqId}] 📞 START EVENT FULL DATA: ${JSON.stringify({
          streamSid: startData.streamSid,
          callSid: startData.callSid,
          to: startData.to,
          from: startData.from,
          callee: startData.callee,
          caller: startData.caller,
          direction: startData.direction,
          customParameters: startData.customParameters,
          accountSid: startData.accountSid,
          mediaFormat: startData.mediaFormat
        })}`);

        // Extract callee number (the DID that was called) — try ALL possible fields
        session.calleeNumber = startData.customParameters?.customer_number
          || startData.customParameters?.called_number
          || startData.customParameters?.to
          || startData.to
          || startData.callee
          || startData.customParameters?.did
          || '';

        // Extract caller number (who is calling) — try ALL possible fields
        session.callerNumber = startData.from
          || startData.caller
          || startData.customParameters?.caller_number
          || startData.customParameters?.from
          || startData.customParameters?.caller_id
          || '';

        // For inbound calls, Smartflo may swap to/from — detect this:
        // If 'to' matches one of our DID patterns and 'from' is a mobile number, it's inbound
        // The 'to' field is the DID being called, 'from' is the caller
        const toNum = (startData.to || '').replace(/\D/g, '');
        const fromNum = (startData.from || '').replace(/\D/g, '');
        
        // For outbound (click-to-call): customer_number = the lead being called (callee)
        // For inbound: 'to' = the DID, 'from' = the external caller
        // Detect: if customParameters.customer_number is empty but 'to' and 'from' exist,
        // this is likely an inbound call where 'to' is the DID
        if (!startData.customParameters?.customer_number && toNum && fromNum) {
          console.log(`[${reqId}] 📞 No customer_number param — likely INBOUND. to=${toNum}, from=${fromNum}`);
          session.calleeNumber = startData.to || '';  // DID that was called
          session.callerNumber = startData.from || ''; // External caller
        }

        console.log(`[${reqId}] 📞 Call start: stream=${session.streamSid}, call=${session.callSid}, calleeNumber=${session.calleeNumber}, callerNumber=${session.callerNumber}`);

        // Reset audio conversion state for new call (prevents cross-call artifacts)
        _lastUpsampleValue = 0;
        _lastDownsampleRemainder = [];

        // Azure Realtime was already pre-warmed on WebSocket upgrade.
        // Now load agent config — when ready, apply session config + greeting.
        loadAgentConfig().then(() => {
          session._agentConfigReady = true;
          console.log(`[${reqId}] 🚀 Agent config ready: engine=${session.voiceEngine}, voice=${session.voiceType}`);
          // If Realtime is already connected, apply config now
          if (session.realtimeReady) {
            applySessionConfig();
          }
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        // Forward caller audio → Azure Realtime API
        if (!session.realtimeReady) {
          // Buffer or drop — log first few drops
          if (!session._mediaDropCount) session._mediaDropCount = 0;
          session._mediaDropCount++;
          if (session._mediaDropCount <= 3) {
            console.log(`[${reqId}] ⏳ Realtime not ready yet, dropping media packet #${session._mediaDropCount}`);
          }
          return;
        }
        if (true) {
          const raw = atob(msg.media.payload);
          const mulawBytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) {
            mulawBytes[i] = raw.charCodeAt(i);
          }

          // Convert mu-law 8kHz → PCM16 24kHz base64 for Realtime API
          const pcm16Base64 = mulawToBase64PCM16_24k(mulawBytes);

          sendToRealtime({
            type: 'input_audio_buffer.append',
            audio: pcm16Base64
          });
        }
        return;
      }

      if (msg.event === 'mark') {
        // Marks not used in realtime mode
        return;
      }

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Smartflo stop event`);
        session._callEnded = true; // Prevent reconnect after hangup
        const duration = Math.round((Date.now() - session.startTime) / 1000);

        // Close Realtime WebSocket
        if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
          session.realtimeWs.close();
        }

        await saveCallRecord(session, reqId, duration);
        return;
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ Smartflo message error: ${err.message}`);
    }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true; // Prevent Azure reconnect after call ends
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Smartflo socket closed, duration=${duration}s`);

    // Close Realtime API connection
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }

    if (session.callLogId) {
      await saveCallRecord(session, reqId, duration);
    }
  };

  smartfloSocket.onerror = () => {
    console.error(`[${reqId}] ❌ Smartflo socket error`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  return response;
});