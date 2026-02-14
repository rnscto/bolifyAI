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

// Convert mu-law 8kHz → PCM16 LE base64 (for Realtime API input_audio_buffer.append)
function mulawToBase64PCM16(mulawBytes) {
  const pcm16 = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm16[i] = decodeMulaw(mulawBytes[i]);
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert PCM16 LE base64 (from Realtime API audio delta) → mu-law bytes
function base64PCM16ToMulaw(base64Pcm16) {
  const raw = atob(base64Pcm16);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  // Interpret as Int16 LE
  const pcm16 = new Int16Array(bytes.buffer);
  const mulaw = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    mulaw[i] = encodeMulaw(pcm16[i]);
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
    const anonClient = createClient({ appId });

    await anonClient.entities.CallLog.update(session.callLogId, {
      status: 'completed',
      transcript: transcript || '',
      duration: duration,
      call_end_time: new Date().toISOString(),
      ...(summary ? { conversation_summary: summary } : {})
    });

    try { anonClient.cleanup(); } catch (_) { /* ignore */ }
    console.log(`[${reqId}] 💾 Call saved: ${session.callLogId}, duration=${duration}s`);
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
      version: 'v6.0-realtime-mini',
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
    _saved: false,
    realtimeWs: null,         // WebSocket connection to Azure Realtime API
    realtimeReady: false,     // Whether session.created has been received
    isSpeaking: false         // Track if model is currently outputting audio
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

      // Configure session: audio format, turn detection, instructions
      sendToRealtime({
        type: 'session.update',
        session: {
          instructions: session.systemPrompt,
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      });
      console.log(`[${reqId}] 📤 Session configured with system prompt (${session.systemPrompt.length} chars)`);
      return;
    }

    if (type === 'session.updated') {
      console.log(`[${reqId}] ✅ Realtime session updated`);
      return;
    }

    // ─── Audio output from model → send to Smartflo caller ───
    if (type === 'response.audio.delta' && msg.delta) {
      session.isSpeaking = true;
      // Convert PCM16 base64 from Realtime API → mu-law for Smartflo
      const mulawBytes = base64PCM16ToMulaw(msg.delta);

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

    // ─── Barge-in: user started speaking while model is responding ───
    if (type === 'input_audio_buffer.speech_started') {
      console.log(`[${reqId}] 🛑 Barge-in: user speaking, clearing Smartflo buffer`);
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        smartfloSocket.send(JSON.stringify({
          event: 'clear',
          streamSid: session.streamSid
        }));
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

  // ─── Load agent config from CallLog cache (same as before) ───
  async function loadAgentConfig() {
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.18');
      const appId = Deno.env.get('BASE44_APP_ID');
      const anonClient = createClient({ appId });

      let callLog = null;

      if (session.callSid) {
        try {
          const logs = await anonClient.entities.CallLog.filter({ call_sid: session.callSid });
          if (logs.length > 0) callLog = logs[0];
        } catch (e) {
          console.log(`[${reqId}] ⚠️ call_sid filter failed: ${e.message}`);
        }
      }

      if (!callLog && session.streamSid) {
        try {
          const logs = await anonClient.entities.CallLog.filter({ stream_sid: session.streamSid });
          if (logs.length > 0) callLog = logs[0];
        } catch (e) { /* ignore */ }
      }

      if (!callLog) {
        try {
          const logs = await anonClient.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 1);
          if (logs.length > 0) callLog = logs[0];
        } catch (e) { /* ignore */ }
        if (!callLog) {
          try {
            const logs = await anonClient.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 1);
            if (logs.length > 0) callLog = logs[0];
          } catch (e) { /* ignore */ }
        }
      }

      try { anonClient.cleanup(); } catch (_) { /* ignore */ }

      if (callLog) {
        session.callLogId = callLog.id;
        console.log(`[${reqId}] 📍 Found call log: ${callLog.id}`);

        // Update call log with stream/call sid
        const updateFields = {};
        if (session.streamSid && !callLog.stream_sid) updateFields.stream_sid = session.streamSid;
        if (session.callSid && callLog.call_sid !== session.callSid) updateFields.call_sid = session.callSid;
        if (Object.keys(updateFields).length > 0) {
          try {
            await base44.asServiceRole.entities.CallLog.update(callLog.id, updateFields);
          } catch (e) { /* ignore */ }
        }

        const cache = callLog.agent_config_cache;
        if (cache && cache.system_prompt) {
          session.systemPrompt = cache.system_prompt;
          if (cache.knowledge_base_content) {
            session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${cache.knowledge_base_content}`;
          }
          console.log(`[${reqId}] ✅ Agent config loaded (${session.systemPrompt.length} chars)`);
        }
      } else {
        console.log(`[${reqId}] ⚠️ No call log found, using default prompt`);
      }
    } catch (e) {
      console.error(`[${reqId}] ❌ Agent config load failed: ${e.message}`);
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
        connectRealtime();
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        // Forward caller audio → Azure Realtime API
        if (session.realtimeReady) {
          const raw = atob(msg.media.payload);
          const mulawBytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) {
            mulawBytes[i] = raw.charCodeAt(i);
          }

          // Convert mu-law → PCM16 base64 for Realtime API
          const pcm16Base64 = mulawToBase64PCM16(mulawBytes);

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