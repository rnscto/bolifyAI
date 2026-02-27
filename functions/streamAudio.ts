import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

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

// Convert mu-law 8kHz → PCM16 24kHz LE base64 (upsample 3x for Realtime API)
function mulawToBase64PCM16_24k(mulawBytes) {
  // Decode mu-law to PCM16 at 8kHz
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm8k[i] = decodeMulaw(mulawBytes[i]);
  }
  
  // Upsample 8kHz → 24kHz (3x linear interpolation)
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length - 1; i++) {
    const s0 = pcm8k[i];
    const s1 = pcm8k[i + 1];
    pcm24k[i * 3] = s0;
    pcm24k[i * 3 + 1] = Math.round(s0 + (s1 - s0) / 3);
    pcm24k[i * 3 + 2] = Math.round(s0 + (s1 - s0) * 2 / 3);
  }
  // Last sample
  const last = pcm8k.length - 1;
  pcm24k[last * 3] = pcm8k[last];
  pcm24k[last * 3 + 1] = pcm8k[last];
  pcm24k[last * 3 + 2] = pcm8k[last];

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
function base64PCM16_24kToMulaw(base64Pcm16) {
  const raw = atob(base64Pcm16);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  
  // Read PCM16 LE samples safely using DataView (avoids alignment issues)
  const numSamples = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  
  // Downsample 24kHz → 8kHz (take every 3rd sample)
  const downsampledLen = Math.floor(numSamples / 3);
  const mulaw = new Uint8Array(downsampledLen);
  for (let i = 0; i < downsampledLen; i++) {
    const sample = view.getInt16(i * 3 * 2, true);
    mulaw[i] = encodeMulaw(sample);
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

    let summary = '';
    if (transcript && transcript.trim().length > 20) {
      try {
        const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
        const summaryRes = await fetch(
          `${baseUrl}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2024-08-01-preview`,
          {
            method: 'POST',
            headers: {
              'api-key': Deno.env.get('AZURE_OPENAI_KEY'),
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messages: [
                { role: 'system', content: 'Summarize this call transcript in 2-3 sentences. Mention the outcome and key points discussed.' },
                { role: 'user', content: transcript }
              ],
              max_completion_tokens: 200
            })
          }
        );
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          summary = summaryData.choices?.[0]?.message?.content || '';
        }
      } catch (sumErr) {
        console.error(`[${reqId}] ⚠️ Summary generation failed: ${sumErr.message}`);
      }
    }

    const { createClient } = await import('npm:@base44/sdk@0.8.18');
    const appId = Deno.env.get('BASE44_APP_ID');
    const serviceClient = createClient({ appId, asServiceRole: true });

    await serviceClient.entities.CallLog.update(session.callLogId, {
      status: 'completed',
      transcript: transcript || '',
      duration: duration,
      call_end_time: new Date().toISOString(),
      ...(summary ? { conversation_summary: summary } : {})
    });

    console.log(`[${reqId}] 💾 Call saved: ${session.callLogId}, duration=${duration}s`);

    // NOTE: Campaign lead updates and next-batch triggers are handled by
    // smartfloWebhook (no-recording calls) and campaignPostCall (entity automation on CallLog update).
    // streamAudio only saves the CallLog — no campaign logic here to avoid race conditions.

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
    transcript: [],
    startTime: Date.now(),
    systemPrompt: 'You are a friendly AI voice assistant. Be professional and concise. Keep responses to 1-3 sentences.',
    voiceEngine: 'realtime',  // 'realtime' or 'azure_speech'
    voiceType: 'alloy',       // Default voice, overridden from agent config
    _saved: false,
    realtimeWs: null,         // WebSocket connection to Azure Realtime API
    realtimeReady: false,     // Whether session.created has been received
    isSpeaking: false,        // Track if model is currently outputting audio
    _ttsAbort: null,          // AbortController for Azure Speech TTS (hybrid mode)
    chatHistory: []           // GPT-5-nano conversation history (azure_speech mode)
  };

  // ─── Connect to Azure Realtime API ───
  function connectRealtime() {
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_KEY');

    if (!realtimeUrl || !realtimeKey) {
      console.error(`[${reqId}] ❌ Missing AZURE_REALTIME_ENDPOINT or AZURE_REALTIME_KEY`);
      return;
    }

    // Convert https:// to wss:// for WebSocket and append api-key as query param
    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    // Append api-key to URL since Deno WebSocket doesn't support custom headers
    const separator = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${separator}api-key=${encodeURIComponent(realtimeKey)}`;
    console.log(`[${reqId}] 🔌 Connecting to Azure Realtime: ${wsUrl.substring(0, 80)}...`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${reqId}] ✅ Azure Realtime WebSocket connected`);
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
    };

    ws.onerror = (event) => {
      console.error(`[${reqId}] ❌ Azure Realtime error`);
    };

    session.realtimeWs = ws;
  }

  // ─── Handle messages FROM Azure Realtime API ───
  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Realtime session created`);
      session.realtimeReady = true;

      // Configure session based on voice engine
      const isHybrid = session.voiceEngine === 'azure_speech';
      const sessionConfig = {
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      };

      if (isHybrid) {
        // Hybrid mode: Realtime API for STT/VAD only → GPT-5-nano for LLM → Azure Speech TTS
        sessionConfig.instructions = 'You are a transcription-only assistant. Do not respond.';
        sessionConfig.modalities = ['text'];
        sessionConfig.voice = 'alloy';
        // Initialize chat history with system prompt
        session.chatHistory = [{ role: 'system', content: session.systemPrompt }];
        console.log(`[${reqId}] 🔀 Hybrid mode: Realtime STT → GPT-5-nano → Azure Speech TTS (${session.voiceType})`);
      } else {
        // Standard Realtime API with built-in voice
        sessionConfig.instructions = session.systemPrompt;
        sessionConfig.voice = session.voiceType;
        sessionConfig.output_audio_format = 'pcm16';
      }

      sendToRealtime({ type: 'session.update', session: sessionConfig });
      console.log(`[${reqId}] 📤 Session configured: engine=${session.voiceEngine}, voice=${session.voiceType}`);
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
        // Send in chunks padded to 160-byte boundaries
        const CHUNK_SIZE = 800;
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

          const payload = btoa(String.fromCharCode(...chunk));
          smartfloSocket.send(JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: { payload }
          }));
        }
      }
      return;
    }

    if (type === 'response.audio.done') {
      session.isSpeaking = false;
      console.log(`[${reqId}] 🔊 Audio response complete`);
      return;
    }

    // ─── Transcription of user's speech ───
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

    if (type === 'error') {
      console.error(`[${reqId}] ❌ Realtime API error:`, JSON.stringify(msg.error || msg));
      return;
    }

    // Log other events at debug level
    if (!['response.created', 'response.output_item.added', 'response.content_part.added',
          'response.output_item.done', 'response.content_part.done', 'response.done',
          'conversation.item.created', 'rate_limits.updated'].includes(type)) {
      console.log(`[${reqId}] 📩 Realtime event: ${type}`);
    }
  }

  // ─── Send message to Azure Realtime API ───
  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
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
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>
      <voice name='${voiceName}'>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</voice>
    </speak>`;

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
        const CHUNK_SIZE = 800;
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

          const payload = btoa(String.fromCharCode(...chunk));
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

  // ─── GPT-5-nano text generation (hybrid mode) ───
  async function generateGpt5NanoResponse(userText) {
    const nanoEndpoint = Deno.env.get('AZURE_GPT5_NANO_ENDPOINT')?.replace(/\/+$/, '');
    const nanoKey = Deno.env.get('AZURE_GPT5_NANO_API_KEY');
    const nanoDeployment = Deno.env.get('AZURE_GPT5_NANO_DEPLOYMENT');

    if (!nanoEndpoint || !nanoKey || !nanoDeployment) {
      console.error(`[${reqId}] ❌ Missing GPT-5-nano secrets`);
      return;
    }

    // Add user message to chat history
    session.chatHistory.push({ role: 'user', content: userText });

    try {
      const url = `${nanoEndpoint}/openai/deployments/${nanoDeployment}/chat/completions?api-version=2024-08-01-preview`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'api-key': nanoKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: session.chatHistory,
          max_completion_tokens: 300
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[${reqId}] ❌ GPT-5-nano error: ${response.status} ${errText}`);
        return;
      }

      const data = await response.json();
      const aiText = data.choices?.[0]?.message?.content?.trim();

      if (aiText) {
        console.log(`[${reqId}] 🧠 GPT-5-nano: "${aiText.substring(0, 100)}"`);
        session.chatHistory.push({ role: 'assistant', content: aiText });
        session.transcript.push({ speaker: 'AI', text: aiText });
        synthesizeWithAzureSpeech(aiText);
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ GPT-5-nano failed: ${err.message}`);
    }
  }

  // ─── Load agent config from CallLog cache ───
  async function loadAgentConfig() {
    try {
      // Use base44 service role from the request-based client
      // Also try a fresh standalone client as fallback
      let svc;
      try {
        svc = base44.asServiceRole;
        // Quick test to see if service role works
        console.log(`[${reqId}] 🔑 Using request-based base44.asServiceRole`);
      } catch (e) {
        console.log(`[${reqId}] ⚠️ base44.asServiceRole failed: ${e.message}, creating standalone client`);
        const { createClient } = await import('npm:@base44/sdk@0.8.18');
        const appId = Deno.env.get('BASE44_APP_ID');
        const standalone = createClient({ appId });
        svc = standalone.asServiceRole;
      }

      let callLog = null;

      // Strategy 1: Look up by call_sid from Smartflo
      if (session.callSid) {
        try {
          console.log(`[${reqId}] 🔍 Searching by call_sid: ${session.callSid}`);
          const logs = await svc.entities.CallLog.filter({ call_sid: session.callSid });
          console.log(`[${reqId}] 🔍 call_sid results: ${logs.length} records`);
          if (logs.length > 0) {
            callLog = logs[0];
            console.log(`[${reqId}] 🔍 call_sid match: id=${callLog.id}, has_cache=${!!callLog.agent_config_cache}`);
          }
        } catch (e) {
          console.log(`[${reqId}] ⚠️ call_sid filter failed: ${e.message}`);
        }
      }

      // Strategy 2: Look up by stream_sid
      if (!callLog && session.streamSid) {
        try {
          const logs = await svc.entities.CallLog.filter({ stream_sid: session.streamSid });
          if (logs.length > 0) callLog = logs[0];
          console.log(`[${reqId}] 🔍 stream_sid lookup: found=${!!callLog}`);
        } catch (e) {
          console.log(`[${reqId}] ⚠️ stream_sid filter failed: ${e.message}`);
        }
      }

      // Strategy 3: Look for most recent ringing/initiated call (fallback)
      if (!callLog) {
        try {
          const logs = await svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 1);
          if (logs.length > 0) callLog = logs[0];
          console.log(`[${reqId}] 🔍 ringing lookup: found=${!!callLog}${callLog ? ', id=' + callLog.id : ''}`);
        } catch (e) {
          console.log(`[${reqId}] ⚠️ ringing filter failed: ${e.message}`);
        }
        if (!callLog) {
          try {
            const logs = await svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 1);
            if (logs.length > 0) callLog = logs[0];
            console.log(`[${reqId}] 🔍 initiated lookup: found=${!!callLog}${callLog ? ', id=' + callLog.id : ''}`);
          } catch (e) {
            console.log(`[${reqId}] ⚠️ initiated filter failed: ${e.message}`);
          }
        }
      }

      if (callLog) {
        session.callLogId = callLog.id;
        const cache = callLog.agent_config_cache;
        console.log(`[${reqId}] 📍 Found call log: ${callLog.id}`);
        console.log(`[${reqId}] 📍 Cache present: ${!!cache}, cache keys: ${cache ? Object.keys(cache).join(',') : 'N/A'}`);
        if (cache?.persona) {
          console.log(`[${reqId}] 📍 Persona: ${JSON.stringify(cache.persona)}`);
        }

        // Update call log with stream/call sid
        const updateFields = {};
        if (session.streamSid && !callLog.stream_sid) updateFields.stream_sid = session.streamSid;
        if (session.callSid && callLog.call_sid !== session.callSid) updateFields.call_sid = session.callSid;
        if (Object.keys(updateFields).length > 0) {
          try {
            await svc.entities.CallLog.update(callLog.id, updateFields);
          } catch (e) { /* ignore */ }
        }

        if (cache && cache.system_prompt) {
          session.systemPrompt = cache.system_prompt;
          if (cache.knowledge_base_content) {
            session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${cache.knowledge_base_content}`;
          }
          if (cache.lead_context) {
            console.log(`[${reqId}] 👤 Lead context loaded (${cache.lead_context.length} chars)`);
          }
          console.log(`[${reqId}] ✅ Agent config loaded (${session.systemPrompt.length} chars)`);
        }
        // Load voice engine and voice type from agent persona
        if (cache && cache.persona) {
          if (cache.persona.voice_engine) {
            session.voiceEngine = cache.persona.voice_engine;
            console.log(`[${reqId}] 🔧 Set voiceEngine = ${session.voiceEngine}`);
          }
          if (cache.persona.voice_type) {
            if (session.voiceEngine === 'realtime') {
              const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
              const voice = cache.persona.voice_type.toLowerCase();
              if (validVoices.includes(voice)) {
                session.voiceType = voice;
              } else {
                console.log(`[${reqId}] ⚠️ Voice '${cache.persona.voice_type}' not valid for realtime, keeping default`);
              }
            } else {
              session.voiceType = cache.persona.voice_type;
            }
          }
          console.log(`[${reqId}] 🎙️ FINAL: engine=${session.voiceEngine}, voice=${session.voiceType}`);
        } else {
          console.log(`[${reqId}] ⚠️ No persona in cache, defaults: engine=${session.voiceEngine}, voice=${session.voiceType}`);
        }
      } else {
        console.log(`[${reqId}] ⚠️ No call log found at all. callSid=${session.callSid}, streamSid=${session.streamSid}`);
      }
    } catch (e) {
      console.error(`[${reqId}] ❌ Agent config load failed: ${e.message}`);
      console.error(`[${reqId}] ❌ Stack: ${e.stack}`);
    }
  }

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
        console.log(`[${reqId}] 📞 Call start: stream=${session.streamSid}, call=${session.callSid}`);

        // Load agent config, then connect to Realtime API
        await loadAgentConfig();
        console.log(`[${reqId}] 🚀 Connecting Realtime with engine=${session.voiceEngine}, voice=${session.voiceType}`);
        connectRealtime();
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