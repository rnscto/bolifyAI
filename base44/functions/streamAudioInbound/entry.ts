import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// ─── Smartflo token cache (module-level, shared across WebSocket sessions in this isolate) ───
// Smartflo locks the account if you log in too frequently. Cache the JWT and respect retry_after.
const SMARTFLO_TOKEN_TTL_MS = 50 * 60 * 1000;
let _smartfloTokenCache = { token: null, expiresAt: 0, inFlight: null, blockedUntil: 0 };

async function getSmartfloToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _smartfloTokenCache.token && _smartfloTokenCache.expiresAt > now) {
    return _smartfloTokenCache.token;
  }
  // Honor Smartflo's rate-limit cool-down: don't even attempt login while blocked.
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
        // Parse retry_after from Smartflo's body (e.g. "2026-05-14 17:40:45" in IST)
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

// ═══════════════════════════════════════════════════════════════
// streamAudioInbound — DEDICATED inbound WSS handler
//
// Resolves the agent from the DID (callee_number) instead of looking
// up a CallLog. This eliminates ANY chance of cross-talk between
// concurrent inbound calls hitting the same DID. Each WebSocket gets
// its own session with its own DID→Agent resolution.
//
// Outbound (click-to-call) calls MUST go to the `streamAudio` function,
// not this one — this function will reject them.
// ═══════════════════════════════════════════════════════════════

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

function mulawToBase64PCM16_24k(mulawBytes, audioState) {
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) pcm8k[i] = decodeMulaw(mulawBytes[i]);
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = i === 0 ? audioState.lastUpsampleValue : pcm8k[i - 1];
    const s1 = pcm8k[i];
    const s2 = i < pcm8k.length - 1 ? pcm8k[i + 1] : s1;
    pcm24k[i * 3] = s1;
    pcm24k[i * 3 + 1] = Math.round(s1 + (s2 - s0) / 6);
    pcm24k[i * 3 + 2] = Math.round(s1 + (s2 - s0) / 3);
  }
  if (pcm8k.length > 0) audioState.lastUpsampleValue = pcm8k[pcm8k.length - 1];
  const buffer = new Uint8Array(pcm24k.length * 2);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < pcm24k.length; i++) view.setInt16(i * 2, pcm24k[i], true);
  let binary = '';
  for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]);
  return btoa(binary);
}

function base64PCM16_24kToMulaw(base64Pcm16, audioState) {
  const raw = atob(base64Pcm16);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const numSamples = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const remainder = audioState.lastDownsampleRemainder;
  const allSamples = new Int16Array(remainder.length + numSamples);
  for (let i = 0; i < remainder.length; i++) allSamples[i] = remainder[i];
  for (let i = 0; i < numSamples; i++) allSamples[remainder.length + i] = view.getInt16(i * 2, true);
  const totalSamples = allSamples.length;
  const downsampledLen = Math.floor(totalSamples / 3);
  const mulaw = new Uint8Array(downsampledLen);
  for (let i = 0; i < downsampledLen; i++) {
    const idx = i * 3;
    const prev = idx > 0 ? allSamples[idx - 1] : allSamples[idx];
    const curr = allSamples[idx];
    const next = idx + 1 < totalSamples ? allSamples[idx + 1] : curr;
    const filtered = Math.round((prev + 2 * curr + next) / 4);
    const clamped = Math.max(-32768, Math.min(32767, filtered));
    mulaw[i] = encodeMulaw(clamped);
  }
  const consumed = downsampledLen * 3;
  const newRemainder = [];
  for (let i = consumed; i < totalSamples; i++) newRemainder.push(allSamples[i]);
  audioState.lastDownsampleRemainder = newRemainder;
  return mulaw;
}

// ─── Save call record (post-call analysis + persistence) ───
async function saveCallRecord(session, reqId, duration) {
  if (!session.callLogId) { console.log(`[${reqId}] ⚠️ No callLogId, skipping save`); return; }
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
    let baseUrl = rawEndpoint.replace(/\/+$/, '');
    const openaiIdx = baseUrl.indexOf('/openai/'); if (openaiIdx > 0) baseUrl = baseUrl.substring(0, openaiIdx);
    const apiProjIdx = baseUrl.indexOf('/api/projects'); if (apiProjIdx > 0) baseUrl = baseUrl.substring(0, apiProjIdx);

    let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0;
    let intentSignals = [], scoreBreakdown = {}, keyTopics = [], objections = [];

    if (transcript && transcript.trim().length > 30) {
      try {
        const analysisRes = await fetch(`${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`, {
          method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: `You are an expert call analyst. Analyze the transcript.\nIMPORTANT: STT can misinterpret short words (e.g. "Hi"→"Bye-bye"). Do NOT mark do_not_call/very_negative based on a single ambiguous word. Use "contacted"/"no_answer" for short calls. Only use do_not_call when EXPLICITLY stated. Respond ONLY in valid JSON.` },
              { role: 'user', content: `Analyze:\n\n${transcript}\n\nReturn JSON: {"summary":"...","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"reasoning":"..."},"key_topics":[],"objections":[],"recommended_next_action":"..."}` }
            ],
            max_completion_tokens: 800, response_format: { type: "json_object" }
          })
        });
        if (analysisRes.ok) {
          const analysisData = await analysisRes.json();
          const analysis = JSON.parse(analysisData.choices?.[0]?.message?.content || '{}');
          summary = analysis.summary || '';
          leadStatus = analysis.lead_status || 'contacted';
          sentiment = analysis.sentiment || 'neutral';
          leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
          intentSignals = analysis.intent_signals || [];
          scoreBreakdown = { ...(analysis.score_breakdown || {}), objections: analysis.objections || [], recommended_next_action: analysis.recommended_next_action || '', key_topics: analysis.key_topics || [] };
          keyTopics = analysis.key_topics || [];
          objections = analysis.objections || [];
          console.log(`[${reqId}] 🧠 AI: score=${leadScore}, status=${leadStatus}, sentiment=${sentiment}`);
        }
      } catch (analysisErr) { console.error(`[${reqId}] ⚠️ AI analysis: ${analysisErr.message}`); }
    } else if (!transcript || transcript.trim().length <= 30) {
      summary = 'Call ended with minimal or no conversation captured.';
    }

    let qualificationTier = 'cold', qualificationReason = '';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) { qualificationTier = 'hot'; qualificationReason = `Score ${leadScore}/100, ${sentiment}`; }
    else if (leadScore >= 50) { qualificationTier = 'warm'; qualificationReason = `Score ${leadScore}/100, ${sentiment}`; }
    else if (leadScore >= 25) { qualificationTier = 'nurture'; qualificationReason = `Score ${leadScore}/100`; }
    else if (['negative', 'very_negative'].includes(sentiment)) { qualificationTier = 'disqualified'; qualificationReason = `Low score ${leadScore}/100, ${sentiment}`; }
    if (leadStatus === 'converted') { qualificationTier = 'hot'; qualificationReason = 'Converted'; }

    const customerLines = session.transcript.filter(t => t.speaker === 'Customer');
    const totalCustomerWords = customerLines.reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);
    if (totalCustomerWords <= 5 && duration < 30 && (leadStatus === 'do_not_call' || leadStatus === 'not_interested')) {
      console.log(`[${reqId}] ⚠️ Short call safeguard: overriding ${leadStatus}→contacted`);
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
      qualificationTier = 'cold'; qualificationReason = `Short call (${duration}s) — needs follow-up`;
    }
    if (leadStatus === 'do_not_call') { qualificationTier = 'disqualified'; qualificationReason = 'Do not call'; }

    const currentLog = await serviceClient.entities.CallLog.get(session.callLogId);
    const wasAlreadyCompleted = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);
    const enrichedSummary = summary ? `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Tier: ${qualificationTier} | Signals: ${intentSignals.join(', ')}` : '';

    if (wasAlreadyCompleted) {
      await serviceClient.entities.CallLog.update(session.callLogId, { transcript: transcript || '', duration, lead_status_updated: leadStatus, conversation_summary: enrichedSummary || summary || '' });
    } else {
      await serviceClient.entities.CallLog.update(session.callLogId, { status: 'completed', transcript: transcript || '', duration, call_end_time: new Date().toISOString(), lead_status_updated: leadStatus, conversation_summary: enrichedSummary || summary || '' });
    }
    console.log(`[${reqId}] 💾 Inbound call saved: ${session.callLogId}, score=${leadScore}`);

    if (currentLog.lead_id) {
      try {
        const existingLead = await serviceClient.entities.Lead.get(currentLog.lead_id);
        const mergedTags = [...new Set([...(existingLead.tags || []), ...keyTopics.slice(0, 10)])];
        await serviceClient.entities.Lead.update(currentLog.lead_id, {
          status: leadStatus, score: leadScore, sentiment, intent_signals: intentSignals,
          score_breakdown: scoreBreakdown, qualification_tier: qualificationTier, qualification_reason: qualificationReason,
          tags: mergedTags, last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString(),
          engagement_count: (existingLead.engagement_count || 0) + 1,
          notes: `[Score: ${leadScore}/100 | ${sentiment} | ${qualificationTier}] ${summary.substring(0, 300)}`
        });
      } catch (leadErr) { console.error(`[${reqId}] ⚠️ Lead update: ${leadErr.message}`); }
    }

    // Personal account voicemail save + Telegram summary
    if (session._personalMode && session._personalClientId) {
      try {
        const cLines = session.transcript.filter(t => t.speaker === 'Customer').map(t => t.text);
        const callerName = (() => { for (const line of cLines) { const m = line.match(/(?:my name is|this is|I am|main|mera naam)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i); if (m) return m[1]; } return ''; })();
        const sl = (summary || '').toLowerCase();
        let category = 'unknown';
        if (sl.includes('spam') || sl.includes('telemarketing')) category = 'spam';
        else if (sl.includes('promotional') || sl.includes('offer')) category = 'promotional';
        else if (sl.includes('family') || sl.includes('friend')) category = 'family';
        else if (sl.includes('business') || sl.includes('meeting') || sl.includes('work')) category = 'business';
        let urgency = 'medium';
        if (sl.includes('urgent') || sl.includes('emergency') || sl.includes('important')) urgency = 'urgent';
        else if (sentiment === 'very_positive' || sl.includes('asap')) urgency = 'high';
        else if (category === 'spam' || category === 'promotional') urgency = 'low';
        const messageText = cLines.join(' ').substring(0, 1000) || summary || 'No message content captured';

        await serviceClient.entities.VoicemailMessage.create({ client_id: session._personalClientId, call_log_id: session.callLogId, caller_number: currentLog.caller_id || currentLog.callee_number || '', caller_name: callerName, message: summary || messageText, urgency, category, is_read: false });

        const tgTk = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgTk) { try { const pCl = await serviceClient.entities.Client.get(session._personalClientId);
          if (pCl?.telegram_connected && pCl?.telegram_chat_id && !pCl.dnd_enabled && pCl.owner_notification_channel === 'telegram') {
            const emj = category === 'spam' ? '🚫' : category === 'family' ? '👨‍👩‍👧' : category === 'business' ? '💼' : '📋';
            const tgS = `${emj} <b>Call Summary</b>\n\n📱 From: <b>${callerName || currentLog.caller_id || 'Unknown'}</b>\n🏷️ ${category}${urgency !== 'medium' ? ' | ⚡ ' + urgency.toUpperCase() : ''}\n\n💬 ${(summary || messageText).substring(0, 500)}`;
            fetch(`https://api.telegram.org/bot${tgTk}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: pCl.telegram_chat_id, text: tgS, parse_mode: 'HTML' }) }).catch(() => {});
          } } catch (_) {} }
      } catch (vmErr) { console.error(`[${reqId}] ⚠️ Voicemail save: ${vmErr.message}`); }
    }

    if (transcript.length > 50) {
      serviceClient.functions.invoke('postCallActionExtractor', { call_log_id: session.callLogId })
        .catch(e => console.error(`[${reqId}] ⚠️ Action extraction: ${e.message}`));
    }
    try { serviceClient.cleanup(); } catch (_) {}
  } catch (err) { console.error(`[${reqId}] ❌ Save failed:`, err.message); }
}

// ─── Main Handler ───
Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWebSocket = upgrade === 'websocket';

  console.log(`[${reqId}] 📨 [INBOUND] ${req.method} ${req.url}, ws=${isWebSocket}`);

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
  createClientFromRequest(base44Req); // validate request

  // Non-WebSocket: Smartflo Dynamic endpoint — return wss URL pointing to THIS function
  if (!isWebSocket) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    
    let isGemini = false;
    try {
      let calleeNumber = '';
      let callerNumber = '';
      if (req.method === 'POST') {
        const bd = await req.json();
        calleeNumber = bd.did || bd.to || bd.called_number || '';
        callerNumber = bd.caller_id || bd.from || bd.customer_number || '';
      } else if (req.method === 'GET') {
        const u = new URL(req.url);
        calleeNumber = u.searchParams.get('did') || u.searchParams.get('to') || '';
        callerNumber = u.searchParams.get('caller_id') || u.searchParams.get('from') || '';
      }
      
      const cleanCalleeDID = calleeNumber.replace(/[^0-9]/g, '').slice(-10);
      const cleanCallerDID = callerNumber.replace(/[^0-9]/g, '').slice(-10);
      
      if (cleanCalleeDID || cleanCallerDID) {
        const { createClient } = await import('npm:@base44/sdk@0.8.23');
        const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        const allDIDs = await svc.entities.DID.list('-created_date', 200).catch(()=>[]);
        const matchedDID = allDIDs.find(d => { const n = (d.number || '').replace(/\D/g, '').slice(-10); return n === cleanCalleeDID || n === cleanCallerDID; });
        
        let didAgent = null;
        if (matchedDID?.agent_id) {
          didAgent = await svc.entities.Agent.get(matchedDID.agent_id).catch(()=>null);
        }
        if (!didAgent) {
          const allAgents = await svc.entities.Agent.list('-created_date', 100).catch(()=>[]);
          didAgent = allAgents.find(a => {
            const dids = (a.assigned_dids || []).concat(a.assigned_did ? [a.assigned_did] : []);
            return dids.some(d => { const n = (d || '').replace(/\D/g, '').slice(-10); return n === cleanCalleeDID || n === cleanCallerDID; });
          });
        }
        
        if (didAgent?.persona?.voice_engine === 'gemini_realtime') {
          isGemini = true;
        }
      }
    } catch (e) {
      console.error(`[${reqId}] ❌ Failed to check voice engine for inbound dynamic endpoint: ${e.message}`);
    }
    
    const endpoint = isGemini ? 'streamAudioInboundGemini' : 'streamAudioInbound';
    const wssUrl = `wss://${host}/functions/${endpoint}`;
    console.log(`[${reqId}] 🔗 inbound wss_url routing to ${endpoint}`);
    
    return new Response(JSON.stringify({ sucess: true, wss_url: wssUrl }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ─── Upgrade WebSocket ───
  let smartfloSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    smartfloSocket = upgraded.socket;
    response = upgraded.response;
    console.log(`[${reqId}] ✅ Inbound Smartflo WebSocket upgraded`);
  } catch (err) {
    console.error(`[${reqId}] ❌ Upgrade failed: ${err.message}`);
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  // ─── Session State (per-WebSocket — fully isolated) ───
  const session = {
    streamSid: null, callSid: null, callLogId: null, clientId: null,
    transcript: [], startTime: Date.now(),
    systemPrompt: 'You are a friendly AI voice assistant. Be professional and concise. Keep responses to 1-3 sentences.',
    greetingMessage: '', voiceEngine: 'realtime', voiceType: 'alloy',
    _saved: false, smartfloCallId: null,
    realtimeWs: null, realtimeReady: false, isSpeaking: false,
    _ttsAbort: null, chatHistory: [], tools: [], hasShopify: false,
    humanTransferNumber: '', enableAutoTransfer: true,
    agentId: null, kbFileUri: '',
    _realtimeReconnectAttempts: 0, _callEnded: false,
    _audioState: { lastUpsampleValue: 0, lastDownsampleRemainder: [] },
    _mediaBuffer: [], _mediaBufferMaxBytes: 256 * 1024, _mediaBufferBytes: 0, _mediaBufferFlushed: false,
    _awaitingOwnerDecision: false, _ownerDecisionExecuted: false, _ownerName: '',
    _greetingSent: false, _phase1Applied: false, _fastConfigReady: false,
    _isInboundCall: true  // Always true for this function
  };

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
        if (session._fastConfigReady) {
           triggerPhase1Greeting();
        }
      };
      ws.onmessage = (event) => {
        try {
          const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
          handleGeminiMessage(JSON.parse(text));
        } catch (err) {
          console.error(`[${reqId}] ❌ Gemini parse error: ${err.message}`);
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
    if (!realtimeUrl || !realtimeKey) { console.error(`[${reqId}] ❌ Missing AZURE_REALTIME secrets`); return; }
    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    if (!wsUrl.includes('/openai/realtime')) {
      wsUrl = wsUrl.replace(/\/+$/, '') + '/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-1.5';
    }
    wsUrl = wsUrl.replace('api-version=2025-04-01&', 'api-version=2025-04-01-preview&');
    const separator = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${separator}api-key=${encodeURIComponent(realtimeKey)}`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => { console.log(`[${reqId}] ✅ Realtime connected`); session._realtimeReconnectAttempts = 0; session._lastRealtimeOpenTs = Date.now(); };
    ws.onmessage = (event) => { try { handleRealtimeMessage(JSON.parse(event.data)); } catch (err) { console.error(`[${reqId}] ❌ Realtime parse: ${err.message}`); } };
    ws.onclose = (event) => {
      console.log(`[${reqId}] 🔴 Realtime closed: code=${event.code} reason=${event.reason} wasClean=${event.wasClean} endpoint=${(realtimeUrl || '').substring(0, 60)} keyLen=${(realtimeKey || '').length}`);
      session.realtimeReady = false;
      const stableMs = session._lastRealtimeOpenTs ? (Date.now() - session._lastRealtimeOpenTs) : 0;
      if (stableMs > 30000 && session._realtimeReconnectAttempts > 0) session._realtimeReconnectAttempts = 0;
      const RECONNECT_DELAYS_MS = [500, 1500, 3000, 6000, 10000, 15000];
      if (!session._callEnded && session._realtimeReconnectAttempts < RECONNECT_DELAYS_MS.length) {
        const delay = RECONNECT_DELAYS_MS[session._realtimeReconnectAttempts++];
        setTimeout(() => { if (!session._callEnded) connectRealtime(); }, delay);
      }
    };
    ws.onerror = (event) => console.error(`[${reqId}] ❌ Realtime error — message=${event?.message || 'unknown'} type=${event?.type || 'unknown'}`);
    session.realtimeWs = ws;
  }

  // ─── Hang up call via Smartflo API ───
  async function hangupCall(reason) {
    console.log(`[${reqId}] 📴 Hangup: ${reason}`);
    session._callEnded = true;
    try {
      const tk = await getSmartfloToken();
      if (tk) {
        {
          const liveCallId = await findLiveCallId(tk);
          const candidates = [...new Set([liveCallId, session.smartfloCallId, session.callSid].filter(Boolean))];
          for (const candidateId of candidates) {
            const hr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/hangup', {
              method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
              body: JSON.stringify({ call_id: candidateId })
            });
            if (hr.ok) break;
          }
        }
      } else {
        console.error(`[${reqId}] ⚠️ Smartflo token unavailable for hangup`);
      }
    } catch (e) { console.error(`[${reqId}] ⚠️ Hangup: ${e.message}`); }
    if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
  }

  async function findLiveCallId(token) {
    try {
      const r = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
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
      if (m?.call_id) return m.call_id;
    } catch (_) {}
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
    tools.push({type:'function',name:'end_call',description:'End/disconnect the call. Use when conversation concluded with goodbye, spam declined, or caller asked to end. Say goodbye BEFORE calling this.',parameters:{type:'object',properties:{reason:{type:'string'}},required:['reason']}});
    if (session.humanTransferNumber) {
      tools.push({ type: 'function', name: 'transfer_to_human', description: 'Transfer the call to a human agent when customer explicitly asks for one or for complex issues you cannot resolve. Always confirm before transferring.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } });
    }
    if (session.hasShopify) {
      tools.push({ type: 'function', name: 'shopify_lookup', description: 'Look up info from the customer\'s Shopify store (orders, products, refunds, tracking).', parameters: { type: 'object', properties: { lookup_type: { type: 'string', enum: ['order_by_number', 'order_by_phone', 'order_by_email', 'product_search', 'refund_status', 'tracking'] }, query: { type: 'string' } }, required: ['lookup_type', 'query'] } });
    }
    if (session.kbFileUri && session.agentId) {
      tools.push({
        type: 'function',
        name: 'search_knowledge_base',
        description: 'Search the business knowledge base (products, pricing, policies, FAQs, services) by keyword. Call this BEFORE answering any specific question about the business. Pass concise keywords (e.g. "return policy", "pricing", "office hours").',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Concise keyword query.' } }, required: ['query'] }
      });
      console.log(`[${reqId}] 📚 KB search tool registered (agent=${session.agentId})`);
    }
    session.tools = tools;
    return tools;
  }

  async function executeToolCall(callId, functionName, argsStr) {
    console.log(`[${reqId}] 🔧 Tool: ${functionName}`);
    let result = { error: `Unknown tool: ${functionName}` };

    if (functionName === 'end_call') {
      const a = JSON.parse(argsStr);
      result = { success: true };
      if (session.voiceEngine === 'gemini_realtime') { sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } }); }
      else { sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }); }
      session.transcript.push({ speaker: 'System', text: `[Call ended: ${a.reason}]` });
      setTimeout(() => hangupCall(a.reason || 'ended'), 1500);
      return;
    }

    if (functionName === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const args = JSON.parse(argsStr);
        const tk = await getSmartfloToken();
        if (!tk) { result = { error: 'Smartflo authentication failed' }; }
        else {
          {
            const txCallId = await findLiveCallId(tk) || session.smartfloCallId || session.callSid;
            const tr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` }, body: JSON.stringify({ type: 4, call_id: txCallId, intercom: String(session.humanTransferNumber) }) });
            const td = await tr.json();
            if (tr.ok) {
              result = { success: true, message: 'Call is being transferred.' };
              if (session.callLogId) {
                const { createClient } = await import('npm:@base44/sdk@0.8.23');
                const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
                svc.entities.CallLog.update(session.callLogId, { transferred_to: `Human agent (intercom: ${session.humanTransferNumber}, reason: ${args.reason})` }).catch(() => {});
              }
              session.transcript.push({ speaker: 'System', text: `[Transferred to human. Reason: ${args.reason}]` });
            } else { result = { error: `Transfer failed: ${td.message || tr.status}` }; }
          }
        }
      } catch (err) { result = { error: `Transfer failed: ${err.message}` }; }
      if (session.voiceEngine === 'gemini_realtime') { sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } }); }
      else { sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }); sendToRealtime({ type: 'response.create' }); }
      return;
    }

    if (functionName === 'search_knowledge_base' && session.agentId && session.kbFileUri) {
      try {
        const args = JSON.parse(argsStr);
        const { createClient } = await import('npm:@base44/sdk@0.8.23');
        const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        const kbResp = await svc.functions.invoke('kbSearch', { agent_id: session.agentId, query: args.query || '', top_k: 3, _internal: true });
        const data = kbResp?.data || {};
        if (data.success && Array.isArray(data.results) && data.results.length > 0) {
          result = { passages: data.results.map((r, i) => `[Passage ${i + 1}]\n${r.content}`).join('\n\n'), count: data.results.length };
        } else {
          result = { passages: '', count: 0, message: 'No relevant information found.' };
        }
        console.log(`[${reqId}] 📚 KB "${(args.query || '').substring(0, 50)}" → ${data.results?.length || 0} passages`);
      } catch (err) { result = { error: 'KB search failed', passages: '' }; }
      if (session.voiceEngine === 'gemini_realtime') { sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } }); }
      else { sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }); sendToRealtime({ type: 'response.create' }); }
      return;
    }

    if (functionName === 'shopify_lookup' && session.clientId) {
      try {
        const args = JSON.parse(argsStr);
        const { createClient } = await import('npm:@base44/sdk@0.8.23');
        const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        const integrations = await svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, platform: 'shopify', status: 'active' });
        if (integrations.length === 0) { result = { error: 'No active Shopify integration' }; }
        else {
          const shop = integrations[0];
          const storeUrl = shop.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const baseUrl = `https://${storeUrl}/admin/api/${shop.api_version || '2024-01'}`;
          const headers = { 'X-Shopify-Access-Token': shop.api_access_token, 'Content-Type': 'application/json' };
          if (args.lookup_type === 'order_by_number') {
            const orderName = args.query.startsWith('#') ? args.query : `#${args.query}`;
            const res = await fetch(`${baseUrl}/orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=3`, { headers });
            result = res.ok ? { orders: ((await res.json()).orders || []).map(formatShopifyOrder) } : { error: `Shopify ${res.status}` };
          } else if (args.lookup_type === 'order_by_phone') {
            const res = await fetch(`${baseUrl}/orders.json?status=any&limit=20`, { headers });
            if (res.ok) { const data = await res.json(); const cleanQ = args.query.replace(/[^0-9]/g, ''); result = { orders: (data.orders || []).filter(o => { const ph = (o.customer?.phone || o.phone || o.billing_address?.phone || '').replace(/[^0-9]/g, ''); return ph.includes(cleanQ) || cleanQ.includes(ph); }).slice(0, 5).map(formatShopifyOrder) }; } else { result = { error: `Shopify ${res.status}` }; }
          } else if (args.lookup_type === 'order_by_email') {
            const cr = await fetch(`${baseUrl}/customers/search.json?query=email:${encodeURIComponent(args.query)}&limit=1`, { headers });
            if (cr.ok) { const cd = await cr.json(); if (cd.customers?.length > 0) { const cId = cd.customers[0].id; const or = await fetch(`${baseUrl}/customers/${cId}/orders.json?status=any&limit=5`, { headers }); const od = await or.json(); result = { customer_name: `${cd.customers[0].first_name || ''} ${cd.customers[0].last_name || ''}`.trim(), orders: (od.orders || []).map(formatShopifyOrder) }; } else { result = { orders: [] }; } } else { result = { error: `Shopify ${cr.status}` }; }
          } else if (args.lookup_type === 'product_search') {
            const res = await fetch(`${baseUrl}/products.json?title=${encodeURIComponent(args.query)}&limit=5`, { headers });
            result = res.ok ? { products: ((await res.json()).products || []).map(p => ({ title: p.title, available: p.variants?.some(v => (v.inventory_quantity || 0) > 0), variants: p.variants?.map(v => ({ title: v.title, price: v.price, stock: v.inventory_quantity })) })) } : { error: `Shopify ${res.status}` };
          } else if (args.lookup_type === 'tracking') {
            const res = await fetch(`${baseUrl}/orders/${args.query}/fulfillments.json`, { headers });
            result = res.ok ? { fulfillments: ((await res.json()).fulfillments || []).map(f => ({ tracking_number: f.tracking_number, tracking_company: f.tracking_company, tracking_url: f.tracking_url, status: f.status, shipment_status: f.shipment_status })) } : { error: `Shopify ${res.status}` };
          } else if (args.lookup_type === 'refund_status') {
            const res = await fetch(`${baseUrl}/orders/${args.query}/refunds.json`, { headers });
            result = res.ok ? { refunds: ((await res.json()).refunds || []).map(r => ({ created_at: r.created_at, note: r.note, items: r.refund_line_items?.map(li => li.line_item?.title) })) } : { error: `Shopify ${res.status}` };
          } else { result = { error: `Unknown lookup_type` }; }
        }
      } catch (err) { result = { error: err.message }; }
    }

    if (session.voiceEngine === 'gemini_realtime') {
      sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } });
    } else {
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
      sendToRealtime({ type: 'response.create' });
    }
  }

  function formatShopifyOrder(o) {
    const t = (o.fulfillments || []).filter(f => f.tracking_number).map(f => ({ tracking_number: f.tracking_number, company: f.tracking_company, url: f.tracking_url, status: f.shipment_status || f.status }));
    return { order_number: o.name || `#${o.order_number}`, date: o.created_at?.substring(0, 10), status: o.cancelled_at ? 'cancelled' : (o.fulfillment_status || 'unfulfilled'), payment: o.financial_status, total: `${o.currency} ${o.total_price}`, items: (o.line_items || []).map(li => `${li.title} x${li.quantity}`).join(', '), tracking: t.length > 0 ? t : 'no tracking yet', shipping_city: o.shipping_address?.city || '' };
  }

  // ─── PHASE 1: Speak greeting IMMEDIATELY ───
  function triggerPhase1Greeting() {
    if (session._greetingSent || session._phase1Applied) return;
    if (session._responseInFlight) { session._greetingSent = true; session._phase1Applied = true; applySessionConfig(); return; }
    const greeting = session.greetingMessage || '';
    if (!greeting) { applySessionConfig(); return; }
    session._phase1Applied = true; session._greetingSent = true;
    session.transcript.push({ speaker: 'AI', text: greeting });
    const isHybrid = session.voiceEngine === 'azure_speech';
    if (isHybrid) {
      session.chatHistory = [{ role: 'system', content: 'You are a helpful AI voice assistant.' }, { role: 'assistant', content: greeting }];
      synthesizeWithAzureSpeech(greeting);
      applySessionConfig();
    } else if (session.voiceEngine === 'gemini_realtime') {
      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
      const timeInjection = `\n[LIVE CLOCK] Current IST: ${nowIST}.\n`;
      const noiseHandling = `\n[AUDIO RULES] Phone call. Only respond to clear speech. Ignore garbled/short utterances. Keep replies 1-2 sentences.\n`;
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
      // VOICE LOCK: send the FULL Phase-2 config (voice + final instructions + tools) in a
      // SINGLE session.update BEFORE any assistant audio is generated. After this, Azure
      // refuses voice changes ("cannot_update_voice").
      const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
      const timeInjection = `\n[LIVE CLOCK] Current IST: ${nowIST}.\n`;
      const noiseHandling = `\n[AUDIO RULES] Phone call. Only respond to clear speech. Ignore garbled/short utterances. Keep replies 1-2 sentences.\n`;
      let transferInstr = '';
      if (session.humanTransferNumber && session.enableAutoTransfer) {
        transferInstr = `\n\nUse transfer_to_human when caller explicitly asks for a human or for complex issues. Confirm before transferring.`;
      }
      const tools = buildToolDefinitions();
      const fullCfg = {
        modalities: ['text', 'audio'],
        voice: session.voiceType,
        output_audio_format: 'pcm16',
        instructions: timeInjection + noiseHandling + session.systemPrompt + transferInstr
      };
      if (tools.length > 0) { fullCfg.tools = tools; fullCfg.tool_choice = 'auto'; }
      sendToRealtime({ type: 'session.update', session: fullCfg });
      session._voiceLocked = true;
      session._phase2Sent = true;
      console.log(`[${reqId}] 🔒 Voice locked: ${session.voiceType}, prompt=${session.systemPrompt.length}ch, tools=${tools.length}`);
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: Say this exact greeting: "' + greeting + '"]' }] } });
      sendToRealtime({ type: 'response.create' });
    }
  }

  function applySessionConfig() {
    // VOICE LOCK GUARD: triggerPhase1Greeting() already sent the full Phase-2 config.
    // Sending another session.update with `voice` would be rejected by Azure.
    if (session._phase2Sent && session.voiceEngine !== 'azure_speech') {
      console.log(`[${reqId}] ✅ Phase 2 already sent — skipping redundant config`);
      return;
    }
    const isHybrid = session.voiceEngine === 'azure_speech';
    const tools = buildToolDefinitions();
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeInjection = `\n[LIVE CLOCK] Current IST: ${nowIST}.\n`;
    const noiseHandling = `\n[AUDIO RULES] You are on a phone call. ONLY respond to clear, directed speech. Ignore garbled/short utterances. Never end the call based on a single unclear word. Keep responses 1-2 sentences.\n`;
    let transferInstructions = '';
    if (session.humanTransferNumber && session.enableAutoTransfer) {
      transferInstructions = `\n\n--- HUMAN TRANSFER AVAILABLE ---\nUse transfer_to_human when customer explicitly asks for a human or for complex issues. Always confirm: "Let me connect you to a human agent. Please hold."`;
    }
    const greetingGuard = session._greetingSent ? '\n\nIMPORTANT: You have ALREADY greeted. Do NOT greet again.' : '';
    const sessionConfig = { input_audio_format: 'pcm16', input_audio_transcription: { model: 'whisper-1', language: 'hi' }, turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 700 } };
    if (isHybrid) {
      sessionConfig.instructions = 'You are a transcription-only assistant. Do not respond.';
      sessionConfig.modalities = ['text']; sessionConfig.voice = 'alloy';
      session.chatHistory = [{ role: 'system', content: timeInjection + noiseHandling + session.systemPrompt + transferInstructions + greetingGuard }];
      if (session._greetingSent && session.greetingMessage) session.chatHistory.push({ role: 'assistant', content: session.greetingMessage });
    } else {
      sessionConfig.modalities = ['text', 'audio'];
      sessionConfig.instructions = timeInjection + noiseHandling + session.systemPrompt + transferInstructions + greetingGuard;
      sessionConfig.output_audio_format = 'pcm16';
      // VOICE STABILITY FIX: only include `voice` on the FIRST session.update of this connection.
      if (!session._voiceLocked) {
        sessionConfig.voice = session.voiceType;
        session._voiceLocked = true;
      }
    }
    if (tools.length > 0) { sessionConfig.tools = tools; sessionConfig.tool_choice = 'auto'; }
    sendToRealtime({ type: 'session.update', session: sessionConfig });
    if (!session._greetingSent) triggerGreeting();
  }

  function handleRealtimeMessage(msg) {
    const type = msg.type;
    if (type === 'session.created') {
      session.realtimeReady = true;
      const isReconnect = session._agentConfigReady && session.transcript.length > 0;
      if (isReconnect) {
        const isHybrid = session.voiceEngine === 'azure_speech';
        const tools = buildToolDefinitions();
        const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const sessionConfig = { input_audio_format: 'pcm16', input_audio_transcription: { model: 'whisper-1', language: 'hi' }, turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 700 } };
        if (isHybrid) { sessionConfig.instructions = 'You are a transcription-only assistant.'; sessionConfig.modalities = ['text']; sessionConfig.voice = 'alloy'; }
        else { sessionConfig.modalities = ['text', 'audio']; sessionConfig.instructions = `\n[LIVE CLOCK] Current IST: ${nowIST}.\n` + session.systemPrompt; sessionConfig.voice = session.voiceType; sessionConfig.output_audio_format = 'pcm16'; session._voiceLocked = true; }
        if (tools.length > 0) { sessionConfig.tools = tools; sessionConfig.tool_choice = 'auto'; }
        sendToRealtime({ type: 'session.update', session: sessionConfig });
      } else if (session._fastConfigReady) {
        triggerPhase1Greeting();
      } else {
        // Minimal pre-config WITHOUT voice/modalities. The voice will be set exactly ONCE
        // when triggerPhase1Greeting() fires the full Phase-2 session.update.
        sendToRealtime({ type: 'session.update', session: { input_audio_format: 'pcm16', input_audio_transcription: { model: 'whisper-1' }, turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 700 } }});
      }
      return;
    }
    if (type === 'session.updated') return;
    if (type === 'response.audio.delta' && msg.delta) {
      session.isSpeaking = true;
      const mulawBytes = base64PCM16_24kToMulaw(msg.delta, session._audioState);
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) sendMulawToSmartflo(mulawBytes);
      return;
    }
    if (type === 'response.audio.done') { session.isSpeaking = false; return; }
    if (type === 'response.created') { session._responseInFlight = true; return; }
    if (type === 'response.done') { session._responseInFlight = false; return; }
    if (type === 'conversation.item.input_audio_transcription.failed') { console.error(`[${reqId}] ❌ STT fail`); return; }
    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        const clean = text.toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g, '').trim();
        const wc = clean.split(/\s+/).filter(w => w).length;
        if (wc <= 2 && /^(bye[\s-]*bye|bye|ba+h*|hmm+|uh+|um+|ah+|oh+|huh|tch|shh|ss+|mm+|nah+|ha+)$/i.test(clean)) { console.log(`[${reqId}] 🔇 Noise: "${text}"`); return; }
        console.log(`[${reqId}] 🗣️ Customer: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'Customer', text });
        if (session.voiceEngine === 'azure_speech') generateGpt5NanoResponse(text);
        if (session._personalMode && session._personalClientId && !session._midCallTgSent) {
          const custCount = session.transcript.filter(t => t.speaker === 'Customer').length;
          if (custCount >= 2) { session._midCallTgSent = true; sendMidCallTelegramUpdate(); }
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
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
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

  // ─── Mid-call Telegram (personal accounts) ───
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
      const ue = r.urgency === 'urgent' ? ' 🚨' : r.urgency === 'high' ? ' ⚡' : '';
      let midCallName = '', midCallType = '';
      if (session._isTrustedCaller && session._trustedContactName) { midCallName = session._trustedContactName; midCallType = '👤 Saved Contact'; }
      else if (r.caller_name) midCallName = r.caller_name;
      const callerLabel = midCallName || session.callerNumber || 'Unknown';
      const clId = session.callLogId;
      const typeLine = midCallType ? `\n🏷️ ${midCallType}` : '';
      const m = `${r.emoji || '📞'} <b>Live Call — What should I do?</b>${ue}\n\n📱 From: <b>${callerLabel}</b>${midCallName && session.callerNumber ? '\n📞 ' + session.callerNumber : ''}${typeLine}\n📋 <b>${r.reason || 'Unknown'}</b>${r.detail ? '\n💬 ' + r.detail : ''}\n\n👇 <b>Choose action:</b>`;
      const kb = { inline_keyboard: [
        [{ text: '📞 Transfer to Me', callback_data: `decision:${clId}:transfer` }, { text: '⏰ Call Back', callback_data: `decision:${clId}:callback` }],
        [{ text: '📝 Take Message', callback_data: `decision:${clId}:take_message` }, { text: '🚫 Block/End', callback_data: `decision:${clId}:block` }]
      ]};
      fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: m, parse_mode: 'HTML', reply_markup: kb }) })
        .then(x => x.json()).then(x => { if (x.ok) { session._awaitingOwnerDecision = true; pollOwnerDecision(svc); } }).catch(() => {});
    } catch (e) { console.error(`[${reqId}] ⚠️ Mid-call TG: ${e.message}`); }
  }

  async function pollOwnerDecision(svc) {
    if (!session.callLogId || !session._personalClientId) return;
    let polls = 0;
    const iv = setInterval(async () => {
      polls++;
      if (polls > 60 || session._callEnded || session._ownerDecisionExecuted) { clearInterval(iv); if (polls > 60) session._awaitingOwnerDecision = false; return; }
      try {
        const decs = await svc.entities.CallDecision.filter({ call_log_id: session.callLogId, status: 'pending' });
        const dec = decs.find(d => d.custom_message !== '__AWAITING_TIME__' && d.custom_message !== '__AWAITING_MESSAGE__');
        if (!dec) return;
        clearInterval(iv);
        session._awaitingOwnerDecision = false;
        session._ownerDecisionExecuted = true;
        await svc.entities.CallDecision.update(dec.id, { status: 'delivered' });
        executeOwnerDecision(dec);
      } catch (e) { console.error(`[${reqId}] ⚠️ Poll: ${e.message}`); }
    }, 2000);
  }

  function executeOwnerDecision(dec) {
    const ownerName = session._ownerName || 'Sir';
    let inst = '';
    if (dec.decision === 'transfer') {
      inst = session.humanTransferNumber
        ? `[OWNER INSTRUCTION] ${ownerName} ji ne aapka call transfer karne ke liye bola hai. Caller ko Hindi mein boliye: "Sir, ${ownerName} ji ne aapka call apne paas transfer karne ke liye bola hai, aap kuch second hold kariye." Phir TURANT transfer_to_human tool use karke transfer karo.`
        : `[OWNER INSTRUCTION] ${ownerName} ji aapko jald call back karenge. Caller ko Hindi mein boliye: "Sir, ${ownerName} ji abhi aapka call le rahe hain, wo aapko turant call back karenge."`;
    } else if (dec.decision === 'callback') {
      const t = dec.callback_time || dec.custom_message || 'kuch der mein';
      inst = `[OWNER INSTRUCTION] ${ownerName} ji ne kaha hai ki wo caller ko call back karenge. Caller ko Hindi mein boliye: "Sir, ${ownerName} ji ne mujhe bola hai ki wo aapko ${t} mein call back kar rahe hain. Kya aap koi message dena chahenge?"`;
    } else if (dec.decision === 'take_message') {
      inst = `[OWNER INSTRUCTION] ${ownerName} ji abhi busy hain. Caller ko Hindi mein boliye: "Sir, ${ownerName} ji abhi busy hain, unhone mujhe aapka message lene ke liye bola hai. Aap bataiye aapka kya kaam tha." Phir caller ka naam, purpose aur message note karo.`;
    } else if (dec.decision === 'block') {
      inst = `[OWNER INSTRUCTION] ${ownerName} ji ne call end karne ke liye bola hai. Caller ko Hindi mein politely boliye: "Sir, ${ownerName} ji abhi available nahi hain. Aapka dhanyavaad. Namaste." Phir call khatam karo.`;
    } else if (dec.custom_message) {
      inst = `[OWNER INSTRUCTION] ${ownerName} ji ne yeh message bheja hai: "${dec.custom_message}". Isko caller ko Hindi mein naturally relay karo.`;
    }
    if (!inst) return;
    if (session.voiceEngine === 'azure_speech') generateGpt5NanoResponse(inst);
    else {
      sendToRealtime({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: inst }] } });
      if (!session._responseInFlight) sendToRealtime({ type: 'response.create' });
    }
  }

  function triggerGreeting() {
    if (session._greetingSent) return;
    if (session._responseInFlight) { session._greetingSent = true; return; }
    session._greetingSent = true;
    const isHybrid = session.voiceEngine === 'azure_speech';
    const greeting = session.greetingMessage || '';
    if (isHybrid) {
      if (greeting) {
        session.transcript.push({ speaker: 'AI', text: greeting });
        session.chatHistory.push({ role: 'assistant', content: greeting });
        synthesizeWithAzureSpeech(greeting);
      } else {
        generateGpt5NanoResponse('[SYSTEM: The call just connected. Greet warmly as your opening line.]');
      }
    } else {
      if (greeting) {
        session.transcript.push({ speaker: 'AI', text: greeting });
        sendToRealtime({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: Say this exact greeting: "' + greeting + '"]' }] } });
        sendToRealtime({ type: 'response.create' });
      } else {
        sendToRealtime({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: The call just connected. Greet warmly.]' }] } });
        sendToRealtime({ type: 'response.create' });
      }
    }
  }

  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) session.realtimeWs.send(JSON.stringify(msg));
  }

  function uint8ToBase64(bytes) {
    let binary = ''; const len = bytes.length;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
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
        padded.set(chunk); padded.fill(0xFF, chunk.length);
        chunk = padded;
      }
      smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
    }
  }

  async function synthesizeWithAzureSpeech(text) {
    const speechKey = Deno.env.get('AZURE_SPEECH_KEY'), speechRegion = Deno.env.get('AZURE_SPEECH_REGION');
    if (!speechKey || !speechRegion) { console.error(`[${reqId}] ❌ Missing TTS keys`); return; }
    const xmlLang = /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-IN';
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
          if (chunk.length % 160 !== 0) { const p = new Uint8Array(Math.ceil(chunk.length / 160) * 160); p.set(chunk); p.fill(0xFF, chunk.length); chunk = p; }
          smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
        }
      }
    } catch (err) { if (err.name !== 'AbortError') console.error(`[${reqId}] ❌ TTS: ${err.message}`); }
    finally { session.isSpeaking = false; session._ttsAbort = null; }
  }

  const cleanTextForTTS = t => t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1').replace(/#{1,6}\s*/g, '').replace(/```[\s\S]*?```/g, '').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();

  async function generateGpt5NanoResponse(userText) {
    const nanoEndpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const nanoKey = Deno.env.get('AZURE_OPENAI_KEY');
    const nanoDeployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    if (!nanoEndpoint || !nanoKey || !nanoDeployment) { console.error(`[${reqId}] ❌ Missing Azure OpenAI`); return; }
    session.chatHistory.push({ role: 'user', content: userText });
    try {
      const response = await fetch(`${nanoEndpoint}/openai/deployments/${nanoDeployment}/chat/completions?api-version=2025-01-01-preview`, {
        method: 'POST', headers: { 'api-key': nanoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            ...session.chatHistory.slice(0, 1),
            { role: 'system', content: 'CRITICAL: You are on a LIVE PHONE CALL. ALWAYS respond in Hindi script (देवनागरी). NEVER use English unless absolutely necessary. NEVER use markdown, emojis, special characters. Keep responses SHORT — max 2 sentences.' },
            ...session.chatHistory.slice(1)
          ],
          max_completion_tokens: 150, stream: true
        })
      });
      if (!response.ok) { console.error(`[${reqId}] ❌ LLM: ${response.status}`); return; }
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
            const json = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (!delta) continue;
            fullText += delta; sentenceBuffer += delta;
            const sentenceMatch = sentenceBuffer.match(/^(.*?[.?!।\n])\s*(.*)/s);
            if (sentenceMatch) {
              const sentence = cleanTextForTTS(sentenceMatch[1]);
              sentenceBuffer = sentenceMatch[2] || '';
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

  // ─── INBOUND-SPECIFIC: Resolve agent from DID, create CallLog ───
  async function loadInboundAgent() {
    const t0 = Date.now();
    try {
      if (!session._sdkModule) session._sdkModule = await import('npm:@base44/sdk@0.8.23');
      const svc = session._warmSvc || session._sdkModule.createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

      const callerDID = (session.callerNumber || '').replace(/[^0-9]/g, '').slice(-10);
      const cleanCalleeDID = (session.calleeNumber || '').replace(/[^0-9]/g, '').slice(-10);
      console.log(`[${reqId}] 🔍 DID→Agent: callee=${cleanCalleeDID}, caller=${callerDID}`);
      if (!cleanCalleeDID && !callerDID) { console.error(`[${reqId}] ❌ No DIDs available`); return; }

      // Try DID entity first
      const allDIDsRaw = await svc.entities.DID.list('-created_date', 200);
      const allDIDs = Array.isArray(allDIDsRaw) ? allDIDsRaw : [];
      const matchedDID = allDIDs.find(d => { const n = (d.number || '').replace(/\D/g, '').slice(-10); return n === cleanCalleeDID || n === callerDID; });
      let didAgent = null, didClient = null;

      if (matchedDID?.agent_id || matchedDID?.client_id) {
        const [_a, _c] = await Promise.all([
          matchedDID.agent_id ? svc.entities.Agent.get(matchedDID.agent_id).catch(() => null) : null,
          matchedDID.client_id ? svc.entities.Client.get(matchedDID.client_id).catch(() => null) : null
        ]);
        didAgent = _a; didClient = _c;
      }

      // Fallback: search agents' assigned_dids arrays
      if (!didAgent) {
        const allAgents = Array.isArray(await svc.entities.Agent.list('-created_date', 100)) ? await svc.entities.Agent.list('-created_date', 100) : [];
        didAgent = allAgents.find(a => {
          const dids = a.assigned_dids || (a.assigned_did ? [a.assigned_did] : []);
          return dids.some(d => { const n = (d || '').replace(/\D/g, '').slice(-10); return n === cleanCalleeDID || n === callerDID; });
        });
        if (didAgent && !didClient && didAgent.client_id) { try { didClient = await svc.entities.Client.get(didAgent.client_id); } catch (_) {} }
      }

      if (!didAgent) { console.error(`[${reqId}] ❌ No agent found for DID ${cleanCalleeDID}/${callerDID}`); return; }
      session.agentId = didAgent.id;
      if (didAgent.kb_file_uri) session.kbFileUri = didAgent.kb_file_uri;

      // Fix Smartflo swap: if callerNumber is the DID, swap them
      const agentDids = (didAgent.assigned_dids || []).concat(didAgent.assigned_did ? [didAgent.assigned_did] : []);
      if (agentDids.some(d => (d || '').replace(/\D/g, '').slice(-10) === callerDID) && session.callerNumber && session.calleeNumber) {
        const tmp = session.callerNumber; session.callerNumber = session.calleeNumber; session.calleeNumber = tmp;
        console.log(`[${reqId}] 🔄 Swapped: caller=${session.callerNumber}, callee=${session.calleeNumber}`);
      }
      console.log(`[${reqId}] ✅ INBOUND: Agent="${didAgent.name}", client=${didClient?.company_name || '?'}`);
      session.clientId = didClient?.id || didAgent.client_id;

      // Lead lookup (KB is now searched on-demand via tool — no inline content fetch)
      let callerContext = '';
      const cleanCaller = session.callerNumber ? session.callerNumber.replace(/\D/g, '').slice(-10) : '';
      const leadsRaw = (cleanCaller && didClient) ? await svc.entities.Lead.filter({ client_id: didClient.id }).catch(() => []) : [];

      if (cleanCaller && didClient) {
        const leads = Array.isArray(leadsRaw) ? leadsRaw : [];
        const matchedLead = leads.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === cleanCaller);
        if (matchedLead) {
          console.log(`[${reqId}] 🎯 Lead: "${matchedLead.name}" (score: ${matchedLead.score})`);
          callerContext = [`\n\n--- INBOUND CALL - RETURNING LEAD ---`, `- Name: ${matchedLead.name || 'Unknown'}`, `- Phone: ${matchedLead.phone}`, matchedLead.email ? `- Email: ${matchedLead.email}` : null, matchedLead.company ? `- Company: ${matchedLead.company}` : null, `- Status: ${matchedLead.status || 'new'}`, `- Score: ${matchedLead.score || 0}/100`, matchedLead.qualification_tier ? `- Tier: ${matchedLead.qualification_tier}` : null, matchedLead.notes ? `- Notes: ${matchedLead.notes.substring(0, 300)}` : null, '', `CRITICAL: This is an INBOUND callback. Address them by name "${matchedLead.name || 'Sir/Madam'}".`].filter(Boolean).join('\n');
          try { const lcRaw = await svc.entities.CallLog.filter({ lead_id: matchedLead.id }); const rc = (Array.isArray(lcRaw) ? lcRaw : []).sort((a, b) => new Date(b.call_start_time || b.created_date) - new Date(a.call_start_time || a.created_date)).slice(0, 3); if (rc.length > 0) { callerContext += '\n\nLAST CALL HISTORY:'; rc.forEach(c => { callerContext += `\n- ${c.direction} | ${c.status} | ${(c.conversation_summary || 'No summary').substring(0, 150)}`; }); } } catch (_) {}
          session._inboundLeadId = matchedLead.id;
        }
      }

      const baseAgentPrompt = (didAgent.system_prompt || 'You are a helpful AI voice assistant.') + callerContext;
      if (session.kbFileUri) {
        // Prepend KB instructions so they aren't drowned out by long scripted agent prompts.
        const kbInstr = `[CRITICAL TOOL — HIGHEST PRIORITY] You have a tool: search_knowledge_base(query).\nThis business has uploaded its product catalog, pricing, services, policies, FAQs, brochures, and other reference material into a knowledge base. You MUST call search_knowledge_base BEFORE answering ANY of the following:\n- Product or service details, features, specifications, models\n- Pricing, plans, packages, offers, discounts\n- Office hours, locations, addresses, contact info\n- Refund / return / warranty / shipping / delivery policies\n- Process steps, eligibility, requirements, documents\n- Anything specific the customer asks about THIS business\nRules:\n1. ALWAYS search first — even if you think you know. Pass 2-4 concise keywords (e.g. "Class 4 laser pricing", "refund policy", "Mumbai office address").\n2. If the search returns passages, base your answer ONLY on them. Quote details verbatim where useful.\n3. If the search returns NO results, say honestly that you do not have that detail and offer to connect the customer to an expert / take their info.\n4. NEVER guess, invent, paraphrase from memory, or say "our experts will explain" when a search would answer it. Search first, expert handoff only as fallback.\n5. This tool overrides any earlier instruction telling you to avoid specifics — use the KB to give the actual specifics.\n\n`;
        session.systemPrompt = kbInstr + baseAgentPrompt;
      } else {
        session.systemPrompt = baseAgentPrompt;
      }
      if (didAgent.greeting_message) session.greetingMessage = didAgent.greeting_message;
      if (didAgent.human_transfer_number) session.humanTransferNumber = didAgent.human_transfer_number;
      else if (didClient?.account_type === 'personal' && didClient?.phone) { session.humanTransferNumber = didClient.phone; }
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
          } else { session.voiceType = didAgent.persona.voice_type; }
        }
      }

      // Create CallLog so saveCallRecord can persist transcript (no inline KB — searched on-demand)
      try {
        const newLog = await svc.entities.CallLog.create({
          client_id: session.clientId, agent_id: didAgent.id, lead_id: session._inboundLeadId || null,
          call_sid: session.callSid || `inbound_${Date.now()}`, stream_sid: session.streamSid || null,
          caller_id: session.callerNumber || '', callee_number: session.calleeNumber,
          direction: 'inbound', status: 'answered', call_start_time: new Date().toISOString(),
          agent_config_cache: {
            agent_name: didAgent.name, system_prompt: session.systemPrompt,
            persona: didAgent.persona || {},
            kb_file_uri: session.kbFileUri || '',
            lead_context: callerContext,
            greeting_message: didAgent.greeting_message || '',
            human_transfer_number: didAgent.human_transfer_number || '',
            enable_auto_transfer: didAgent.enable_auto_transfer !== false
          }
        });
        session.callLogId = newLog.id;
        console.log(`[${reqId}] ✅ Inbound CallLog: ${newLog.id}`);
      } catch (clErr) { console.error(`[${reqId}] ⚠️ CallLog create: ${clErr.message}`); }

      // Personal account screening
      if (didClient && didClient.account_type === 'personal') {
        const aiMode = didClient.ai_response_mode || 'screen_all';
        const dndEnabled = didClient.dnd_enabled || false;
        const callerClean = (session.callerNumber || '').replace(/\D/g, '').slice(-10);
        let isTrusted = false, trustedName = '';
        const [tcRaw, osRaw] = await Promise.all([
          callerClean ? svc.entities.TrustedContact.filter({ client_id: didClient.id }).catch(() => []) : [],
          svc.entities.OwnerStatus.filter({ client_id: didClient.id, is_active: true }).catch(() => [])
        ]);
        if (callerClean) { const tcs = Array.isArray(tcRaw) ? tcRaw : []; const m = tcs.find(tc => tc.phone && tc.phone.replace(/\D/g, '').slice(-10) === callerClean); if (m) { isTrusted = true; trustedName = m.name || ''; } }
        let pi = '\n\n--- PERSONAL AI ASSISTANT MODE ---';
        if (aiMode === 'block_all') pi += '\nMODE: BLOCK ALL. Politely tell caller owner is unavailable. Do NOT take messages. End quickly.';
        else if (aiMode === 'take_messages') pi += '\nMODE: TAKE MESSAGES. Take a message from every caller.';
        else if (aiMode === 'allow_contacts' && isTrusted) pi += `\nMODE: ALLOW CONTACTS. Caller "${trustedName}" is TRUSTED. Be warm and transfer if possible.`;
        else if (aiMode === 'allow_contacts' && !isTrusted) pi += '\nMODE: ALLOW CONTACTS (unknown). Screen this unknown caller.';
        else pi += '\nMODE: SCREEN ALL. Screen every call. Classify family/business/promotional/spam.';
        if (dndEnabled) pi += '\nDND IS ON: Handle silently.';
        pi += '\nAFTER EVERY CALL: Classify as family/business/promotional/spam/unknown.';
        const _osList = Array.isArray(osRaw) ? osRaw : [];
        if (_osList.length > 0) { const _s = _osList[0]; pi += `\n\n--- OWNER STATUS: ${_s.icon} ${_s.title}${_s.start_time ? ' (' + _s.start_time + (_s.end_time ? ' to ' + _s.end_time : '') + ')' : ''} ---\nCRITICAL: Tell callers in Hindi: "${_s.caller_message_hindi}"`; }
        session.systemPrompt += pi;
        session._personalMode = aiMode;
        session._isTrustedCaller = isTrusted;
        session._trustedContactName = trustedName;
        session._personalClientId = didClient.id;
        session._ownerName = didClient.company_name || '';
        console.log(`[${reqId}] 🛡️ Personal: mode=${aiMode}, dnd=${dndEnabled}, trusted=${isTrusted}`);

        // Live Telegram notification
        if (didClient.telegram_connected && didClient.telegram_chat_id && !dndEnabled && didClient.owner_notification_channel === 'telegram') {
          const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
          if (tgToken) {
            let cdn = '', ct = '';
            if (isTrusted && trustedName) { cdn = trustedName; ct = '👤 Saved Contact'; }
            else { const ln = session._inboundLeadId ? (callerContext.match(/Name: ([^\n]+)/) || [])[1] || '' : ''; if (ln) { cdn = ln; ct = '📋 Known Lead'; } }
            const nd = cdn || session.callerNumber || 'Unknown';
            const tl = ct ? `\n🏷️ ${ct}` : '\n🏷️ Unknown Caller';
            const nl = cdn && session.callerNumber ? `\n📞 ${session.callerNumber}` : '';
            const tgMsg = `📞 <b>Incoming Call</b>\n\n📱 From: <b>${nd}</b>${nl}${tl}\n\n💬 AI is screening...`;
            fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: didClient.telegram_chat_id, text: tgMsg, parse_mode: 'HTML' }) }).catch(() => {});
          }
        }
      }

      // Shopify check
      if (session.clientId) {
        try {
          const siRaw = await svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, platform: 'shopify', status: 'active' });
          const si = Array.isArray(siRaw) ? siRaw : [];
          if (si.length > 0) {
            session.hasShopify = true;
            if (!session.systemPrompt.includes('SHOPIFY STORE INTEGRATION')) {
              session.systemPrompt += `\n\n--- SHOPIFY STORE INTEGRATION (ACTIVE) ---\nUse shopify_lookup tool for order status, tracking, products, refunds. Ask for order number/phone/email. NEVER make up statuses.`;
            }
          }
        } catch (_) {}
      }

      console.log(`[${reqId}] ✅ Inbound config loaded in ${Date.now() - t0}ms: engine=${session.voiceEngine}, voice=${session.voiceType}`);
      
      if (session.voiceEngine === 'gemini_realtime' && session.realtimeWs && session.realtimeWs.url && session.realtimeWs.url.includes('openai')) {
        console.log(`[${reqId}] 🔄 Switching pre-warmed connection from Azure to Gemini`);
        session.realtimeWs.onclose = null;
        session.realtimeWs.close();
        session.realtimeWs = null;
        session.realtimeReady = false;
        connectRealtime();
      }

      session._fastConfigReady = true;
      if (session.realtimeReady) triggerPhase1Greeting();
    } catch (e) { console.error(`[${reqId}] ❌ Inbound config load failed: ${e.message}`); }
  }

  // ─── PRE-WARM ───
  connectRealtime();
  import('npm:@base44/sdk@0.8.23').then(mod => { session._sdkModule = mod; }).catch(() => {});

  // ─── Smartflo WebSocket Handlers ───
  smartfloSocket.onopen = () => {
    console.log(`[${reqId}] 🟢 Smartflo socket opened (inbound)`);
    if (session._sdkModule) {
      try {
        const svc = session._sdkModule.createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        session._warmSvc = svc;
      } catch (_) {}
    }
  };

  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.event === 'connected') { console.log(`[${reqId}] ✅ Smartflo connected`); return; }

      if (msg.event === 'start') {
        const startData = msg.start || {};
        session.streamSid = startData.streamSid;
        session.callSid = startData.callSid;
        const cp = startData.customParameters || {};
        console.log(`[${reqId}] 📞 START: to=${startData.to}, from=${startData.from}, params=${JSON.stringify(cp)}`);

        // Reject outbound calls — they MUST go to streamAudio
        if (cp.customer_number) {
          console.error(`[${reqId}] ❌ OUTBOUND call routed to inbound function — rejecting`);
          smartfloSocket.close();
          session._callEnded = true;
          return;
        }

        session.calleeNumber = startData.to || cp.did || '';
        session.callerNumber = startData.from || '';
        console.log(`[${reqId}] 📥 INBOUND: stream=${session.streamSid}, callee=${session.calleeNumber}, caller=${session.callerNumber}`);

        loadInboundAgent().then(() => {
          session._agentConfigReady = true;
          if (session._greetingSent && session.realtimeReady) applySessionConfig();
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        const raw = atob(msg.media.payload);
        const mulawBytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) mulawBytes[i] = raw.charCodeAt(i);

        if (!session.realtimeReady) {
          while (session._mediaBuffer.length > 0 && session._mediaBufferBytes + mulawBytes.length > session._mediaBufferMaxBytes) {
            const dropped = session._mediaBuffer.shift();
            session._mediaBufferBytes -= dropped.length;
          }
          session._mediaBuffer.push(mulawBytes);
          session._mediaBufferBytes += mulawBytes.length;
          return;
        }

        if (!session._mediaBufferFlushed && session._mediaBuffer.length > 0) {
          session._mediaBufferFlushed = true;
          for (const buffered of session._mediaBuffer) {
            const pcmBuf = mulawToBase64PCM16_24k(buffered, session._audioState);
            if (session.voiceEngine === 'gemini_realtime') sendToRealtime({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=24000", data: pcmBuf }] } });
            else sendToRealtime({ type: 'input_audio_buffer.append', audio: pcmBuf });
          }
          session._mediaBuffer = []; session._mediaBufferBytes = 0;
        }

        const pcm16Base64 = mulawToBase64PCM16_24k(mulawBytes, session._audioState);
        if (session.voiceEngine === 'gemini_realtime') sendToRealtime({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=24000", data: pcm16Base64 }] } });
        else sendToRealtime({ type: 'input_audio_buffer.append', audio: pcm16Base64 });
        return;
      }

      if (msg.event === 'mark') return;

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Smartflo stop`);
        session._callEnded = true;
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) session.realtimeWs.close();
        await saveCallRecord(session, reqId, duration);
        return;
      }
    } catch (err) { console.error(`[${reqId}] ❌ Smartflo message: ${err.message}`); }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Smartflo closed, duration=${duration}s`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) session.realtimeWs.close();
    if (session.callLogId) await saveCallRecord(session, reqId, duration);
  };

  smartfloSocket.onerror = () => {
    console.error(`[${reqId}] ❌ Smartflo error`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) session.realtimeWs.close();
  };

  return response;
});