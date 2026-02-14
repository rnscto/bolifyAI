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

// Convert mu-law bytes → PCM16 Int16Array
function mulawToPcm16(mulawBytes) {
  const pcm = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm[i] = decodeMulaw(mulawBytes[i]);
  }
  return pcm;
}

// Convert PCM16 Int16Array → mu-law Uint8Array
function pcm16ToMulaw(pcmSamples) {
  const mulaw = new Uint8Array(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    mulaw[i] = encodeMulaw(pcmSamples[i]);
  }
  return mulaw;
}

// PCM16 Int16Array → base64 string (little-endian raw bytes)
function pcm16ToBase64(pcm16) {
  const buffer = new Uint8Array(pcm16.length * 2);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < pcm16.length; i++) {
    view.setInt16(i * 2, pcm16[i], true); // little-endian
  }
  return btoa(String.fromCharCode(...buffer));
}

// base64 string → PCM16 Int16Array (little-endian)
function base64ToPcm16(b64) {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  const pcm = new Int16Array(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getInt16(i * 2, true);
  }
  return pcm;
}

// ─── Save Call Record ───

async function saveCallRecord(session, reqId, duration) {
  if (!session.callLogId) {
    console.log(`[${reqId}] ⚠️ No callLogId, skipping save`);
    return;
  }
  if (session._saved) {
    console.log(`[${reqId}] ⚠️ Already saved, skipping duplicate`);
    return;
  }
  session._saved = true;

  try {
    const transcript = session.transcript
      .map(t => `${t.speaker}: ${t.text}`)
      .join('\n');

    // Generate AI summary using standard chat completions
    let summary = '';
    if (transcript && transcript.trim().length > 20) {
      try {
        const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
        // Use same deployment for summary (it also supports text) or fallback
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
          console.log(`[${reqId}] 📝 Summary: ${summary.substring(0, 80)}...`);
        }
      } catch (sumErr) {
        console.error(`[${reqId}] ⚠️ Summary failed: ${sumErr.message}`);
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

// ─── Connect to Azure OpenAI Realtime API ───

function connectToRealtimeAPI(session, smartfloSocket, reqId) {
  const endpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '').replace(/^https?:\/\//, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

  // Azure OpenAI Realtime WebSocket URL (GA format)
  const realtimeUrl = `wss://${endpoint}/openai/realtime?api-version=2025-04-01-preview&deployment=${deployment}`;

  console.log(`[${reqId}] 🔗 Connecting to Realtime API: wss://${endpoint}/openai/realtime?deployment=${deployment}`);

  const realtimeWs = new WebSocket(realtimeUrl, {
    headers: {
      'api-key': apiKey
    }
  });

  realtimeWs.onopen = () => {
    console.log(`[${reqId}] ✅ Realtime API connected`);

    // Configure the session
    const sessionConfig = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: session.systemPrompt,
        voice: 'shimmer',
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
    };

    realtimeWs.send(JSON.stringify(sessionConfig));
    console.log(`[${reqId}] 📤 Session configured with system prompt (${session.systemPrompt.length} chars)`);
  };

  realtimeWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'session.created':
          console.log(`[${reqId}] ✅ Realtime session created`);
          break;

        case 'session.updated':
          console.log(`[${reqId}] ✅ Realtime session updated`);
          break;

        case 'input_audio_buffer.speech_started':
          console.log(`[${reqId}] 🗣️ User speech started`);
          // Barge-in: clear any audio being sent to Smartflo
          if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
            smartfloSocket.send(JSON.stringify({
              event: 'clear',
              streamSid: session.streamSid
            }));
          }
          session._isModelSpeaking = false;
          break;

        case 'input_audio_buffer.speech_stopped':
          console.log(`[${reqId}] 🔇 User speech stopped`);
          break;

        case 'conversation.item.input_audio_transcription.completed':
          if (msg.transcript?.trim()) {
            console.log(`[${reqId}] 🗣️ Customer: "${msg.transcript.trim()}"`);
            session.transcript.push({ speaker: 'Customer', text: msg.transcript.trim() });
          }
          break;

        case 'response.audio.delta':
          // Stream audio back to Smartflo
          if (msg.delta && smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
            session._isModelSpeaking = true;
            const pcm16 = base64ToPcm16(msg.delta);
            const mulawData = pcm16ToMulaw(pcm16);

            // Send in chunks padded to multiples of 160 bytes
            const CHUNK_SIZE = 800;
            for (let i = 0; i < mulawData.length; i += CHUNK_SIZE) {
              if (smartfloSocket.readyState !== WebSocket.OPEN) break;
              const end = Math.min(i + CHUNK_SIZE, mulawData.length);
              let chunk = mulawData.slice(i, end);

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
          break;

        case 'response.audio.done':
          console.log(`[${reqId}] 📤 Audio response complete`);
          session._isModelSpeaking = false;
          // Send a mark to track playback completion
          if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
            smartfloSocket.send(JSON.stringify({
              event: 'mark',
              streamSid: session.streamSid,
              mark: { name: `rt_done_${Date.now()}` }
            }));
          }
          break;

        case 'response.audio_transcript.delta':
          // Accumulate AI response transcript
          if (msg.delta) {
            if (!session._currentAIText) session._currentAIText = '';
            session._currentAIText += msg.delta;
          }
          break;

        case 'response.audio_transcript.done':
          if (session._currentAIText?.trim()) {
            console.log(`[${reqId}] 🤖 AI: "${session._currentAIText.trim()}"`);
            session.transcript.push({ speaker: 'AI', text: session._currentAIText.trim() });
          }
          session._currentAIText = '';
          break;

        case 'response.done':
          console.log(`[${reqId}] ✅ Response complete`);
          break;

        case 'error':
          console.error(`[${reqId}] ❌ Realtime API error:`, JSON.stringify(msg.error));
          break;

        default:
          // Log other events at debug level
          break;
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ Realtime message parse error:`, err.message);
    }
  };

  realtimeWs.onerror = (err) => {
    console.error(`[${reqId}] ❌ Realtime WS error`);
  };

  realtimeWs.onclose = (ev) => {
    console.log(`[${reqId}] 🔴 Realtime WS closed: code=${ev.code}`);
  };

  return realtimeWs;
}

// ─── Main WebSocket Handler ───

Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWebSocket = upgrade === 'websocket';

  console.log(`[${reqId}] 📨 ${req.method} ${req.url}, ws=${isWebSocket}`);

  // Inject App ID header if missing
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
    const wssUrl = `${protocol}://${host}/functions/streamAudio`;

    return new Response(JSON.stringify({
      status: 'ready',
      version: 'v6.0-realtime-api',
      wss_url: wssUrl,
      info: 'Uses Azure OpenAI Realtime API (gpt-realtime-mini) for speech-to-speech'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Upgrade WebSocket
  let socket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    socket = upgraded.socket;
    response = upgraded.response;
    console.log(`[${reqId}] ✅ WebSocket upgraded`);
  } catch (err) {
    console.error(`[${reqId}] ❌ Upgrade failed: ${err.message}`);
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  // Session state
  const session = {
    streamSid: null,
    callSid: null,
    callLogId: null,
    transcript: [],
    startTime: Date.now(),
    systemPrompt: 'You are a friendly AI voice assistant for a business. Be professional, helpful, and concise. Keep responses to 1-3 sentences. Speak naturally.',
    _saved: false,
    _isModelSpeaking: false,
    _currentAIText: '',
    _realtimeWs: null
  };

  socket.onopen = () => {
    console.log(`[${reqId}] 🟢 Smartflo socket opened`);
  };

  socket.onmessage = async (event) => {
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
        console.log(`[${reqId}] 📞 Call start: stream=${session.streamSid}`);

        // Load agent config from CallLog cache
        try {
          const { createClient } = await import('npm:@base44/sdk@0.8.18');
          const appId = Deno.env.get('BASE44_APP_ID');
          const anonClient = createClient({ appId });

          let callLog = null;

          if (session.callSid) {
            try {
              const logs = await anonClient.entities.CallLog.filter({ call_sid: session.callSid });
              if (logs.length > 0) callLog = logs[0];
            } catch (e) { /* ignore */ }
          }

          if (!callLog && session.streamSid) {
            try {
              const logs = await anonClient.entities.CallLog.filter({ stream_sid: session.streamSid });
              if (logs.length > 0) callLog = logs[0];
            } catch (e) { /* ignore */ }
          }

          if (!callLog) {
            try {
              const recentLogs = await anonClient.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 1);
              if (recentLogs.length > 0) callLog = recentLogs[0];
            } catch (e) { /* ignore */ }
            if (!callLog) {
              try {
                const initiatedLogs = await anonClient.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 1);
                if (initiatedLogs.length > 0) callLog = initiatedLogs[0];
              } catch (e) { /* ignore */ }
            }
          }

          try { anonClient.cleanup(); } catch (_) { /* ignore */ }

          if (callLog) {
            session.callLogId = callLog.id;
            console.log(`[${reqId}] 📍 Found call log: ${callLog.id}`);

            // Update call log with stream/call sids
            const updateFields = {};
            if (session.streamSid && !callLog.stream_sid) updateFields.stream_sid = session.streamSid;
            if (session.callSid && callLog.call_sid !== session.callSid) updateFields.call_sid = session.callSid;
            if (Object.keys(updateFields).length > 0) {
              try {
                await base44.asServiceRole.entities.CallLog.update(callLog.id, updateFields);
              } catch (e) { /* ignore */ }
            }

            // Load cached agent config
            const cache = callLog.agent_config_cache;
            if (cache && cache.system_prompt) {
              let prompt = cache.system_prompt;
              if (cache.knowledge_base_content) {
                prompt += `\n\nKNOWLEDGE BASE:\n${cache.knowledge_base_content}`;
              }
              session.systemPrompt = prompt;
              console.log(`[${reqId}] ✅ Agent config loaded (${session.systemPrompt.length} chars)`);
            }
          }
        } catch (e) {
          console.error(`[${reqId}] ❌ Agent config lookup failed: ${e.message}`);
        }

        // Connect to Azure OpenAI Realtime API
        session._realtimeWs = connectToRealtimeAPI(session, socket, reqId);
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        // Forward audio to Realtime API
        if (session._realtimeWs && session._realtimeWs.readyState === WebSocket.OPEN) {
          // Decode mu-law → PCM16 → base64
          const raw = atob(msg.media.payload);
          const mulawBytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) {
            mulawBytes[i] = raw.charCodeAt(i);
          }

          const pcm16 = mulawToPcm16(mulawBytes);
          const pcmBase64 = pcm16ToBase64(pcm16);

          session._realtimeWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: pcmBase64
          }));
        }
        return;
      }

      if (msg.event === 'mark') {
        // Mark received from Smartflo (playback tracking)
        return;
      }

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Smartflo stop event`);
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        if (session._realtimeWs && session._realtimeWs.readyState === WebSocket.OPEN) {
          session._realtimeWs.close();
        }
        await saveCallRecord(session, reqId, duration);
        return;
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ Message error: ${err.message}`);
    }
  };

  socket.onclose = async () => {
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Smartflo socket closed, duration=${duration}s, transcript=${session.transcript.length} entries`);
    if (session._realtimeWs && session._realtimeWs.readyState === WebSocket.OPEN) {
      session._realtimeWs.close();
    }
    if (session.callLogId && !session._saved) {
      await saveCallRecord(session, reqId, duration);
    }
  };

  socket.onerror = () => {
    console.error(`[${reqId}] ❌ Smartflo socket error`);
    if (session._realtimeWs && session._realtimeWs.readyState === WebSocket.OPEN) {
      session._realtimeWs.close();
    }
  };

  return response;
});