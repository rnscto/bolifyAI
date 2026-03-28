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
function sendMulawToSmartflo(mulawBytes, smartfloSocket, streamSid, reqId) {
  const CHUNK_SIZE = 1600; // 200ms at 8kHz mu-law
  for (let i = 0; i < mulawBytes.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, mulawBytes.length);
    let chunk = mulawBytes.slice(i, end);

    // Pad to 160-byte boundary
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
      streamSid: streamSid,
      media: { payload }
    }));
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
      version: 'v7.0-hybrid',
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
    clientId: null,
    transcript: [],
    startTime: Date.now(),
    systemPrompt: 'You are a helpful AI voice assistant. Be professional and concise.',
    greetingMessage: '',
    voiceEngine: 'realtime',
    voiceType: 'alloy',
    _saved: false,
    realtimeWs: null,
    realtimeReady: false,
    isSpeaking: false,
    tools: [],
    _callEnded: false
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
      console.log(`[${reqId}] ✅ Azure Realtime WebSocket connected`);
      session.realtimeReady = true;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeMessage(msg);
      } catch (err) {
        console.error(`[${reqId}] ❌ Realtime message parse error: ${err.message}`);
      }
    };

    ws.onclose = () => {
      console.log(`[${reqId}] 🔴 Azure Realtime closed`);
      session.realtimeReady = false;
    };

    session.realtimeWs = ws;
  }

  // ─── Send message to Azure Realtime API ───
  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    }
  }

  // ─── Handle Realtime messages ───
  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Realtime session created`);
      session.realtimeReady = true;

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
      console.log(`[${reqId}] 📤 Session configured`);
      triggerGreeting();
      return;
    }

    if (type === 'response.audio.delta' && msg.delta) {
      session.isSpeaking = true;
      const mulawBytes = base64PCM16_24kToMulaw(msg.delta);
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        sendMulawToSmartflo(mulawBytes, smartfloSocket, session.streamSid, reqId);
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

  // ─── Trigger greeting ───
  function triggerGreeting() {
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

  // ─── Load agent config ───
  async function loadAgentConfig() {
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.23');
      const appId = Deno.env.get('BASE44_APP_ID');
      const svc = createClient({ appId, asServiceRole: true });

      let callLog = null;

      // ── Strategy 1: call_sid match ──
      if (!callLog && session.callSid) {
        const logs = await svc.entities.CallLog.filter({ call_sid: session.callSid });
        if (logs.length > 0) {
          callLog = logs[0];
          console.log(`[${reqId}] 🔍 call_sid match: ${callLog.id}`);
        }
      }

      // ── Strategy 2: Recent unclaimed calls by callee ──
      if (!callLog && session.calleeNumber) {
        const cleanCallee = session.calleeNumber.replace(/[^0-9]/g, '').slice(-10);
        const recentLogsRaw = await svc.entities.CallLog.list('-created_date', 20);
        const recentLogs = Array.isArray(recentLogsRaw) ? recentLogsRaw : (recentLogsRaw?.results || recentLogsRaw?.data || []);
        const candidates = recentLogs.filter(l => {
          const logPhone = (l.callee_number || '').replace(/[^0-9]/g, '').slice(-10);
          return logPhone === cleanCallee && !l.stream_sid && ['initiated', 'ringing', 'answered'].includes(l.status);
        });
        if (candidates.length > 0) {
          callLog = candidates[0];
          console.log(`[${reqId}] 🔍 Callee match: ${callLog.id}`);
        }
      }

      if (!callLog) {
        console.log(`[${reqId}] ⚠️ No call log found`);
        return;
      }

      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      const cache = callLog.agent_config_cache;

      if (cache && cache.system_prompt) {
        session.systemPrompt = cache.system_prompt;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (cache.persona?.voice_type) session.voiceType = cache.persona.voice_type;
        console.log(`[${reqId}] ✅ Agent config loaded: engine=${session.voiceEngine}, voice=${session.voiceType}`);
      }
    } catch (e) {
      console.error(`[${reqId}] ❌ Agent config load failed: ${e.message}`);
    }
  }

  // ─── Save call record ───
  async function saveCallRecord() {
    if (!session.callLogId) return;
    if (session._saved) return;
    session._saved = true;

    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.23');
      const appId = Deno.env.get('BASE44_APP_ID');
      const svc = createClient({ appId, asServiceRole: true });

      const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
      const duration = Math.round((Date.now() - session.startTime) / 1000);

      await svc.entities.CallLog.update(session.callLogId, {
        status: 'completed',
        transcript: transcript || '',
        duration: duration,
        call_end_time: new Date().toISOString()
      });

      console.log(`[${reqId}] 💾 Call saved: ${session.callLogId}, duration=${duration}s`);
    } catch (err) {
      console.error(`[${reqId}] ❌ Save failed: ${err.message}`);
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

        session.calleeNumber = startData.customParameters?.customer_number ||
          startData.customParameters?.called_number || startData.to || '';
        session.callerNumber = startData.from || startData.customParameters?.from || '';

        console.log(`[${reqId}] 📞 Call start: sid=${session.callSid}, callee=${session.calleeNumber}, caller=${session.callerNumber}`);

        // Reset audio conversion state
        _lastUpsampleValue = 0;
        _lastDownsampleRemainder = [];

        // Load config and apply
        await loadAgentConfig();
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        if (!session.realtimeReady) {
          console.log(`[${reqId}] ⏳ Realtime not ready, dropping media`);
          return;
        }

        const raw = atob(msg.media.payload);
        const mulawBytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
          mulawBytes[i] = raw.charCodeAt(i);
        }

        const pcm16Base64 = mulawToBase64PCM16_24k(mulawBytes);
        sendToRealtime({ type: 'input_audio_buffer.append', audio: pcm16Base64 });
        return;
      }

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Call stopped`);
        session._callEnded = true;
        if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
          session.realtimeWs.close();
        }
        await saveCallRecord();
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
    await saveCallRecord();
  };

  return response;
});