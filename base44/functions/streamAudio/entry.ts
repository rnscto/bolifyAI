import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// ─── Smartflo token cache (module-level, shared across WebSocket sessions in this isolate) ───
// Smartflo locks the account if you log in too frequently. Cache the JWT and respect retry_after.
const SMARTFLO_TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes
let _smartfloTokenCache = { token: null, expiresAt: 0, inFlight: null, blockedUntil: 0 };

async function getSmartfloToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _smartfloTokenCache.token && _smartfloTokenCache.expiresAt > now) {
    return _smartfloTokenCache.token;
  }
  // Honor Smartflo's rate-limit cool-down: don't attempt login while blocked.
  if (_smartfloTokenCache.blockedUntil > now) {
    const waitSec = Math.ceil((_smartfloTokenCache.blockedUntil - now) / 1000);
    console.error(`[Smartflo] Login skipped — rate-limited for ${waitSec}s more`);
    return null;
  }
  if (_smartfloTokenCache.inFlight) return _smartfloTokenCache.inFlight;
  const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
  if (!sfE || !sfP) return null;
  _smartfloTokenCache.inFlight = (async () => {
    try {
      const lr = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email: sfE, password: sfP })
      });
      const ld = await lr.json().catch(() => ({}));
      const tk = ld.access_token || ld.token;
      if (!lr.ok || !tk) {
        if (lr.status === 429 || ld.retry_after) {
          let cooldownMs = 10 * 60 * 1000; // default 10min
          if (ld.retry_after) {
            const ra = new Date(ld.retry_after.replace(' ', 'T') + '+05:30').getTime();
            if (!isNaN(ra) && ra > Date.now()) cooldownMs = ra - Date.now() + 5000;
          }
          _smartfloTokenCache.blockedUntil = Date.now() + cooldownMs;
          console.error(`[Smartflo] Login 429 — backing off for ${Math.round(cooldownMs / 1000)}s. retry_after=${ld.retry_after || 'n/a'}`);
        } else {
          console.error(`[Smartflo] Login failed: ${lr.status} ${JSON.stringify(ld).slice(0, 200)}`);
        }
        return null;
      }
      _smartfloTokenCache.token = tk;
      _smartfloTokenCache.expiresAt = Date.now() + SMARTFLO_TOKEN_TTL_MS;
      _smartfloTokenCache.blockedUntil = 0;
      console.log(`[Smartflo] ✅ New token cached (valid 50min)`);
      return tk;
    } catch (e) { console.error(`[Smartflo] Login error: ${e.message}`); return null; }
    finally { _smartfloTokenCache.inFlight = null; }
  })();
  return _smartfloTokenCache.inFlight;
}

// ─── Audio Bridging (NATIVE G.711 µ-LAW 8kHz — NO CONVERSION) ───
//
// Azure Realtime API natively supports g711_ulaw I/O at 8kHz; Smartflo natively streams
// g711_ulaw at 8kHz. By telling both endpoints to use g711_ulaw we eliminate ALL audio
// conversion (the previous code did 8k→24k upsample on input and 24k→8k decimation on
// output PER PACKET, which caused aliasing, CPU jitter, and the breaking/glitching voice).
//
// Input  (Smartflo → Azure):   mu-law base64 → forwarded verbatim → input_audio_buffer.append
// Output (Azure → Smartflo):   mu-law base64 → forwarded verbatim → media payload
//
// audioState is kept for backward compatibility with callers but no longer used.

// Pass-through: caller→model (Smartflo gives us base64 mu-law already, we just forward it)
function mulawBytesToBase64ULaw(mb) {
  let bin = ''; for (let i = 0; i < mb.length; i++) bin += String.fromCharCode(mb[i]);
  return btoa(bin);
}

// Pass-through: model→caller (Azure gives us base64 mu-law, we decode to bytes for paced send)
function base64ULawToMulawBytes(b64) {
  const raw = atob(b64), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Aliases preserved for existing call-sites — they now do native mu-law pass-through
function mulawToBase64PCM16_24k(mb, _ast) { return mulawBytesToBase64ULaw(mb); }
function base64PCM16_24kToMulaw(b64, _ast) { return base64ULawToMulawBytes(b64); }

// ─── Save call record (reused from original) ───

async function saveCallRecord(session, reqId, duration) {
  if (!session.callLogId) {
    console.log(`[${reqId}] ⚠️ No callLogId, skipping save`);
    return;
  }
  if (session._saved) return;
  session._saved = true;

  try {
    const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
    const sdkMod = session._sdkModule || await import('npm:@base44/sdk@0.8.23');
    const appId = Deno.env.get('BASE44_APP_ID');
    const serviceClient = sdkMod.createClient({ appId, asServiceRole: true });
    const rawEndpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT') || '';
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
    // Normalize Azure endpoint (strip trailing slash and /openai/... or /api/projects/... suffix)
    let baseUrl = rawEndpoint.replace(/\/+$/, '');
    const openaiIdx = baseUrl.indexOf('/openai/');
    if (openaiIdx > 0) baseUrl = baseUrl.substring(0, openaiIdx);
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
        const analysisUrl = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
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
        conversation_summary: enrichedSummary || summary || ''
      });
      console.log(`[${reqId}] 💾 Call already ${currentLog.status}, added transcript+analysis: ${session.callLogId}`);
    } else {
      await serviceClient.entities.CallLog.update(session.callLogId, {
        status: 'completed',
        transcript: transcript || '',
        duration: duration,
        call_end_time: new Date().toISOString(),
        lead_status_updated: leadStatus,
        conversation_summary: enrichedSummary || summary || ''
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

    // ===== STEP 4.5: Save VoicemailMessage for personal accounts =====
    if (session._personalMode && session._personalClientId) {
      try {
        // Extract caller name and message from transcript
        const customerLines = session.transcript.filter(t => t.speaker === 'Customer').map(t => t.text);
        const callerName = (() => {
          // Try to find name from transcript — look for common patterns
          for (const line of customerLines) {
            const nameMatch = line.match(/(?:my name is|this is|I am|main|mera naam)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);
            if (nameMatch) return nameMatch[1];
          }
          return '';
        })();

        // Determine category from summary
        const summaryLower = (summary || '').toLowerCase();
        let category = 'unknown';
        if (summaryLower.includes('spam') || summaryLower.includes('telemarketing')) category = 'spam';
        else if (summaryLower.includes('promotional') || summaryLower.includes('offer')) category = 'promotional';
        else if (summaryLower.includes('family') || summaryLower.includes('friend')) category = 'family';
        else if (summaryLower.includes('business') || summaryLower.includes('meeting') || summaryLower.includes('work')) category = 'business';

        // Determine urgency from sentiment + keywords
        let urgency = 'medium';
        if (summaryLower.includes('urgent') || summaryLower.includes('emergency') || summaryLower.includes('important')) urgency = 'urgent';
        else if (sentiment === 'very_positive' || summaryLower.includes('asap')) urgency = 'high';
        else if (category === 'spam' || category === 'promotional') urgency = 'low';

        const messageText = customerLines.join(' ').substring(0, 1000) || summary || 'No message content captured';

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

    // NOTE: Auto-enroll handled by campaignPostCall. streamAudio only owns CallLog + Lead updates.
    // ===== STEP 6: Trigger post-call action extraction (fire-and-forget) =====
    if (transcript.length > 50) {
      serviceClient.functions.invoke('postCallActionExtractor', {
        call_log_id: session.callLogId
      }).then(() => console.log(`[${reqId}] 📋 Action extraction triggered`))
        .catch(e => console.error(`[${reqId}] ⚠️ Action extraction failed: ${e.message}`));
    }

    // NOTE: CampaignLead updates handled by campaignPostCall automation (avoids race conditions).
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

  // Non-WebSocket: Smartflo Dynamic endpoint. Echo call_log_id (custom_identifier) into wss_url
  // so streamAudio can do EXACT CallLog lookup — prevents agent config mixing across concurrent calls.
  if (!isWebSocket) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    let cid = '';
    if (req.method === 'POST') {
      try { const bd = await req.json(); console.log(`[${reqId}] 📨 Dyn POST:`, JSON.stringify(bd)); cid = bd.call_log_id || bd.custom_identifier || bd.callLogId || ''; } catch (_) {}
    } else if (req.method === 'GET') {
      const u = new URL(req.url); cid = u.searchParams.get('call_log_id') || u.searchParams.get('custom_identifier') || '';
    }
    
    let isGemini = false;
    if (cid) {
      try {
        const { createClient } = await import('npm:@base44/sdk@0.8.23');
        const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        const callLog = await svc.entities.CallLog.get(cid);
        if (callLog?.agent_config_cache?.persona?.voice_engine === 'gemini_realtime') {
          isGemini = true;
        }
      } catch (e) {
        console.error(`[${reqId}] ❌ Failed to check voice engine for dynamic endpoint: ${e.message}`);
      }
    }
    
    const endpoint = isGemini ? 'streamAudioGemini' : 'streamAudio';
    const wssUrl = `wss://${host}/functions/${endpoint}${cid ? '?call_log_id=' + encodeURIComponent(cid) : ''}`;
    if (cid) console.log(`[${reqId}] 🔗 wss_url with call_log_id=${cid} routing to ${endpoint}`);
    
    return new Response(JSON.stringify({ sucess: true, wss_url: wssUrl }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  // Extract call_log_id from WebSocket connection URL (set by Dynamic endpoint above)
  const _wsUrl = new URL(req.url);
  const _wsCallLogId = _wsUrl.searchParams.get('call_log_id') || '';

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
    smartfloCallId: null,     // Smartflo REST API call_id (UUID format, different from SIP callSid)
    realtimeWs: null,         // WebSocket connection to Azure Realtime API
    realtimeReady: false,     // Whether session.created has been received
    isSpeaking: false,        // Track if model is currently outputting audio
    _ttsAbort: null,          // AbortController for Azure Speech TTS (hybrid mode)
    chatHistory: [],          // GPT-5-nano conversation history (azure_speech mode)
    tools: [],                // Registered tools (e.g. shopify_order_lookup)
    hasShopify: false,        // Whether Shopify marketplace is connected
    humanTransferNumber: '',  // Intercom/extension for human transfer
    enableAutoTransfer: true, // Whether AI can auto-offer transfers
    agentId: null,            // Resolved Agent.id (for kb_search tool)
    kbFileUri: '',            // Azure Blob URI of agent's KB (signals KB tool availability)
    _realtimeReconnectAttempts: 0,
    _callEnded: false,
    // Per-session audio conversion state (prevents cross-call corruption)
    _audioState: {
      lastUpsampleValue: 0,
      lastDownsampleRemainder: []
    },
    // Buffer for incoming caller media packets while Azure Realtime is initializing
    // (prevents audio loss in the first 1-3 seconds of the call)
    _mediaBuffer: [],
    _mediaBufferMaxBytes: 256 * 1024, // ~16s of mu-law audio at 8kHz, prevents memory bloat
    _mediaBufferBytes: 0,
    _mediaBufferFlushed: false,
    _awaitingOwnerDecision: false,  // Waiting for owner's Telegram button press
    _ownerDecisionExecuted: false,  // Owner decision already applied
    _ownerName: '',                 // Owner's display name for AI instructions
    _greetingSent: false, _phase1Applied: false, _fastConfigReady: false,
    _explicitCallLogId: _wsCallLogId || null  // EXACT call_log_id from wss URL — prevents config mixing across concurrent calls
  };
  if (session._explicitCallLogId) console.log(`[${reqId}] 🔒 Explicit call_log_id: ${session._explicitCallLogId}`);

  // ─── Connect to Azure Realtime API ───
  function connectRealtime() {
    if (session.voiceEngine === 'gemini_realtime') {
      const geminiKey = Deno.env.get('GEMINI_API_KEY');
      if (!geminiKey) { console.error(`[${reqId}] ❌ Missing GEMINI_API_KEY`); return; }
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${geminiKey}`;
      console.log(`[${reqId}] 🔌 Connecting to Gemini Realtime...`);
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        console.log(`[${reqId}] ✅ Gemini Realtime WebSocket connected (attempt ${session._realtimeReconnectAttempts})`);
        session._realtimeReconnectAttempts = 0;
        session._lastRealtimeOpenTs = Date.now();
        // Trigger setup if agent config is ready
        if (session._fastConfigReady) {
           triggerPhase1Greeting();
        }
      };
      ws.onmessage = (event) => {
        try {
          const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
          handleGeminiMessage(JSON.parse(text));
        } catch (err) {
          console.error(`[${reqId}] ❌ Gemini message parse error: ${err.message}`);
        }
      };
      ws.onclose = (event) => {
        console.log(`[${reqId}] 🔴 Gemini Realtime closed: code=${event.code}`);
        session.realtimeReady = false;
        const stableMs = session._lastRealtimeOpenTs ? (Date.now() - session._lastRealtimeOpenTs) : 0;
        if (stableMs > 30000 && session._realtimeReconnectAttempts > 0) session._realtimeReconnectAttempts = 0;
        const RECONNECT_DELAYS_MS = [500, 1500, 3000, 6000, 10000, 15000];
        if (!session._callEnded && session._realtimeReconnectAttempts < RECONNECT_DELAYS_MS.length) {
          const delay = RECONNECT_DELAYS_MS[session._realtimeReconnectAttempts];
          session._realtimeReconnectAttempts++;
          setTimeout(() => { if (!session._callEnded) connectRealtime(); }, delay);
        }
      };
      ws.onerror = () => console.error(`[${reqId}] ❌ Gemini error`);
      session.realtimeWs = ws;
      return;
    }

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
      // Track when we last had a stable connection — used to fully reset backoff
      // for very long-running calls that experience a transient blip after minutes of stability
      session._lastRealtimeOpenTs = Date.now();
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
      console.log(`[${reqId}] 🔴 Azure Realtime closed: code=${event.code} reason=${event.reason} wasClean=${event.wasClean} endpoint=${(realtimeUrl || '').substring(0, 60)} keyLen=${(realtimeKey || '').length}`);
      session.realtimeReady = false;

      // If we had a stable connection for >30s, reset the counter so a transient blip
      // late in the call doesn't immediately exhaust the retry budget.
      const stableMs = session._lastRealtimeOpenTs ? (Date.now() - session._lastRealtimeOpenTs) : 0;
      if (stableMs > 30000 && session._realtimeReconnectAttempts > 0) {
        console.log(`[${reqId}] 🔄 Was stable ${Math.round(stableMs/1000)}s — resetting reconnect counter`);
        session._realtimeReconnectAttempts = 0;
      }

      // Fast first retry to mask transient blips, then exponential backoff
      const RECONNECT_DELAYS_MS = [50, 500, 1500, 3000, 6000, 10000];
      const MAX_RECONNECT = RECONNECT_DELAYS_MS.length;
      if (!session._callEnded && session._realtimeReconnectAttempts < MAX_RECONNECT) {
        const delay = RECONNECT_DELAYS_MS[session._realtimeReconnectAttempts];
        session._realtimeReconnectAttempts++;
        console.log(`[${reqId}] 🔄 Reconnecting (${session._realtimeReconnectAttempts}/${MAX_RECONNECT}) in ${delay}ms...`);
        setTimeout(() => { if (!session._callEnded) connectRealtime(); }, delay);
      } else if (!session._callEnded) {
        console.error(`[${reqId}] ❌ Azure Realtime reconnect exhausted (${MAX_RECONNECT} attempts). Voice is dead.`);
      }
    };

    ws.onerror = (event) => {
      console.error(`[${reqId}] ❌ Azure Realtime error — message=${event?.message || 'unknown'} type=${event?.type || 'unknown'}`);
    };

    session.realtimeWs = ws;
  }

  // ─── Hang up call via Smartflo API ───
  async function hangupCall(reason) {
    console.log(`[${reqId}] 📴 Hanging up: "${reason}", callSid=${session.callSid}, smartfloCallId=${session.smartfloCallId || 'none'}`);
    session._callEnded = true;
    try {
      const tk = await getSmartfloToken();
      if (tk) {
        // The ONLY valid call_id for hangup is the live PBX id from live_calls
        // (e.g. "CAGE011-T8-1780735307.142"). session.callSid / smartfloCallId are
        // rejected with 422 "Invalid Call ID", so we never fall back to them.
        const liveCallId = await findLiveCallId(tk);
        if (liveCallId) {
          const hr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/hangup', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
            body: JSON.stringify({ call_id: liveCallId })
          });
          const hBody = await hr.json().catch(() => ({}));
          const success = hr.ok && hBody.success !== false;
          console.log(`[${reqId}] 📴 Hangup id=${String(liveCallId).substring(0, 40)}: ${hr.status} ${JSON.stringify(hBody).substring(0, 200)}`);
          if (!success) console.error(`[${reqId}] ❌ Hangup failed for call_id=${liveCallId}`);
        } else {
          console.error(`[${reqId}] ⚠️ Hangup skipped — no live call_id resolved from live_calls`);
        }
      } else {
        console.error(`[${reqId}] ⚠️ Smartflo token unavailable for hangup`);
      }
    } catch (e) { console.error(`[${reqId}] ⚠️ Hangup failed: ${e.message}`); }
    if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
  }

  // Helper: find the real PBX call_id from Smartflo live_calls by matching phone numbers.
  // This is the ONLY valid id source for hangup/transfer. Prefers the "Voice Streaming"
  // leg (our AI bridge) and retries briefly until the call appears in live_calls.
  async function findLiveCallId(token, retries = 3) {
    const ce = (session.calleeNumber || '').replace(/\D/g, '').slice(-10);
    const cr = (session.callerNumber || '').replace(/\D/g, '').slice(-10);
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const r = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        });
        if (r.ok) {
          const d = await r.json();
          const calls = Array.isArray(d) ? d : (d.data || []);
          const matches = calls.filter(c => {
            const cn = (c.customer_number || '').replace(/\D/g, '').slice(-10);
            const did = (c.did || '').replace(/\D/g, '').slice(-10);
            return (ce && (cn === ce || did === ce)) || (cr && (cn === cr || did === cr));
          });
          const best = matches.find(c => (c.type || '').toLowerCase().includes('voice streaming')) || matches[0];
          if (best?.call_id) { console.log(`[${reqId}] 🔍 Live call_id: ${best.call_id}`); return best.call_id; }
        }
      } catch (_) {}
      if (attempt < retries - 1) await new Promise(res => setTimeout(res, 700));
    }
    return null;
  }

  function buildGeminiTools() {
    const openaiTools = buildToolDefinitions();
    if (!openaiTools || openaiTools.length === 0) return [];
    return [{
      functionDeclarations: openaiTools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: "OBJECT",
          properties: Object.fromEntries(
            Object.entries(t.parameters.properties).map(([k, v]) => [k, { type: v.type.toUpperCase(), description: v.description, enum: v.enum }])
          ),
          required: t.parameters.required
        }
      }))
    }];
  }

  function buildToolDefinitions() {
    const tools = [];
    // End call tool
    tools.push({type:'function',name:'end_call',description:'End/disconnect the call. Use when: conversation concluded with goodbye, spam declined, or caller asked to end. Say goodbye BEFORE calling this.',parameters:{type:'object',properties:{reason:{type:'string',description:'Brief reason'}},required:['reason']}});
    // Transfer to human agent tool
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

    // ─── Knowledge base search tool (replaces inline KB injection) ───
    if (session.kbFileUri && session.agentId) {
      tools.push({
        type: 'function',
        name: 'search_knowledge_base',
        description: 'Search the business knowledge base (products, pricing, policies, FAQs, services) by keyword. Call this BEFORE answering any specific question about the business — pricing, plans, hours, locations, refund/return policies, product details, packages, terms, processes. Always use this instead of guessing. Pass concise keywords (e.g. "return policy", "pricing diamond plan", "office address Mumbai").',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Concise keyword query — what to search for. Examples: "pricing", "refund policy", "office hours", "delivery time".'
            }
          },
          required: ['query']
        }
      });
      console.log(`[${reqId}] 📚 KB search tool registered (agent=${session.agentId})`);
    }
    session.tools = tools;
    return tools;
  }

  // ─── Execute a tool call from the Realtime API ───
  async function executeToolCall(callId, functionName, argsStr) {
    console.log(`[${reqId}] 🔧 Tool call: ${functionName}(${argsStr.substring(0, 200)})`);
    let result = { error: `Unknown tool: ${functionName}` };
    // ─── End call ───
    if (functionName === 'end_call') {
      const a = JSON.parse(argsStr);
      result = { success: true };
      if (session.voiceEngine === 'gemini_realtime') { sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } }); }
      else { sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }); }
      session.transcript.push({ speaker: 'System', text: `[Call ended: ${a.reason}]` });
      // Short delay to let the goodbye audio play, then hang up
      setTimeout(() => hangupCall(a.reason || 'ended'), 1500);
      return;
    }
    // ─── Transfer to human agent ───
    if (functionName === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const args = JSON.parse(argsStr);
        const reason = args.reason || 'customer requested';
        console.log(`[${reqId}] 📞 TRANSFER TO HUMAN: reason="${reason}", intercom=${session.humanTransferNumber}, call_sid=${session.callSid}`);

        // Use cached Smartflo JWT (avoids account lockout from repeated logins)
        const smartfloToken = await getSmartfloToken();
        if (!smartfloToken) {
          result = { error: 'Transfer not available — Smartflo authentication failed' };
          sendToRealtime({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) }
          });
          sendToRealtime({ type: 'response.create' });
          return;
        }
        {
          // Use live_calls to find the real PBX call_id for transfer (REQUIRED — call_sid
          // is rejected with 422 "Invalid Call ID"). No fallback: abort if we can't resolve it.
          const liveCallId = await findLiveCallId(smartfloToken);
          if (!liveCallId) {
            console.error(`[${reqId}] ❌ Transfer aborted — no live call_id resolved from live_calls`);
            result = { error: 'Transfer not available — could not locate the live call. Inform the customer and offer to take a message.' };
            sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
            sendToRealtime({ type: 'response.create' });
            return;
          }

          const transferBody = { type: 4, call_id: liveCallId, intercom: String(session.humanTransferNumber).trim() };
          console.log(`[${reqId}] 📞 Transfer body: ${JSON.stringify(transferBody)}`);

          const transferResp = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${smartfloToken}` },
            body: JSON.stringify(transferBody)
          });

          const transferData = await transferResp.json().catch(() => ({}));
          console.log(`[${reqId}] 📞 Transfer API response: HTTP ${transferResp.status}`, JSON.stringify(transferData));

          // Smartflo can return HTTP 200 with success:false in body — treat that as failure
          const smartfloSuccess = transferResp.ok && transferData.success !== false && !transferData.error;

          if (smartfloSuccess) {
            result = { success: true, message: 'Call is being transferred to a human agent. The customer will be connected shortly.' };

            // Update CallLog with transfer info (fire-and-forget)
            if (session.callLogId) {
              const { createClient } = await import('npm:@base44/sdk@0.8.23');
              const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
              svc.entities.CallLog.update(session.callLogId, {
                transferred_to: `Human agent (intercom: ${session.humanTransferNumber}, reason: ${reason})`
              }).catch(() => {});
            }

            // Add to transcript
            session.transcript.push({ speaker: 'System', text: `[Call transferred to human agent. Reason: ${reason}]` });
          } else {
            const errMsg = transferData.message || transferData.error || transferData.detail || `HTTP ${transferResp.status}`;
            result = { error: `Transfer to extension ${session.humanTransferNumber} failed: ${errMsg}. Please inform the customer you cannot transfer and offer to take a message instead.` };
            console.error(`[${reqId}] ❌ Transfer FAILED (HTTP ${transferResp.status}): ${errMsg}`, JSON.stringify(transferData));
          }
        }
      } catch (err) {
        console.error(`[${reqId}] ❌ Transfer error: ${err.message}`);
        result = { error: `Transfer failed: ${err.message}` };
      }

      // Send result back to Realtime API
      if (session.voiceEngine === 'gemini_realtime') { sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } }); }
      else { sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }); sendToRealtime({ type: 'response.create' }); }
      return;
    }

    // ─── Knowledge base search ───
    if (functionName === 'search_knowledge_base' && session.agentId && session.kbFileUri) {
      try {
        const args = JSON.parse(argsStr);
        const { createClient } = await import('npm:@base44/sdk@0.8.23');
        const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        const kbResp = await svc.functions.invoke('kbSearch', {
          agent_id: session.agentId, query: args.query || '', top_k: 3, _internal: true
        });
        const data = kbResp?.data || {};
        if (data.success && Array.isArray(data.results) && data.results.length > 0) {
          const passages = data.results.map((r, i) => `[Passage ${i + 1}]\n${r.content}`).join('\n\n');
          result = { passages, count: data.results.length };
        } else {
          result = { passages: '', count: 0, message: 'No relevant information found in knowledge base.' };
        }
        console.log(`[${reqId}] 📚 KB search "${(args.query || '').substring(0, 50)}" → ${data.results?.length || 0} passages`);
      } catch (err) {
        console.error(`[${reqId}] ❌ KB search error: ${err.message}`);
        result = { error: 'Knowledge base search failed', passages: '' };
      }
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
      sendToRealtime({ type: 'response.create' });
      return;
    }

    if (functionName === 'shopify_lookup' && session.clientId) {
      try {
        const args = JSON.parse(argsStr);
        const { createClient } = await import('npm:@base44/sdk@0.8.23');
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
    if (session.voiceEngine === 'gemini_realtime') {
      sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } });
    } else {
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
      sendToRealtime({ type: 'response.create' });
    }
  }

  function formatShopifyOrder(o) {
    const t = (o.fulfillments||[]).filter(f=>f.tracking_number).map(f=>({tracking_number:f.tracking_number,company:f.tracking_company,url:f.tracking_url,status:f.shipment_status||f.status}));
    return { order_number:o.name||`#${o.order_number}`, date:o.created_at?.substring(0,10), status:o.cancelled_at?'cancelled':(o.fulfillment_status||'unfulfilled'), payment:o.financial_status, total:`${o.currency} ${o.total_price}`, items:(o.line_items||[]).map(li=>`${li.title} x${li.quantity}`).join(', '), tracking:t.length>0?t:'no tracking yet', shipping_city:o.shipping_address?.city||'' };
  }

  // ─── PHASE 1: Speak greeting IMMEDIATELY with minimal prompt (saves ~2-3s) ───
  function triggerPhase1Greeting() {
    if (session._greetingSent || session._phase1Applied) return;
    // Guard: skip if Realtime API already has an active response (caller spoke first triggering VAD)
    if (session._responseInFlight) { console.log(`[${reqId}] 🛡️ P1: response already in flight — skipping`); session._greetingSent = true; session._phase1Applied = true; applySessionConfig(); return; }
    const greeting = session.greetingMessage || '';
    if (!greeting) { console.log(`[${reqId}] ⚡ No custom greeting — skipping Phase 1`); applySessionConfig(); return; }
    session._phase1Applied = true;
    session._greetingSent = true;
    session.transcript.push({ speaker: 'AI', text: greeting });
    const isHybrid = session.voiceEngine === 'azure_speech';
    if (isHybrid) {
      console.log(`[${reqId}] ⚡ P1 hybrid greeting: "${greeting.substring(0, 60)}"`);
      session.chatHistory = [{ role: 'system', content: 'You are a helpful AI voice assistant.' }, { role: 'assistant', content: greeting }];
      synthesizeWithAzureSpeech(greeting);
      applySessionConfig(); // Phase 2 immediately (hybrid doesn't need delay)
    } else if (session.voiceEngine === 'gemini_realtime') {
      console.log(`[${reqId}] ⚡ P1 gemini realtime greeting: "${greeting.substring(0, 60)}" (voice=${session.voiceType})`);
      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
      const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}.\n`;
      const noiseHandling = `\n[AUDIO RULES] You are on a PHONE CALL in India. Only respond to CLEAR human speech. IGNORE background noise, garbled audio, TV, traffic. NEVER end a call based on noise. Keep replies SHORT (1-2 sentences).\n`;
      let transferInstr = '';
      if (session.humanTransferNumber && session.enableAutoTransfer) transferInstr = `\n\nUse transfer_to_human when caller explicitly asks for a human.`;
      const tools = buildGeminiTools();
      const setupMsg = {
        setup: {
          model: "models/gemini-2.0-flash-lite-preview-02-27",
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceType || "Aoede" } } }
          },
          systemInstruction: { parts: [{ text: timeInjection + noiseHandling + session.systemPrompt + transferInstr }] }
        }
      };
      if (tools.length > 0) setupMsg.setup.tools = tools;
      sendToRealtime(setupMsg);
      session._voiceLocked = true;
      session._phase2Sent = true;

      const greetingMsg = greeting ? `[SYSTEM: Say this exact greeting: "${greeting}"]` : `[SYSTEM: The call just connected. Greet warmly.]`;
      sendToRealtime({ clientContent: { turns: [{ role: 'user', parts: [{ text: greetingMsg }] }], turnComplete: true } });
    } else {
      console.log(`[${reqId}] ⚡ P1 realtime greeting: "${greeting.substring(0, 60)}" (voice=${session.voiceType})`);
      // VOICE LOCK: send the FULL Phase-2 config (voice + final instructions + tools) in a
      // SINGLE session.update BEFORE any assistant audio is generated. After this, Azure
      // refuses voice changes ("cannot_update_voice"), so we must never send `voice` again.
      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
      const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}.\n`;
      const noiseHandling = `\n[AUDIO RULES] You are on a PHONE CALL in India. Only respond to CLEAR human speech. IGNORE background noise, garbled audio, TV, traffic, or random short syllables. NEVER end a call based on noise. Keep replies SHORT (1-2 sentences).\n`;
      let transferInstr = '';
      if (session.humanTransferNumber && session.enableAutoTransfer) {
        transferInstr = `\n\nYou can transfer to a human via transfer_to_human when the caller explicitly asks or you cannot resolve their issue. Always inform the caller before transferring.`;
      }
      const tools = buildToolDefinitions();
      // NATIVE TELEPHONY FORMAT: g711_ulaw 8kHz both ways — eliminates resampling artifacts.
      // Azure Realtime supports g711_ulaw as input_audio_format AND output_audio_format,
      // matching Smartflo's native mu-law/8000 spec exactly. ZERO conversion = clean audio.
      const fullCfg = {
        modalities: ['text', 'audio'],
        voice: session.voiceType,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions: timeInjection + noiseHandling + session.systemPrompt + transferInstr
      };
      if (tools.length > 0) { fullCfg.tools = tools; fullCfg.tool_choice = 'auto'; }
      sendToRealtime({ type: 'session.update', session: fullCfg });
      session._voiceLocked = true;
      session._phase2Sent = true;
      console.log(`[${reqId}] 🔒 Voice locked: ${session.voiceType}, prompt=${session.systemPrompt.length}ch, tools=${tools.length}`);

      // Now inject the greeting and trigger response.
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: Say this exact greeting: "' + greeting + '"]' }] } });
      sendToRealtime({ type: 'response.create' });
    }
  }

  // ─── PHASE 2 / Full config: Apply complete system prompt, KB, tools ───
  function applySessionConfig() {
    // VOICE LOCK GUARD: triggerPhase1Greeting() already sent the full Phase-2 config
    // (voice + instructions + tools) as a single session.update BEFORE assistant audio
    // started. Sending another session.update with `voice` would be rejected by Azure
    // ("cannot_update_voice"). Skip entirely for realtime mode in that case.
    if (session._phase2Sent && session.voiceEngine !== 'azure_speech') {
      console.log(`[${reqId}] ✅ Phase 2 already sent in greeting — skipping redundant config`);
      return;
    }
    const isHybrid = session.voiceEngine === 'azure_speech';
    const tools = buildToolDefinitions();
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}. Use this to compute relative times.\n`;
    const noiseHandling = `\n[AUDIO RULES] CRITICAL NOISE HANDLING FOR PHONE CALLS:\n(1) You are on a PHONE CALL in India where callers may be outdoors, in traffic, or in crowded places.\n(2) ONLY respond to CLEAR, DIRECTED human speech. If you receive garbled, unclear, or very short utterances (single syllables, repeated nonsense), DO NOT respond to them. Instead STAY SILENT and wait for the caller to speak clearly.\n(3) If you hear what sounds like background noise being transcribed as words (e.g., random syllables, repeated "bye-bye", wind sounds), IGNORE it completely. Do NOT say goodbye or end the call based on noise.\n(4) Only respond when you hear a COMPLETE, MEANINGFUL sentence or question from the caller.\n(5) If audio quality is consistently poor, say ONCE: "Aapki awaaz thodi unclear aa rahi hai, kya aap zara clearly bol sakte hain?" then wait.\n(6) Keep responses SHORT (1-2 sentences) to minimize interruption.\n(7) NEVER end the call based on a single unclear word. Only use end_call when there has been a clear, mutual goodbye exchange with 2+ clear sentences from the caller.\n`;
    let transferInstructions = '';
    if (session.humanTransferNumber && session.enableAutoTransfer) {
      transferInstructions = `\n\n--- HUMAN AGENT TRANSFER (AVAILABLE) ---\nYou can transfer this call to a human agent using the transfer_to_human tool.\nWHEN TO TRANSFER:\n- Customer EXPLICITLY asks to speak to a human/real person/manager\n- Customer is clearly very frustrated and you cannot resolve their issue after 2+ attempts\n- The query requires actions you cannot perform (account changes, payments, etc.)\nWHEN NOT TO TRANSFER:\n- Customer is just asking questions you can answer\n- Customer is mildly confused — try to help first\n- Never transfer without telling the customer first\nBEFORE TRANSFERRING: Always say something like "Let me connect you to a human agent who can help you better. Please hold for a moment."`;
    }
    // Prevent double greeting after Phase 2 upgrade
    const greetingGuard = session._greetingSent ? '\n\nIMPORTANT: You have ALREADY greeted the customer. Do NOT greet again. Wait for the customer to speak next.' : '';
    // CRITICAL: keep g711_ulaw end-to-end. Switching to pcm16 here while Smartflo still
    // streams mu-law bytes causes Azure VAD to never trigger → 20s of silence until reconnect.
    const sessionConfig = { input_audio_format: 'g711_ulaw', output_audio_format: 'g711_ulaw', input_audio_transcription: { model: 'whisper-1', language: 'hi' }, turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 700 } };
    if (session.voiceEngine === 'gemini_realtime') {
      const gTools = buildGeminiTools();
      const setupMsg = { setup: { model: "models/gemini-2.0-flash-lite-preview-02-27", generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceType || "Aoede" } } } }, systemInstruction: { parts: [{ text: timeInjection + noiseHandling + session.systemPrompt + transferInstructions + greetingGuard }] } } };
      if (gTools.length > 0) setupMsg.setup.tools = gTools;
      sendToRealtime(setupMsg);
      session._voiceLocked = true;
      session._phase2Sent = true;
    } else {
      if (isHybrid) {
        sessionConfig.instructions = 'You are a transcription-only assistant. Do not respond.';
        sessionConfig.modalities = ['text']; sessionConfig.voice = 'alloy';
        session.chatHistory = [{ role: 'system', content: timeInjection + noiseHandling + session.systemPrompt + transferInstructions + greetingGuard }];
        if (session._greetingSent && session.greetingMessage) session.chatHistory.push({ role: 'assistant', content: session.greetingMessage });
      } else {
        sessionConfig.modalities = ['text', 'audio'];
        sessionConfig.instructions = timeInjection + noiseHandling + session.systemPrompt + transferInstructions + greetingGuard;
        sessionConfig.input_audio_format = 'g711_ulaw';
        sessionConfig.output_audio_format = 'g711_ulaw';
        if (!session._voiceLocked) { sessionConfig.voice = session.voiceType; session._voiceLocked = true; }
      }
      if (tools.length > 0) { sessionConfig.tools = tools; sessionConfig.tool_choice = 'auto'; }
      sendToRealtime({ type: 'session.update', session: sessionConfig });
    }
    if (!session._greetingSent) triggerGreeting();
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
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1', language: 'hi' },
          turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 700 }
        };
        if (isHybrid) {
          sessionConfig.instructions = 'You are a transcription-only assistant. Do not respond.';
          sessionConfig.modalities = ['text'];
          sessionConfig.voice = 'alloy';
        } else {
          sessionConfig.modalities = ['text', 'audio'];
          sessionConfig.instructions = timeInjection + session.systemPrompt;
          // Set voice on reconnect (new connection = new session = needs voice).
          sessionConfig.voice = session.voiceType;
          sessionConfig.input_audio_format = 'g711_ulaw';
          sessionConfig.output_audio_format = 'g711_ulaw';
          session._voiceLocked = true;
        }
        if (tools.length > 0) { sessionConfig.tools = tools; sessionConfig.tool_choice = 'auto'; }
        sendToRealtime({ type: 'session.update', session: sessionConfig });
      } else if (session._fastConfigReady) {
        // Fast config ready (greeting + voice extracted) — fire greeting immediately
        console.log(`[${reqId}] ⚡ Fast config ready before Realtime — triggering Phase 1 greeting`);
        triggerPhase1Greeting();
      } else {
        // Realtime connected first — send minimal config WITHOUT voice/modalities.
        // We deliberately DO NOT set `voice` here. The voice will be set exactly ONCE
        // in triggerPhase1Greeting() / applySessionConfig() once agent config arrives,
        // and the `_voiceLocked` flag will prevent any later re-send (Azure rejects
        // voice changes once assistant audio is present).
        sendToRealtime({ type: 'session.update', session: {
          input_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 700 }
        }});
        console.log(`[${reqId}] 📤 Minimal pre-config sent (g711_ulaw, no voice yet — waiting for agent config)`);
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
      const mulawBytes = base64PCM16_24kToMulaw(msg.delta, session._audioState);

      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        sendMulawToSmartflo(mulawBytes);
      }
      return;
    }

    if (type === 'response.audio.done') { session.isSpeaking = false; return; }
    if (type === 'response.created') { session._responseInFlight = true; return; }
    if (type === 'response.done') { session._responseInFlight = false; return; }

    // ─── Transcription of user's speech ───
    if (type === 'conversation.item.input_audio_transcription.failed') { console.error(`[${reqId}] ❌ STT fail`); return; }

    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        // Noise filter: reject Whisper hallucinations from background noise
        const clean = text.toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g, '').trim();
        const wc = clean.split(/\s+/).filter(w => w).length;
        if (wc <= 2 && /^(bye[\s-]*bye|bye|ba+h*|hmm+|uh+|um+|ah+|oh+|huh|tch|shh|ss+|mm+|nah+|ha+)$/i.test(clean)) {
          console.log(`[${reqId}] 🔇 Noise: "${text}"`); return;
        }
        console.log(`[${reqId}] 🗣️ Customer: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'Customer', text });
        if (session.voiceEngine === 'azure_speech') { generateGpt5NanoResponse(text); }
        // Mid-call: after 2nd customer message, classify reason & send Telegram buttons
        // Send earlier so owner has more time to respond while call is active
        if (session._personalMode && session._personalClientId && !session._midCallTgSent) {
          const custCount = session.transcript.filter(t => t.speaker === 'Customer').length;
          if (custCount >= 2) { session._midCallTgSent = true; sendMidCallTelegramUpdate(); }
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

    if (type === 'input_audio_buffer.speech_started') {
      // Caller interrupted — flush both Smartflo's playback buffer AND our local pacer queue
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) { smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid })); }
      clearOutQueue();
      if (session._ttsAbort) { session._ttsAbort.abort(); session._ttsAbort = null; }
      session.isSpeaking = false; return;
    }
    if (type === 'input_audio_buffer.speech_stopped') return;
    if (type === 'response.function_call_arguments.done') { executeToolCall(msg.call_id, msg.name, msg.arguments || '{}'); return; }
    if (type === 'error') { console.error(`[${reqId}] ❌ Realtime error:`, JSON.stringify(msg.error || msg)); return; }
  }

  function handleGeminiMessage(msg) {
    if (msg.setupComplete) {
      console.log(`[${reqId}] ✅ Gemini setup complete`);
      session.realtimeReady = true;
      return;
    }
    if (msg.serverContent) {
      const modelTurn = msg.serverContent.modelTurn;
      if (modelTurn) {
        for (const part of modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
             session.isSpeaking = true;
             const mulawBytes = base64PCM16_24kToMulaw(part.inlineData.data, session._audioState);
             if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
               sendMulawToSmartflo(mulawBytes);
             }
          }
          if (part.text) {
             console.log(`[${reqId}] 🤖 AI: "${part.text.substring(0, 100)}"`);
             session.transcript.push({ speaker: 'AI', text: part.text.trim() });
             if (session._personalMode && session._personalClientId && !session._midCallTgSent) {
               const aiCount = session.transcript.filter(t => t.speaker === 'AI').length;
               if (aiCount >= 3) { session._midCallTgSent = true; sendMidCallTelegramUpdate(); }
             }
          }
          if (part.functionCall) {
             const args = JSON.stringify(part.functionCall.args || {});
             executeToolCall(part.functionCall.id, part.functionCall.name, args);
          }
        }
      }
      if (msg.serverContent.turnComplete) {
        session.isSpeaking = false;
        session._responseInFlight = false;
      }
      if (msg.serverContent.interrupted) {
        if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
          smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
        }
        session.isSpeaking = false;
      }
    }
    if (msg.toolCall) {
       for (const call of msg.toolCall.functionCalls || []) {
           const args = JSON.stringify(call.args || {});
           executeToolCall(call.id, call.name, args);
       }
    }
    if (msg.error) {
       console.error(`[${reqId}] ❌ Gemini error:`, JSON.stringify(msg.error));
    }
  }

  // ─── Mid-call Telegram: classify caller + send interactive action buttons ───
  async function sendMidCallTelegramUpdate() {
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!tgT || !session.callLogId) return;
    try {
      const { createClient: cc } = await import('npm:@base44/sdk@0.8.23');
      const svc = cc({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      const cl = await svc.entities.Client.get(session._personalClientId);
      if (!cl?.telegram_connected || !cl?.telegram_chat_id || cl.dnd_enabled || cl.owner_notification_channel !== 'telegram') return;
      const convo = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
      let bUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
      const oI = bUrl.indexOf('/openai/'); if (oI > 0) bUrl = bUrl.substring(0, oI);
      const pI = bUrl.indexOf('/api/projects'); if (pI > 0) bUrl = bUrl.substring(0, pI);
      const dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT'), ak = Deno.env.get('AZURE_OPENAI_KEY');
      const res = await fetch(`${bUrl}/openai/deployments/${dep}/chat/completions?api-version=2024-08-01-preview`, {
        method: 'POST', headers: { 'api-key': ak, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: 'Classify this live call. Return JSON: {"reason":"label","emoji":"1 emoji","detail":"1 sentence","urgency":"low|medium|high|urgent","caller_name":"name if said"}\nLabels: Family Call, Emergency, Friend, Business Enquiry, Job Opening, Delivery, Promotional, Spam, Loan/Insurance, Government, Medical, Wrong Number, Personal Request, Unknown' },
          { role: 'user', content: convo }
        ], max_completion_tokens: 100, response_format: { type: "json_object" } })
      });
      if (!res.ok) return;
      const d = await res.json(), r = JSON.parse(d.choices?.[0]?.message?.content || '{}');
      session._midCallReason = r.reason || 'Unknown';
      session._midCallCallerName = r.caller_name || '';
      const ue = r.urgency === 'urgent' ? ' 🚨' : r.urgency === 'high' ? ' ⚡' : '';
      // Use trusted contact name if available, then AI-detected name, then number
      let midCallName = '';
      let midCallType = '';
      if (session._isTrustedCaller && session._trustedContactName) {
        midCallName = session._trustedContactName;
        midCallType = '👤 Saved Contact';
      } else if (r.caller_name) {
        midCallName = r.caller_name;
      }
      const callerLabel = midCallName || session.callerNumber || 'Unknown';
      const clId = session.callLogId;
      const typeLine = midCallType ? `\n🏷️ ${midCallType}` : '';
      const m = `${r.emoji || '📞'} <b>Live Call — What should I do?</b>${ue}\n\n📱 From: <b>${callerLabel}</b>${midCallName && session.callerNumber ? '\n📞 ' + session.callerNumber : ''}${typeLine}\n📋 <b>${r.reason || 'Unknown'}</b>${r.detail ? '\n💬 ' + r.detail : ''}\n\n👇 <b>Choose action (AI is holding the caller):</b>`;
      const kb = { inline_keyboard: [
        [{ text: '📞 Transfer to Me', callback_data: `decision:${clId}:transfer` }, { text: '⏰ Call Back', callback_data: `decision:${clId}:callback` }],
        [{ text: '📝 Take Message', callback_data: `decision:${clId}:take_message` }, { text: '🚫 Block/End', callback_data: `decision:${clId}:block` }]
      ]};
      fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: m, parse_mode: 'HTML', reply_markup: kb })
      }).then(x => x.json()).then(x => {
        console.log(`[${reqId}] 📱 Mid-call TG buttons: ${r.reason}, ok=${x.ok}`);
        if (x.ok) { session._awaitingOwnerDecision = true; pollOwnerDecision(svc); }
      }).catch(() => {});
    } catch (e) { console.error(`[${reqId}] ⚠️ Mid-call TG: ${e.message}`); }
  }

  // ─── Poll CallDecision entity for owner's Telegram button press ───
  async function pollOwnerDecision(svc) {
    if (!session.callLogId || !session._personalClientId) return;
    let polls = 0;
    const iv = setInterval(async () => {
      polls++;
      if (polls > 60 || session._callEnded || session._ownerDecisionExecuted) {
        clearInterval(iv);
        if (polls > 60) { session._awaitingOwnerDecision = false; console.log(`[${reqId}] ⏰ Owner decision timeout`); }
        return;
      }
      try {
        const decs = await svc.entities.CallDecision.filter({ call_log_id: session.callLogId, status: 'pending' });
        const dec = decs.find(d => d.custom_message !== '__AWAITING_TIME__' && d.custom_message !== '__AWAITING_MESSAGE__');
        if (!dec) return;
        clearInterval(iv);
        session._awaitingOwnerDecision = false;
        session._ownerDecisionExecuted = true;
        await svc.entities.CallDecision.update(dec.id, { status: 'delivered' });
        console.log(`[${reqId}] ✅ Owner decision: ${dec.decision}${dec.custom_message ? ' — ' + dec.custom_message : ''}`);
        executeOwnerDecision(dec);
      } catch (e) { console.error(`[${reqId}] ⚠️ Poll: ${e.message}`); }
    }, 2000);
  }

  // ─── Execute owner's Telegram decision on the live call ───
  function executeOwnerDecision(dec) {
    const ownerName = session._ownerName || 'Sir';
    let inst = '';
    if (dec.decision === 'transfer') {
      inst = session.humanTransferNumber
        ? `[OWNER INSTRUCTION — EXECUTE IMMEDIATELY] ${ownerName} ji ne aapka call transfer karne ke liye bola hai. Caller ko HINDI mein boliye: "Sir, ${ownerName} ji ne aapka call apne paas transfer karne ke liye bola hai, aap kuch second hold kariye main aapka call transfer kar rahi hu." Phir TURANT transfer_to_human tool use karke call transfer karo.`
        : `[OWNER INSTRUCTION — EXECUTE IMMEDIATELY] ${ownerName} ji aapko jald call back karenge. Caller ko HINDI mein boliye: "Sir, ${ownerName} ji abhi aapka call le rahe hain, wo aapko turant is number par call back karenge."`;
    } else if (dec.decision === 'callback') {
      const t = dec.callback_time || dec.custom_message || 'kuch der mein';
      inst = `[OWNER INSTRUCTION — EXECUTE IMMEDIATELY] ${ownerName} ji ne kaha hai ki wo caller ko call back karenge. Caller ko HINDI mein boliye: "Sir, maine ${ownerName} ji ko aapke call ke baare mein bata diya hai aur unhone kaha hai ki wo aapko ${t} mein call back kar rahe hain. Kya aap kuch aur message dena chahenge unke liye?"`;
    } else if (dec.decision === 'take_message') {
      inst = `[OWNER INSTRUCTION — EXECUTE IMMEDIATELY] ${ownerName} ji abhi busy hain aur unhone message lene ke liye bola hai. Caller ko HINDI mein boliye: "Sir, ${ownerName} ji abhi busy hain, unhone mujhe aapka message lene ke liye bola hai. Aap bataiye aapka kya kaam tha, main unhe convey kar dungi." Phir caller ka naam, purpose aur poora message note karo.`;
    } else if (dec.decision === 'block') {
      inst = `[OWNER INSTRUCTION — EXECUTE IMMEDIATELY] ${ownerName} ji ne call end karne ke liye bola hai. Caller ko HINDI mein politely boliye: "Sir, ${ownerName} ji abhi available nahi hain. Aapka call ke liye dhanyavaad. Namaste." Phir call khatam karo.`;
    } else if (dec.custom_message) {
      inst = `[OWNER INSTRUCTION — EXECUTE IMMEDIATELY] ${ownerName} ji ne yeh message bheja hai: "${dec.custom_message}". Isko caller ko HINDI mein naturally relay karo.`;
    }
    if (!inst) return;
    console.log(`[${reqId}] 🎯 Executing: ${dec.decision} (owner: ${ownerName})`);
    if (session.voiceEngine === 'azure_speech') { generateGpt5NanoResponse(inst); }
    else {
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: inst }] } });
      // Guard: only send response.create if no response is currently in flight
      if (!session._responseInFlight) sendToRealtime({ type: 'response.create' });
      else console.log(`[${reqId}] 🛡️ Owner decision queued — response in flight, waiting`);
    }
  }

  // ─── Trigger initial greeting so the AI speaks first (guarded against double-fire) ───
  function triggerGreeting() {
    if (session._greetingSent) { console.log(`[${reqId}] 🛡️ Greeting already sent — skipping`); return; }
    // Guard: if a response is already in flight (e.g. caller spoke before agent config loaded
    // and triggered an auto-response from VAD), don't queue another — that would cause
    // "conversation_already_has_active_response" error from the Realtime API.
    if (session._responseInFlight) { console.log(`[${reqId}] 🛡️ Response already in flight — skipping greeting trigger`); session._greetingSent = true; return; }
    session._greetingSent = true;
    const isHybrid = session.voiceEngine === 'azure_speech';
    const greeting = session.greetingMessage || '';

    if (session.voiceEngine === 'gemini_realtime') {
      if (greeting) session.transcript.push({ speaker: 'AI', text: greeting });
      const greetingMsg = greeting ? `[SYSTEM: Say this exact greeting to the customer: "${greeting}"]` : `[SYSTEM: The call just connected. Greet the customer warmly as your opening line. Do not wait for them to speak first.]`;
      sendToRealtime({ clientContent: { turns: [{ role: 'user', parts: [{ text: greetingMsg }] }], turnComplete: true } });
    } else if (isHybrid) {
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

  // ─── Send mu-law to Smartflo with REAL-TIME 20ms PACING ───
  // Smartflo expects audio to arrive at real-time playback speed (one 20ms frame every 20ms).
  // Bursting an entire utterance instantly overflows Smartflo's playback buffer → freezing/stuttering.
  // We queue and drain at exactly 20ms intervals = 160 mu-law bytes per frame (8kHz × 20ms × 1 byte).
  // CRITICAL: NEVER pad with silence (0xFF) mid-speech — that injects audible gaps. Any leftover
  // bytes < 160 are held in the queue for the next packet.
  session._outQueue = session._outQueue || new Uint8Array(0);
  session._outTimer = session._outTimer || null;
  session._outNextDueMs = session._outNextDueMs || 0;

  function enqueueMulawForSmartflo(mulawBytes) {
    // Append to per-session queue
    const merged = new Uint8Array(session._outQueue.length + mulawBytes.length);
    merged.set(session._outQueue, 0); merged.set(mulawBytes, session._outQueue.length);
    session._outQueue = merged;
    if (!session._outTimer) startOutPacer();
  }

  function startOutPacer() {
    const FRAME_BYTES = 160; // 20ms @ 8kHz mu-law
    const FRAME_MS = 20;
    session._outNextDueMs = Date.now();
    const tick = () => {
      if (session._callEnded || smartfloSocket.readyState !== WebSocket.OPEN) {
        session._outTimer = null; return;
      }
      // Drain all frames whose play-time has arrived (catch-up if event-loop was busy)
      while (session._outQueue.length >= FRAME_BYTES && Date.now() >= session._outNextDueMs) {
        const frame = session._outQueue.slice(0, FRAME_BYTES);
        session._outQueue = session._outQueue.slice(FRAME_BYTES);
        if (session.streamSid) {
          smartfloSocket.send(JSON.stringify({
            event: 'media', streamSid: session.streamSid,
            media: { payload: uint8ToBase64(frame) }
          }));
        }
        session._outNextDueMs += FRAME_MS;
      }
      // If we drained everything and have no leftover, stop the pacer until next audio arrives
      if (session._outQueue.length < FRAME_BYTES && !session.isSpeaking) {
        session._outTimer = null; return;
      }
      session._outTimer = setTimeout(tick, 5); // 5ms granularity for accurate pacing
    };
    session._outTimer = setTimeout(tick, 0);
  }

  // Called by interrupt handler to instantly drop queued AI audio when caller speaks
  function clearOutQueue() {
    session._outQueue = new Uint8Array(0);
    if (session._outTimer) { clearTimeout(session._outTimer); session._outTimer = null; }
  }

  // Backward-compatible name used elsewhere in this file
  function sendMulawToSmartflo(mulawBytes) { enqueueMulawForSmartflo(mulawBytes); }

  async function synthesizeWithAzureSpeech(text) {
    const speechKey = Deno.env.get('AZURE_SPEECH_KEY'), speechRegion = Deno.env.get('AZURE_SPEECH_REGION');
    if (!speechKey || !speechRegion) { console.error(`[${reqId}] ❌ Missing TTS keys`); return; }
    const xmlLang = /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-IN';
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'><voice name='${session.voiceType}'>${escaped}</voice></speak>`;
    const controller = new AbortController(); session._ttsAbort = controller; session.isSpeaking = true;
    try {
      const response = await fetch(`https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': speechKey, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'raw-8khz-8bit-mono-mulaw' }, body: ssml, signal: controller.signal
      });
      if (!response.ok) { console.error(`[${reqId}] ❌ TTS error: ${response.status}`); session.isSpeaking = false; return; }
      const audioBuffer = new Uint8Array(await response.arrayBuffer());
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        for (let i = 0; i < audioBuffer.length; i += 1600) {
          if (controller.signal.aborted) break;
          let chunk = audioBuffer.slice(i, Math.min(i + 1600, audioBuffer.length));
          if (chunk.length % 160 !== 0) { const p = new Uint8Array(Math.ceil(chunk.length/160)*160); p.set(chunk); p.fill(0xFF,chunk.length); chunk = p; }
          smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
        }
      }
    } catch (err) { if (err.name !== 'AbortError') console.error(`[${reqId}] ❌ TTS failed: ${err.message}`); }
    finally { session.isSpeaking = false; session._ttsAbort = null; }
  }

  const cleanTextForTTS = t => t.replace(/\*\*([^*]+)\*\*/g,'$1').replace(/\*([^*]+)\*/g,'$1').replace(/__([^_]+)__/g,'$1').replace(/_([^_]+)_/g,'$1').replace(/#{1,6}\s*/g,'').replace(/```[\s\S]*?```/g,'').replace(/`([^`]+)`/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,'').replace(/[😊🙏👋✅❌🎯📋🕐⚠️💡🔊🎙️]/gu,'').replace(/\n{2,}/g,'. ').replace(/\n/g,' ').replace(/\s{2,}/g,' ').trim();

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
  // Uses pre-warmed SDK + CallLog data from smartfloSocket.onopen for speed
  async function loadAgentConfig() {
   const t0 = Date.now();
   try {
      // Re-use pre-warmed service client, or create fresh
      if (!session._sdkModule) session._sdkModule = await import('npm:@base44/sdk@0.8.23');
      const svc = session._warmSvc || session._sdkModule.createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      let callLog = null;
      // ═══ EXACT LOOKUP — prevents agent config mixing across concurrent calls ═══
      const explicitId = session._explicitCallLogId || session._smartfloCustomIdentifier || null;
      if (explicitId) {
        try {
          const direct = session._warmExplicitCallLog || await svc.entities.CallLog.get(explicitId);
          if (direct?.client_id) {
            if (direct.stream_sid && session.streamSid && direct.stream_sid !== session.streamSid) { console.error(`[${reqId}] 🚨 CallLog ${explicitId} claimed by ${direct.stream_sid} — refusing to mix`); return; }
            callLog = direct; console.log(`[${reqId}] ✅ EXACT id=${explicitId} client=${direct.client_id}`);
          }
        } catch (e) { console.error(`[${reqId}] ⚠️ Exact fetch failed: ${e.message}`); }
      }
      const cutoff = new Date(Date.now() - 120000).toISOString();
      const cleanCallee = session.calleeNumber ? session.calleeNumber.replace(/[^0-9]/g, '') : '';
      const cleanCaller = session.callerNumber ? session.callerNumber.replace(/[^0-9]/g, '') : '';
      // STRICT phone-match: only matches CallLog with same callee
      const matchPhoneStrict = (list) => {
        if (!cleanCallee) return null;
        const uc = list.filter(l => !l.stream_sid && l.created_date >= cutoff);
        return uc.find(l => (l.callee_number||'').replace(/[^0-9]/g,'').slice(-10) === cleanCallee.slice(-10)) || null;
      };

      // ── OUTBOUND: Match by call_sid (most reliable for click-to-call) ──
      const sidV = [];
      if (session.callSid) { sidV.push(session.callSid); const nc = session.callSid.replace(/^[^-]*-/, '').replace(/\.[^.]*$/, ''); if (nc && nc !== session.callSid) sidV.push(nc); const dg = session.callSid.replace(/\D/g, ''); if (dg && dg.length > 5) sidV.push(dg); }
      const wd = session._warmCallLogs;
      const [sidRes, ringRaw, initRaw, broadRaw] = await Promise.all([
        sidV.length > 0 ? Promise.all(sidV.map(sid => svc.entities.CallLog.filter({ call_sid: sid }).catch(() => []))) : [],
        wd?.ringing ?? svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 20).catch(() => []),
        wd?.initiated ?? svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 20).catch(() => []),
        wd?.recent ?? svc.entities.CallLog.list('-created_date', 15).catch(() => [])
      ]);
      for (let i = 0; i < sidRes.length && !callLog; i++) { const l = Array.isArray(sidRes[i]) ? sidRes[i] : []; if (l.length > 0) { callLog = l[0]; console.log(`[${reqId}] 🔍 call_sid match (${sidV[i]}): ${callLog.id}`); } }
      if (!callLog) { callLog = matchPhoneStrict(Array.isArray(ringRaw) ? ringRaw : []); if (callLog) console.log(`[${reqId}] ⚡ Ringing match: ${callLog.id}`); }
      if (!callLog) { callLog = matchPhoneStrict(Array.isArray(initRaw) ? initRaw : []); if (callLog) console.log(`[${reqId}] ⚡ Initiated match: ${callLog.id}`); }
      if (!callLog) {
        const cands = (Array.isArray(broadRaw) ? broadRaw : []).filter(l => !l.stream_sid && l.created_date >= cutoff && l.agent_config_cache?.system_prompt && ['initiated', 'ringing', 'answered'].includes(l.status));
        if (cands.length > 0 && cleanCallee) {
          callLog = cands.find(l => (l.callee_number||'').replace(/[^0-9]/g,'').slice(-10) === cleanCallee.slice(-10)) || null;
          if (callLog) console.log(`[${reqId}] 🔍 Broad match: ${callLog.id}`);
        }
      }
      console.log(`[${reqId}] ⏱️ Match: ${Date.now() - t0}ms`);

      if (!callLog) {
        console.log(`[${reqId}] ⚠️ No call log found after all strategies. callSid=${session.callSid}, streamSid=${session.streamSid}, calleeNumber=${session.calleeNumber}`);
        console.log(`[${reqId}] ⚠️ Agent will use DEFAULT generic prompt — this call will NOT be personalized.`);
        return;
      }

      // ── IMMEDIATELY extract FAST config (greeting + voice) so greeting can fire ASAP ──
      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      if (callLog.call_sid && callLog.call_sid !== session.callSid) {
        session.smartfloCallId = callLog.call_sid;
        console.log(`[${reqId}] 📞 Smartflo call_id from CallLog: ${session.smartfloCallId}`);
      }
      const cache = callLog.agent_config_cache;

      // ── PHASE A: Extract greeting + voice + base prompt SYNCHRONOUSLY (no awaits) ──
      session.agentId = callLog.agent_id || null;
      if (cache) {
        if (cache.persona) {
          if (cache.persona.voice_engine) session.voiceEngine = cache.persona.voice_engine;
          if (cache.persona.voice_type) {
            if (session.voiceEngine === 'realtime') {
              const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
              const deprecatedMap = { 'nova': 'shimmer', 'onyx': 'ash', 'fable': 'ballad' };
              let voice = cache.persona.voice_type.toLowerCase();
              if (deprecatedMap[voice]) voice = deprecatedMap[voice];
              if (validVoices.includes(voice)) session.voiceType = voice;
            } else {
              session.voiceType = cache.persona.voice_type;
            }
          }
        }
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (cache.system_prompt) session.systemPrompt = cache.system_prompt;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        // KB is now searched on-demand via the search_knowledge_base tool — no inline injection.
        if (cache.kb_file_uri) {
          session.kbFileUri = cache.kb_file_uri;
          // Prepend (not append) — many agent prompts are very long and specific, and a final
          // paragraph gets de-prioritized. Put KB instructions FIRST so the model honors them.
          const kbInstr = `[CRITICAL TOOL — HIGHEST PRIORITY] You have a tool: search_knowledge_base(query).\nThis business has uploaded its product catalog, pricing, services, policies, FAQs, brochures, and other reference material into a knowledge base. You MUST call search_knowledge_base BEFORE answering ANY of the following:\n- Product or service details, features, specifications, models\n- Pricing, plans, packages, offers, discounts\n- Office hours, locations, addresses, contact info\n- Refund / return / warranty / shipping / delivery policies\n- Process steps, eligibility, requirements, documents\n- Anything specific the customer asks about THIS business\nRules:\n1. ALWAYS search first — even if you think you know. Pass 2-4 concise keywords (e.g. "Class 4 laser pricing", "refund policy", "Mumbai office address").\n2. If the search returns passages, base your answer ONLY on them. Quote details verbatim where useful.\n3. If the search returns NO results, say honestly that you do not have that detail and offer to connect the customer to an expert / take their info.\n4. NEVER guess, invent, paraphrase from memory, or say "our experts will explain" when a search would answer it. Search first, expert handoff only as fallback.\n5. This tool overrides any earlier instruction telling you to avoid specifics — use the KB to give the actual specifics.\n\n`;
          session.systemPrompt = kbInstr + session.systemPrompt;
        }
      }
      console.log(`[${reqId}] 🎙️ FAST config: engine=${session.voiceEngine}, voice=${session.voiceType}, greeting=${!!session.greetingMessage}, kb=${!!session.kbFileUri}`);

      // ── If pre-warmed for Azure but Agent uses Gemini, switch connection ──
      if (session.voiceEngine === 'gemini_realtime' && session.realtimeWs && session.realtimeWs.url && session.realtimeWs.url.includes('openai')) {
        console.log(`[${reqId}] 🔄 Switching pre-warmed connection from Azure to Gemini`);
        session.realtimeWs.onclose = null; // Prevent Azure auto-reconnect
        session.realtimeWs.close();
        session.realtimeWs = null;
        session.realtimeReady = false;
        connectRealtime();
      }

      // ── Signal that greeting can fire NOW (before slow KB/Shopify/personal fetches) ──
      session._fastConfigReady = true;
      if (session.realtimeReady) {
        triggerPhase1Greeting();
      }

      // ── PHASE B: Slow enrichment (Shopify, personal mode) — runs AFTER greeting fires ──
      if (cache && cache.system_prompt) {
        // Shopify check (outbound calls may have Shopify integration for context)
        if (callLog.client_id) {
          try {
            const siRaw = await svc.entities.MarketplaceIntegration.filter({ client_id: callLog.client_id, platform: 'shopify', status: 'active' });
            const si = Array.isArray(siRaw) ? siRaw : [];
            if (si.length > 0) { session.hasShopify = true; console.log(`[${reqId}] 🛒 Shopify found`); }
          } catch (_) {}
        }
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
        console.log(`[${reqId}] ✅ Agent config from CallLog ${callLog.id} (${session.systemPrompt.length}ch, transfer=${session.humanTransferNumber || 'none'})`);
      } else if (!cache?.system_prompt) {
        console.log(`[${reqId}] ⚠️ CallLog ${callLog.id} found but has NO agent_config_cache — using default prompt`);
      }

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

  // ─── PRE-WARM: Connect to Azure Realtime + pre-import SDK immediately ───
  connectRealtime();
  import('npm:@base44/sdk@0.8.23').then(mod => { session._sdkModule = mod; }).catch(() => {});
  console.log(`[${reqId}] 🚀 Pre-warming Azure Realtime + SDK import...`);

  // ─── Smartflo WebSocket Handlers ───

  smartfloSocket.onopen = () => {
    console.log(`[${reqId}] 🟢 Smartflo socket opened${session._explicitCallLogId ? ` (id=${session._explicitCallLogId})` : ''}`);
    if (session._sdkModule) {
      try {
        const svc = session._sdkModule.createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        session._warmSvc = svc;
        // If we have explicit call_log_id, pre-fetch it directly. Else fall back to fuzzy warm-up.
        if (session._explicitCallLogId) {
          svc.entities.CallLog.get(session._explicitCallLogId).then(cl => { session._warmExplicitCallLog = cl; console.log(`[${reqId}] 🔥 Warm exact CallLog ready: ${cl?.id}`); }).catch(() => {});
        } else {
          Promise.all([
            svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 20).catch(() => []),
            svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 20).catch(() => []),
            svc.entities.CallLog.list('-created_date', 15).catch(() => [])
          ]).then(([ringing, initiated, recent]) => { session._warmCallLogs = { ringing, initiated, recent }; }).catch(() => {});
        }
      } catch (_) {}
    }
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
        session.streamSid = startData.streamSid; session.callSid = startData.callSid;
        const cp = startData.customParameters || {};
        if (!session._explicitCallLogId) {
          session._smartfloCustomIdentifier = cp.custom_identifier || cp.call_log_id || cp.callLogId || null;
          if (session._smartfloCustomIdentifier) console.log(`[${reqId}] 🔒 call_log_id from customParameters: ${session._smartfloCustomIdentifier}`);
        }
        console.log(`[${reqId}] 📞 START: to=${startData.to}, from=${startData.from}, params=${JSON.stringify(cp)}`);
        session.calleeNumber = cp.customer_number || cp.called_number || cp.to || startData.to || startData.callee || cp.did || '';
        session.callerNumber = startData.from || startData.caller || cp.caller_number || cp.from || cp.caller_id || '';

        // OUTBOUND-ONLY: outbound click-to-call always carries a call_log_id in customParameters.
        // Inbound calls have no such identifier — reject them so they go to streamAudioInbound.
        const hasOutboundId = !!(cp.custom_identifier || cp.call_log_id || cp.callLogId);
        if (!hasOutboundId) {
          console.error(`[${reqId}] ❌ INBOUND call routed to outbound function — rejecting. Configure DID to use /functions/streamAudioInbound`);
          smartfloSocket.close();
          session._callEnded = true;
          return;
        }

        console.log(`[${reqId}] 📞 OUTBOUND start: stream=${session.streamSid}, call=${session.callSid}, callee=${session.calleeNumber}, caller=${session.callerNumber}`);

        // Audio conversion state lives on session._audioState (already initialized) — no globals.

        // Azure Realtime was already pre-warmed on WebSocket upgrade.
        // Now load agent config — when ready, apply session config + greeting.
        loadAgentConfig().then(() => {
          session._agentConfigReady = true;
          console.log(`[${reqId}] 🚀 Agent config fully loaded: engine=${session.voiceEngine}, voice=${session.voiceType}`);
          // Apply Phase 2 full config if greeting was already sent via _fastConfigReady
          if (session._greetingSent && session.realtimeReady) {
            applySessionConfig();
          }
          // If fast config triggered greeting but Realtime wasn't ready yet, it'll fire from session.created
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        const raw = atob(msg.media.payload);
        const mulawBytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) mulawBytes[i] = raw.charCodeAt(i);

        // Buffer caller audio while Realtime is initializing (rolling window, capped)
        if (!session.realtimeReady) {
          while (session._mediaBuffer.length > 0 &&
                 session._mediaBufferBytes + mulawBytes.length > session._mediaBufferMaxBytes) {
            const dropped = session._mediaBuffer.shift();
            session._mediaBufferBytes -= dropped.length;
          }
          session._mediaBuffer.push(mulawBytes);
          session._mediaBufferBytes += mulawBytes.length;
          if (!session._mediaBufferLogged) {
            session._mediaBufferLogged = true;
            console.log(`[${reqId}] ⏳ Realtime not ready — buffering caller audio`);
          }
          return;
        }

        // Realtime ready — flush buffered audio first (one-time)
        if (!session._mediaBufferFlushed && session._mediaBuffer.length > 0) {
          session._mediaBufferFlushed = true;
          console.log(`[${reqId}] 🚀 Flushing ${session._mediaBuffer.length} buffered packets (${session._mediaBufferBytes}B)`);
          for (const buffered of session._mediaBuffer) {
            const ulawB64 = mulawBytesToBase64ULaw(buffered);
            // Azure Realtime: native g711_ulaw input. Gemini path here is legacy — also send mu-law as PCM is not faithful from mu-law without true resampling.
            if (session.voiceEngine === 'gemini_realtime') sendToRealtime({ realtimeInput: { mediaChunks: [{ mimeType: "audio/x-mulaw;rate=8000", data: ulawB64 }] } });
            else sendToRealtime({ type: 'input_audio_buffer.append', audio: ulawB64 });
          }
          session._mediaBuffer = [];
          session._mediaBufferBytes = 0;
        }

        const ulawB64 = mulawBytesToBase64ULaw(mulawBytes);
        if (session.voiceEngine === 'gemini_realtime') sendToRealtime({ realtimeInput: { mediaChunks: [{ mimeType: "audio/x-mulaw;rate=8000", data: ulawB64 }] } });
        else sendToRealtime({ type: 'input_audio_buffer.append', audio: ulawB64 });
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