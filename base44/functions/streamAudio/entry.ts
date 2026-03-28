import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

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
let _lastUpsampleValue = 0;
let _lastDownsampleRemainder = [];

function mulawToBase64PCM16_24k(mulawBytes) {
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm8k[i] = decodeMulaw(mulawBytes[i]);
  }
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = i === 0 ? _lastUpsampleValue : pcm8k[i - 1];
    const s1 = pcm8k[i];
    const s2 = i < pcm8k.length - 1 ? pcm8k[i + 1] : s1;
    pcm24k[i * 3] = s1;
    pcm24k[i * 3 + 1] = Math.round(s1 + (s2 - s0) / 6);
    pcm24k[i * 3 + 2] = Math.round(s1 + (s2 - s0) / 3);
  }
  if (pcm8k.length > 0) {
    _lastUpsampleValue = pcm8k[pcm8k.length - 1];
  }
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

function base64PCM16_24kToMulaw(base64Pcm16) {
  const raw = atob(base64Pcm16);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  const numSamples = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const allSamples = new Int16Array(_lastDownsampleRemainder.length + numSamples);
  for (let i = 0; i < _lastDownsampleRemainder.length; i++) {
    allSamples[i] = _lastDownsampleRemainder[i];
  }
  for (let i = 0; i < numSamples; i++) {
    allSamples[_lastDownsampleRemainder.length + i] = view.getInt16(i * 2, true);
  }
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
  _lastDownsampleRemainder = [];
  for (let i = consumed; i < totalSamples; i++) {
    _lastDownsampleRemainder.push(allSamples[i]);
  }
  return mulaw;
}

// ─── Safe base64 encoding for large Uint8Array ───
function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Send mu-law audio to Smartflo in 160-byte aligned chunks ───
function sendMulawToSmartflo(mulawBytes, smartfloSocket, streamSid) {
  const CHUNK_SIZE = 1600;
  for (let i = 0; i < mulawBytes.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, mulawBytes.length);
    let chunk = mulawBytes.slice(i, end);
    if (chunk.length % 160 !== 0) {
      const paddedLen = Math.ceil(chunk.length / 160) * 160;
      const padded = new Uint8Array(paddedLen);
      padded.set(chunk);
      padded.fill(0xFF, chunk.length);
      chunk = padded;
    }
    smartfloSocket.send(JSON.stringify({
      event: 'media',
      streamSid: streamSid,
      media: { payload: uint8ToBase64(chunk) }
    }));
  }
}

// ─── Save call record with AI analysis ───
async function saveCallRecord(session, reqId) {
  if (!session.callLogId) {
    console.log(`[${reqId}] ⚠️ No callLogId, skipping save`);
    return;
  }
  if (session._saved) return;
  session._saved = true;

  const duration = Math.round((Date.now() - session.startTime) / 1000);

  try {
    const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');

    const { createClient } = await import('npm:@base44/sdk@0.8.23');
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = createClient({ appId, asServiceRole: true });

    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

    // ===== AI Analysis =====
    let summary = '';
    let leadStatus = 'contacted';
    let sentiment = 'neutral';
    let leadScore = 0;
    let intentSignals = [];
    let scoreBreakdown = {};

    if (transcript && transcript.trim().length > 30 && baseUrl && deployment && apiKey) {
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
- Speech-to-text can MISINTERPRET short words. Common errors: "Hi" heard as "Bye-bye", "Haan" as "Nah".
- Do NOT mark a lead as "do_not_call" or "very_negative" based on a single ambiguous short word.
- Only use "do_not_call" when the customer EXPLICITLY says they don't want to be called.
- For very short calls with minimal customer speech, default to lead_status "contacted" and sentiment "neutral".

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
  "summary": "2-3 sentence summary",
  "lead_status": "interested|not_interested|callback|no_answer|converted|contacted|do_not_call",
  "sentiment": "very_positive|positive|neutral|negative|very_negative",
  "lead_score": 0-100,
  "intent_signals": [],
  "score_breakdown": {"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},
  "key_topics": [],
  "objections": [],
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
          console.log(`[${reqId}] 🧠 AI Analysis: score=${leadScore}, status=${leadStatus}, sentiment=${sentiment}`);
        }
      } catch (analysisErr) {
        console.error(`[${reqId}] ⚠️ AI analysis error: ${analysisErr.message}`);
      }
    } else if (!transcript || transcript.trim().length <= 30) {
      summary = 'Call ended with minimal or no conversation captured.';
    }

    // Short-call safeguard
    const customerLines = session.transcript.filter(t => t.speaker === 'Customer');
    const totalCustomerWords = customerLines.reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);
    if (totalCustomerWords <= 5 && duration < 30) {
      if (leadStatus === 'do_not_call' || leadStatus === 'not_interested') {
        console.log(`[${reqId}] ⚠️ Short call safeguard: overriding ${leadStatus}→contacted`);
        leadStatus = 'contacted';
        sentiment = 'neutral';
        leadScore = Math.max(leadScore, 10);
      }
    }

    // Qualification tier
    let qualificationTier = 'cold';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) {
      qualificationTier = 'hot';
    } else if (leadScore >= 50) {
      qualificationTier = 'warm';
    } else if (leadScore >= 25) {
      qualificationTier = 'nurture';
    }
    if (leadStatus === 'converted') qualificationTier = 'hot';
    if (leadStatus === 'do_not_call') qualificationTier = 'disqualified';

    const enrichedSummary = summary
      ? `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Tier: ${qualificationTier} | Signals: ${intentSignals.join(', ')}`
      : '';

    await svc.entities.CallLog.update(session.callLogId, {
      status: 'completed',
      transcript: transcript || '',
      duration: duration,
      call_end_time: new Date().toISOString(),
      lead_status_updated: leadStatus,
      ...(enrichedSummary ? { conversation_summary: enrichedSummary } : {})
    });

    // Update lead with scoring data
    if (session.leadId) {
      try {
        await svc.entities.Lead.update(session.leadId, {
          score: leadScore,
          sentiment: sentiment,
          intent_signals: intentSignals,
          score_breakdown: scoreBreakdown,
          qualification_tier: qualificationTier,
          last_call_date: new Date().toISOString()
        });
      } catch (e) {
        console.log(`[${reqId}] ⚠️ Lead update failed: ${e.message}`);
      }
    }

    console.log(`[${reqId}] 💾 Call saved: ${session.callLogId}, duration=${duration}s, score=${leadScore}`);
  } catch (err) {
    console.error(`[${reqId}] ❌ Save failed: ${err.message}`);
  }
}

// ─── Main Handler ───

Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWebSocket = upgrade === 'websocket';

  console.log(`[${reqId}] 📨 ${req.method} ${req.url}, ws=${isWebSocket}`);

  // Non-WebSocket: return status
  if (!isWebSocket) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    const protocol = req.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
    return new Response(JSON.stringify({
      status: 'ready',
      version: 'v8.0-hybrid',
      wss_url: `${protocol}://${host}/functions/streamAudio`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ─── Upgrade Smartflo WebSocket ───
  let smartfloSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    smartfloSocket = upgraded.socket;
    response = upgraded.response;
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
    leadId: null,
    agentId: null,
    calleeNumber: null,
    callerNumber: null,
    transcript: [],
    startTime: Date.now(),
    systemPrompt: 'You are a helpful AI voice assistant. Be professional and concise.',
    greetingMessage: '',
    voiceType: 'alloy',
    _saved: false,
    _callEnded: false,
    _configApplied: false,
    realtimeWs: null,
    realtimeReady: false,
    isSpeaking: false
  };

  // ─── Connect to Azure Realtime API ───
  function connectRealtime() {
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_KEY');
    if (!realtimeUrl || !realtimeKey) {
      console.error(`[${reqId}] ❌ Missing Azure Realtime credentials`);
      return;
    }

    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    if (!wsUrl.includes('/openai/realtime')) {
      wsUrl = wsUrl.replace(/\/+$/, '') + '/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-1.5';
    }
    wsUrl = wsUrl.replace('api-version=2025-04-01&', 'api-version=2025-04-01-preview&');
    const separator = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${separator}api-key=${encodeURIComponent(realtimeKey)}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${reqId}] ✅ Azure Realtime connected`);
      session.realtimeReady = true;
      // If agent config was already loaded, configure now
      if (session._configApplied) {
        applySessionConfig();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeMessage(msg);
      } catch (err) {
        console.error(`[${reqId}] ❌ Realtime parse error: ${err.message}`);
      }
    };

    ws.onclose = () => {
      console.log(`[${reqId}] 🔴 Azure Realtime closed`);
      session.realtimeReady = false;
    };

    session.realtimeWs = ws;
  }

  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    }
  }

  // ─── Apply session config to Realtime API and trigger greeting ───
  function applySessionConfig() {
    if (!session.realtimeReady) return;

    const sessionConfig = {
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: { model: 'whisper-1', language: 'hi' },
      modalities: ['text', 'audio'],
      voice: session.voiceType,
      instructions: session.systemPrompt,
      turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 800, silence_duration_ms: 800 }
    };
    sendToRealtime({ type: 'session.update', session: sessionConfig });
    console.log(`[${reqId}] 📤 Session configured (voice=${session.voiceType}, prompt=${session.systemPrompt.substring(0, 80)}...)`);

    // Trigger greeting
    const greeting = session.greetingMessage || 'Hello and welcome!';
    console.log(`[${reqId}] 🎙️ Greeting: "${greeting.substring(0, 80)}"`);
    session.transcript.push({ speaker: 'AI', text: greeting });
    sendToRealtime({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[SYSTEM: Say this greeting to the customer: "${greeting}"]` }]
      }
    });
    sendToRealtime({ type: 'response.create' });
  }

  // ─── Handle Realtime messages ───
  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Realtime session created`);
      session.realtimeReady = true;
      // If agent config already loaded, apply now
      if (session._configApplied) {
        applySessionConfig();
      }
      return;
    }

    if (type === 'response.audio.delta' && msg.delta) {
      session.isSpeaking = true;
      const mulawBytes = base64PCM16_24kToMulaw(msg.delta);
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        sendMulawToSmartflo(mulawBytes, smartfloSocket, session.streamSid);
      }
      return;
    }

    if (type === 'response.audio.done') {
      session.isSpeaking = false;
      console.log(`[${reqId}] 🔊 Audio response complete`);
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        console.log(`[${reqId}] 🗣️ Customer: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'Customer', text });
      }
      return;
    }

    if (type === 'response.audio_transcript.done' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        console.log(`[${reqId}] 🤖 AI: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'AI', text });
      }
      return;
    }
  }

  // ─── Load agent config ───
  async function loadAgentConfig() {
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.23');
      const appId = Deno.env.get('BASE44_APP_ID');
      const svc = createClient({ appId, asServiceRole: true });

      let callLog = null;

      // ── Strategy 1: call_sid match ──
      if (session.callSid) {
        const logsRaw = await svc.entities.CallLog.filter({ call_sid: session.callSid });
        const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.results || logsRaw?.data || []);
        if (logs.length > 0) {
          callLog = logs[0];
          console.log(`[${reqId}] 🔍 Strategy 1 - call_sid match: ${callLog.id}`);
        }
      }

      // ── Strategy 2: lead_id from customParameters ──
      if (!callLog && session.leadId) {
        const logsRaw = await svc.entities.CallLog.filter({ lead_id: session.leadId, status: 'ringing' });
        const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.results || logsRaw?.data || []);
        if (logs.length > 0) {
          callLog = logs[0];
          console.log(`[${reqId}] 🔍 Strategy 2 - lead_id match: ${callLog.id}`);
        }
      }

      // ── Strategy 3: Recent calls matching callee or caller phone (within 2 min) ──
      if (!callLog && (session.calleeNumber || session.callerNumber)) {
        const cleanCallee = (session.calleeNumber || '').replace(/[^0-9]/g, '').slice(-10);
        const cleanCaller = (session.callerNumber || '').replace(/[^0-9]/g, '').slice(-10);
        const twoMinAgo = Date.now() - 120000;
        const recentLogsRaw = await svc.entities.CallLog.list('-created_date', 30);
        const recentLogs = Array.isArray(recentLogsRaw) ? recentLogsRaw : (recentLogsRaw?.results || recentLogsRaw?.data || []);
        console.log(`[${reqId}] 🔍 Strategy 3: checking ${recentLogs.length} recent logs, callee=${cleanCallee}, caller=${cleanCaller}`);
        
        const candidates = recentLogs.filter(l => {
          const logCreated = new Date(l.created_date).getTime();
          if (logCreated < twoMinAgo) return false;
          if (!['initiated', 'ringing', 'answered'].includes(l.status)) return false;
          
          const logCallee = (l.callee_number || '').replace(/[^0-9]/g, '').slice(-10);
          if (cleanCallee && logCallee === cleanCallee) return true;
          
          const logCaller = (l.caller_id || '').replace(/[^0-9]/g, '').slice(-10);
          if (cleanCaller && logCaller === cleanCaller) return true;
          
          return false;
        });
        if (candidates.length > 0) {
          callLog = candidates[0];
          console.log(`[${reqId}] 🔍 Strategy 3 - phone match: ${callLog.id} (callee=${callLog.callee_number}, caller_id=${callLog.caller_id})`);
        }
      }

      // ── Strategy 4: DID-to-agent mapping (for inbound calls without CallLog) ──
      if (!callLog) {
        const cleanCallee = (session.calleeNumber || '').replace(/[^0-9]/g, '').slice(-10);
        const cleanCaller = (session.callerNumber || '').replace(/[^0-9]/g, '').slice(-10);
        
        if (cleanCallee || cleanCaller) {
          const didsRaw = await svc.entities.DID.filter({ status: 'assigned' });
          const dids = Array.isArray(didsRaw) ? didsRaw : (didsRaw?.results || didsRaw?.data || []);
          const matchedDID = dids.find(d => {
            const dNum = (d.number || '').replace(/[^0-9]/g, '').slice(-10);
            return dNum === cleanCaller || dNum === cleanCallee;
          });
          if (matchedDID && matchedDID.agent_id) {
            console.log(`[${reqId}] 🔍 Strategy 4 - DID match: ${matchedDID.number} → agent ${matchedDID.agent_id}`);
            const agent = await svc.entities.Agent.get(matchedDID.agent_id);
            if (agent) {
              session.clientId = agent.client_id;
              session.systemPrompt = agent.system_prompt || session.systemPrompt;
              session.greetingMessage = agent.greeting_message || '';
              if (agent.persona?.voice_type) session.voiceType = agent.persona.voice_type;
              console.log(`[${reqId}] ✅ Agent config from DID: ${agent.name}, voice=${session.voiceType}`);
            }
          }
        }
      }

      if (!callLog) {
        console.log(`[${reqId}] ⚠️ No call log found (sid=${session.callSid}, lead=${session.leadId}, callee=${session.calleeNumber}, caller=${session.callerNumber})`);
        // Still apply config (either DID-loaded or defaults)
        session._configApplied = true;
        applySessionConfig();
        return;
      }

      // Found a CallLog — extract agent config from cache
      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      session.leadId = session.leadId || callLog.lead_id;
      const cache = callLog.agent_config_cache;

      if (cache && cache.system_prompt) {
        session.systemPrompt = cache.system_prompt;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (cache.persona?.voice_type) session.voiceType = cache.persona.voice_type;
        console.log(`[${reqId}] ✅ Agent config loaded from CallLog: voice=${session.voiceType}, prompt=${session.systemPrompt.substring(0, 60)}...`);
      }

      // Mark config as applied and configure Realtime
      session._configApplied = true;
      applySessionConfig();
    } catch (e) {
      console.error(`[${reqId}] ❌ Agent config load failed: ${e.message}`);
      session._configApplied = true;
      applySessionConfig();
    }
  }

  // ─── PRE-WARM: Connect to Azure Realtime ───
  connectRealtime();
  console.log(`[${reqId}] 🚀 Pre-warming Azure Realtime connection...`);

  // ─── Smartflo WebSocket Handlers ───
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
        session.leadId = startData.customParameters?.lead_id || '';
        session.agentId = startData.customParameters?.agent_id || '';
        session.calleeNumber = startData.customParameters?.customer_number ||
          startData.customParameters?.called_number || startData.to || '';
        session.callerNumber = startData.from || startData.customParameters?.from || '';

        console.log(`[${reqId}] 📞 Call start: sid=${session.callSid}, lead=${session.leadId}, callee=${session.calleeNumber}, caller=${session.callerNumber}`);

        // Reset audio state
        _lastUpsampleValue = 0;
        _lastDownsampleRemainder = [];

        // Load agent config — this will call applySessionConfig() when done
        await loadAgentConfig();
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        if (!session.realtimeReady) return; // Silently drop — no spam logging

        const raw = atob(msg.media.payload);
        const mulawBytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
          mulawBytes[i] = raw.charCodeAt(i);
        }
        sendToRealtime({ type: 'input_audio_buffer.append', audio: mulawToBase64PCM16_24k(mulawBytes) });
        return;
      }

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Call stopped`);
        session._callEnded = true;
        if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
          session.realtimeWs.close();
        }
        await saveCallRecord(session, reqId);
        return;
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ Message error: ${err.message}`);
    }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    console.log(`[${reqId}] 🔴 Smartflo socket closed`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
    await saveCallRecord(session, reqId);
  };

  return response;
});