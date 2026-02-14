import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

const STATE = {
  IDLE: 'IDLE',
  SPEAKING: 'SPEAKING',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING'
};

const VAD_CONFIG = {
  SPEECH_THRESHOLD: 120,
  SILENCE_CHUNKS_FOR_END: 15,
  MIN_SPEECH_CHUNKS: 4,
  NO_SPEECH_TIMEOUT_MS: 10000,
  MAX_NO_SPEECH_PROMPTS: 3,
  BARGE_IN_THRESHOLD: 300,
  BARGE_IN_CONSECUTIVE: 3
};



// Mu-law decoding
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

// Mu-law encoding
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
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mulaw;
}

// Calculate RMS energy
function getChunkRMS(bytes) {
  let sumSq = 0;
  for (let i = 0; i < bytes.length; i++) {
    const sample = decodeMulaw(bytes[i]);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / bytes.length);
}

// Create WAV buffer from PCM samples
function createWavBuffer(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }
  return new Uint8Array(buffer);
}

// Escape XML for SSML
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// STT: Azure Speech Services
async function transcribeAudio(reqId, wavBuffer) {
  try {
    const sttUrl = `https://${Deno.env.get('AZURE_SPEECH_REGION')}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-IN&format=detailed`;

    const response = await fetch(sttUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': Deno.env.get('AZURE_SPEECH_KEY'),
        'Content-Type': 'audio/wav'
      },
      body: wavBuffer
    });

    if (response.ok) {
      const result = await response.json();
      const text = result.DisplayText || (result.NBest?.[0]?.Display) || '';
      console.log(`[${reqId}] ✅ STT: "${text.substring(0, 100)}"`);
      return text;
    }

    console.error(`[${reqId}] ❌ STT failed: ${response.status}`);
    return '';
  } catch (err) {
    console.error(`[${reqId}] ❌ STT error:`, err.message);
    return '';
  }
}

// LLM: Azure OpenAI
async function generateResponse(reqId, conversationHistory, systemPrompt) {
  const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
  const url = `${baseUrl}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2024-08-01-preview`;

  console.log(`[${reqId}] 🔮 LLM Request - System prompt: "${systemPrompt.substring(0, 100)}..." (${systemPrompt.length} chars)`);
  console.log(`[${reqId}] 🔮 LLM Request - History length: ${conversationHistory.length} messages`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': Deno.env.get('AZURE_OPENAI_KEY')
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory.slice(-16)
        ],
        max_completion_tokens: 250
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[${reqId}] ❌ LLM failed: ${response.status} - ${errBody}`);
      return 'Sorry, please say that again.';
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    
    // Strip non-TTS-safe characters
    return text
      .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
      .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
      .replace(/[\*\#\[\]`~_{}|\\<>^=+]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'Sorry, please say that again.';
  } catch (err) {
    console.error(`[${reqId}] ❌ LLM error:`, err.message);
    return 'Sorry, please say that again.';
  }
}

// Send TTS audio via WebSocket
async function sendTTSAudio(socket, session, reqId, text, markName) {
  if (socket.readyState !== WebSocket.OPEN) {
    console.error(`[${reqId}] ❌ Socket not open for TTS`);
    return false;
  }

  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-IN'>
    <voice name='en-IN-BharatNeural'>
      <prosody rate='0%'>${escapeXml(text)}</prosody>
    </voice>
  </speak>`;

  try {
    const response = await fetch(Deno.env.get('AZURE_SPEECH_ENDPOINT'), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': Deno.env.get('AZURE_SPEECH_KEY'),
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'raw-8khz-16bit-mono-pcm'
      },
      body: ssml
    });

    if (!response.ok) {
      console.error(`[${reqId}] ❌ TTS failed: ${response.status}`);
      return false;
    }

    const pcmBuffer = await response.arrayBuffer();
    const pcmSamples = new Int16Array(pcmBuffer);

    // Convert PCM 16-bit → mu-law 8-bit
    const mulawData = new Uint8Array(pcmSamples.length);
    for (let i = 0; i < pcmSamples.length; i++) {
      mulawData[i] = encodeMulaw(pcmSamples[i]);
    }

    // Send in 800-byte chunks (100ms @ 8kHz)
    const CHUNK_SIZE = 800;
    for (let i = 0; i < mulawData.length; i += CHUNK_SIZE) {
      if (socket.readyState !== WebSocket.OPEN) return false;

      const end = Math.min(i + CHUNK_SIZE, mulawData.length);
      let chunk = mulawData.slice(i, end);

      // Pad to multiple of 160
      if (chunk.length % 160 !== 0) {
        const paddedLen = Math.ceil(chunk.length / 160) * 160;
        const padded = new Uint8Array(paddedLen);
        padded.set(chunk);
        padded.fill(0xFF, chunk.length);
        chunk = padded;
      }

      const payload = btoa(String.fromCharCode(...chunk));
      socket.send(JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: { payload }
      }));
    }

    // Send mark when done
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        event: 'mark',
        streamSid: session.streamSid,
        mark: { name: markName }
      }));
    }

    console.log(`[${reqId}] 📤 TTS sent: ${pcmSamples.length} samples`);
    return true;
  } catch (err) {
    console.error(`[${reqId}] ❌ TTS error:`, err.message);
    return false;
  }
}

// Save call record
async function saveCallRecord(session, reqId, duration, base44Client) {
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

    // Generate AI summary from transcript
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
          console.log(`[${reqId}] 📝 Summary generated: ${summary.substring(0, 80)}...`);
        }
      } catch (sumErr) {
        console.error(`[${reqId}] ⚠️ Summary generation failed: ${sumErr.message}`);
      }
    }

    const updateData = {
      status: 'completed',
      transcript: transcript || '',
      duration: duration,
      call_end_time: new Date().toISOString()
    };
    if (summary) updateData.conversation_summary = summary;

    // Call updateCallLog function via HTTP (WebSocket has no user auth for asServiceRole)
    try {
      const funcUrl = session._functionBaseUrl ? `${session._functionBaseUrl}/functions/updateCallLog` : null;
      const appId = Deno.env.get('BASE44_APP_ID');
      if (funcUrl) {
        const res = await fetch(funcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Base44-App-Id': appId,
            'X-Base44-Service-Role': 'true'
          },
          body: JSON.stringify({ call_log_id: session.callLogId, ...updateData })
        });
        if (!res.ok) throw new Error(`updateCallLog returned ${res.status}`);
      } else {
        await base44Client.asServiceRole.entities.CallLog.update(session.callLogId, updateData);
      }
    } catch (serviceErr) {
      console.log(`[${reqId}] ⚠️ Primary save failed (${serviceErr.message}), trying fallback`);
      try {
        await base44Client.asServiceRole.entities.CallLog.update(session.callLogId, updateData);
      } catch (e2) {
        console.error(`[${reqId}] ❌ Fallback also failed: ${e2.message}`);
      }
    }

    console.log(`[${reqId}] 💾 Call saved: ${session.callLogId}, duration=${duration}s, transcript=${transcript.length} chars`);
  } catch (err) {
    console.error(`[${reqId}] ❌ Save failed:`, err.message);
    // Last resort: try minimal update via HTTP
    try {
      const appId = Deno.env.get('BASE44_APP_ID');
      const funcUrl = session._functionBaseUrl ? `${session._functionBaseUrl}/functions/updateCallLog` : null;
      if (funcUrl) {
        await fetch(funcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Base44-App-Id': appId,
            'X-Base44-Service-Role': 'true'
          },
          body: JSON.stringify({
            call_log_id: session.callLogId,
            status: 'completed',
            call_end_time: new Date().toISOString(),
            duration: duration
          })
        });
        console.log(`[${reqId}] 💾 Minimal save succeeded via HTTP`);
      }
    } catch (minErr) {
      console.error(`[${reqId}] ❌ Minimal save also failed:`, minErr.message);
    }
  }
}

// Main WebSocket handler
Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);

  // Log request
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWebSocket = upgrade === 'websocket';

  console.log(`[${reqId}] 📨 ${req.method} ${req.url}, ws=${isWebSocket}`);

  // Create Base44 client - inject App ID header if missing (WebSocket from Smartflo won't have it)
  console.log(`[${reqId}] 🔑 Creating Base44 client from request`);
  let base44Req = req;
  if (!req.headers.get('Base44-App-Id')) {
    const appId = Deno.env.get('BASE44_APP_ID');
    if (appId) {
      const newHeaders = new Headers(req.headers);
      newHeaders.set('Base44-App-Id', appId);
      base44Req = new Request(req.url, { method: req.method, headers: newHeaders });
      console.log(`[${reqId}] 🔧 Injected Base44-App-Id from env`);
    }
  }
  const base44 = createClientFromRequest(base44Req);
  console.log(`[${reqId}] ✅ Base44 client created`);

      // Return status for non-WebSocket requests
      if (!isWebSocket) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    const protocol = req.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
    const wssUrl = `${protocol}://${host}/functions/streamAudio`;

    console.log(`[${reqId}] 📡 WebSocket URL: ${wssUrl}`);

    return new Response(JSON.stringify({
      status: 'ready',
      version: 'v5.7-lazy-client',
      wss_url: wssUrl,
      info: 'Use the wss_url above to connect WebSocket from Smartflo'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

    // Upgrade WebSocket first
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

    // base44 client already created above from request

      // Session state
  const session = {
    state: STATE.IDLE,
    streamSid: null,
    callSid: null,
    agentConfig: null,
    conversationHistory: [],
    transcript: [],
    callLogId: null,
    speechBuffer: [],
    hasSpeechStarted: false,
    consecutiveSilentChunks: 0,
    bargeInConsecutive: 0,
    noSpeechTimer: null,
    noSpeechCount: 0,
    totalMediaReceived: 0,
    pendingMarkName: null,
    startTime: Date.now(),
    systemPrompt: 'You are a friendly AI voice assistant. Be professional and concise. Keep responses to 1-3 sentences. Use only plain text, no emojis or special characters.',
    agentId: null
  };

  function setState(newState) {
    console.log(`[${reqId}] 🔄 ${session.state} → ${newState}`);
    session.state = newState;
  }

  function clearTimers() {
    if (session.noSpeechTimer) {
      clearTimeout(session.noSpeechTimer);
      session.noSpeechTimer = null;
    }
  }

  function transitionToListening() {
    setState(STATE.LISTENING);
    clearTimers();
    session.hasSpeechStarted = false;
    session.consecutiveSilentChunks = 0;
    session.speechBuffer = [];
    session.bargeInConsecutive = 0;
    startNoSpeechTimer();
  }

  function startNoSpeechTimer() {
    session.noSpeechTimer = setTimeout(async () => {
      if (session.state !== STATE.LISTENING) return;
      session.noSpeechCount++;
      console.log(`[${reqId}] 🔇 No speech timeout #${session.noSpeechCount}`);

      if (socket.readyState !== WebSocket.OPEN) {
        clearTimers();
        setState(STATE.IDLE);
        return;
      }

      if (session.noSpeechCount >= VAD_CONFIG.MAX_NO_SPEECH_PROMPTS) {
        const goodbye = 'It seems there is a connection issue. Please call back. Thank you.';
        session.conversationHistory.push({ role: 'assistant', content: goodbye });
        session.transcript.push({ speaker: 'AI', text: goodbye });
        await sendTTSAudio(socket, session, reqId, goodbye, `tts_goodbye_${Date.now()}`);
        clearTimers();
        setState(STATE.IDLE);
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        await saveCallRecord(session, reqId, duration, base44);
        return;
      }

      const prompt = session.noSpeechCount === 1 ? 'Hello? Can you hear me?' : 'Please speak now.';
      session.conversationHistory.push({ role: 'assistant', content: prompt });
      session.transcript.push({ speaker: 'AI', text: prompt });
      await startSpeaking(prompt);
    }, VAD_CONFIG.NO_SPEECH_TIMEOUT_MS);
  }

  function handleListeningMedia(bytes) {
    const rms = getChunkRMS(bytes);
    const isSpeech = rms >= VAD_CONFIG.SPEECH_THRESHOLD;

    if (isSpeech) {
      if (!session.hasSpeechStarted) {
        console.log(`[${reqId}] 🗣️ Speech onset (rms=${rms.toFixed(0)})`);
        session.hasSpeechStarted = true;
        clearTimers();
      }
      session.speechBuffer.push(bytes);
      session.consecutiveSilentChunks = 0;
    } else if (session.hasSpeechStarted) {
      session.speechBuffer.push(bytes);
      session.consecutiveSilentChunks++;

      if (session.consecutiveSilentChunks >= VAD_CONFIG.SILENCE_CHUNKS_FOR_END) {
        const speechChunks = session.speechBuffer.length - session.consecutiveSilentChunks;
        console.log(`[${reqId}] 🔇 Speech ended: ${speechChunks} chunks`);

        if (speechChunks >= VAD_CONFIG.MIN_SPEECH_CHUNKS) {
          processUserAudio();
        } else {
          session.hasSpeechStarted = false;
          session.consecutiveSilentChunks = 0;
          session.speechBuffer = [];
          startNoSpeechTimer();
        }
      }
    }
  }

  function handleSpeakingMedia(bytes) {
    const rms = getChunkRMS(bytes);
    if (rms >= VAD_CONFIG.BARGE_IN_THRESHOLD) {
      session.bargeInConsecutive++;
      if (session.bargeInConsecutive >= VAD_CONFIG.BARGE_IN_CONSECUTIVE) {
        console.log(`[${reqId}] 🛑 Barge-in detected`);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            event: 'clear',
            streamSid: session.streamSid
          }));
        }
        session.pendingMarkName = null;
        transitionToListening();
        session.hasSpeechStarted = true;
        session.speechBuffer.push(bytes);
      }
    } else {
      session.bargeInConsecutive = 0;
    }
  }

  async function startSpeaking(text) {
    if (socket.readyState !== WebSocket.OPEN) {
      clearTimers();
      setState(STATE.IDLE);
      return;
    }

    clearTimers();
    setState(STATE.SPEAKING);
    session.speechBuffer = [];
    session.bargeInConsecutive = 0;

    const markName = `tts_${Date.now()}`;
    session.pendingMarkName = markName;

    const sent = await sendTTSAudio(socket, session, reqId, text, markName);

    if (!sent) {
      session.pendingMarkName = null;
      if (socket.readyState === WebSocket.OPEN) {
        transitionToListening();
      } else {
        clearTimers();
        setState(STATE.IDLE);
      }
      return;
    }

    // Mark timeout fallback (30s)
    setTimeout(() => {
      if (session.state === STATE.SPEAKING && session.pendingMarkName === markName) {
        console.log(`[${reqId}] ⏱️ Mark timeout, forcing listening`);
        session.pendingMarkName = null;
        transitionToListening();
      }
    }, 30000);
  }

  async function processUserAudio() {
    if (session.state === STATE.PROCESSING) return;

    setState(STATE.PROCESSING);
    clearTimers();

    const audioChunks = session.speechBuffer.splice(0);
    session.speechBuffer = [];
    session.hasSpeechStarted = false;
    session.consecutiveSilentChunks = 0;

    try {
      // Combine mu-law bytes to PCM
      const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
      const allMulaw = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of audioChunks) {
        allMulaw.set(chunk, offset);
        offset += chunk.length;
      }

      const pcmSamples = new Int16Array(allMulaw.length);
      for (let i = 0; i < allMulaw.length; i++) {
        pcmSamples[i] = decodeMulaw(allMulaw[i]);
      }

      // Audio stats
      let sumSq = 0;
      for (let i = 0; i < pcmSamples.length; i++) {
        sumSq += pcmSamples[i] * pcmSamples[i];
      }
      const rms = Math.sqrt(sumSq / pcmSamples.length);
      console.log(`[${reqId}] 🔊 Audio: ${pcmSamples.length} samples, rms=${rms.toFixed(0)}`);

      if (rms < 80) {
        console.log(`[${reqId}] 🔇 Too quiet`);
        transitionToListening();
        return;
      }

      // Transcribe
      const wavBuffer = createWavBuffer(pcmSamples, 8000);
      const customerText = await transcribeAudio(reqId, wavBuffer);

      if (customerText?.trim()) {
        console.log(`[${reqId}] 🗣️ Customer: "${customerText}"`);
        session.transcript.push({ speaker: 'Customer', text: customerText });
        session.conversationHistory.push({ role: 'user', content: customerText });
        session.noSpeechCount = 0;

        // Get LLM response
        const aiResponse = await generateResponse(reqId, session.conversationHistory, session.systemPrompt);
        console.log(`[${reqId}] 🤖 AI: "${aiResponse}"`);
        session.transcript.push({ speaker: 'AI', text: aiResponse });
        session.conversationHistory.push({ role: 'assistant', content: aiResponse });

        await startSpeaking(aiResponse);
      } else {
        console.log(`[${reqId}] 🔇 STT empty`);
        session.noSpeechCount++;
        if (session.noSpeechCount >= 3) {
          const prompt = 'I could not hear you clearly. Please try again.';
          session.conversationHistory.push({ role: 'assistant', content: prompt });
          session.transcript.push({ speaker: 'AI', text: prompt });
          await startSpeaking(prompt);
          session.noSpeechCount = 0;
        } else {
          transitionToListening();
        }
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ Processing error: ${err.message}`);
      transitionToListening();
    }
  }

  // WebSocket handlers
  socket.onopen = () => {
    console.log(`[${reqId}] 🟢 Socket opened`);
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      const eventType = msg.event;

      if (eventType === 'connected') {
        console.log(`[${reqId}] ✅ Connected event`);
        return;
      }

      if (eventType === 'start') {
        const startData = msg.start || {};
        session.streamSid = startData.streamSid;
        session.callSid = startData.callSid;

        console.log(`[${reqId}] 📞 Call start: stream=${session.streamSid}`);

        // Store base URL for later HTTP calls (e.g. saveCallRecord)
        const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
        const protocol = req.headers.get('x-forwarded-proto') || 'https';
        session._functionBaseUrl = `${protocol}://${host}`;

        // Fetch agent config by calling getAgentConfig function via HTTP
        // (WebSocket connections from Smartflo have no user auth, so asServiceRole won't work directly)
        let agentLoaded = false;
        try {
          console.log(`[${reqId}] 🔍 Fetching agent config for call_sid: ${session.callSid}, stream_sid: ${session.streamSid}`);
          
          const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
          const protocol = req.headers.get('x-forwarded-proto') || 'https';
          const configUrl = `${protocol}://${host}/functions/getAgentConfig`;
          const appId = Deno.env.get('BASE44_APP_ID');
          
          const configRes = await fetch(configUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Base44-App-Id': appId,
              'X-Base44-Service-Role': 'true'
            },
            body: JSON.stringify({
              call_sid: session.callSid,
              stream_sid: session.streamSid
            })
          });
          
          if (configRes.ok) {
            const configData = await configRes.json();
            console.log(`[${reqId}] 📍 getAgentConfig response: success=${configData.success}, callLogId=${configData.callLogId}`);
            
            if (configData.success && configData.agent) {
              session.callLogId = configData.callLogId;
              session.agentId = configData.agent.id;
              session.agentConfig = configData.agent;
              console.log(`[${reqId}] ✅ Agent found: ${configData.agent.name}`);

              // Use agent's custom system prompt
              if (configData.agent.system_prompt && configData.agent.system_prompt.trim()) {
                session.systemPrompt = configData.agent.system_prompt;
                console.log(`[${reqId}] ✅ Using custom system prompt (${session.systemPrompt.length} chars)`);
              }

              // Append knowledge base content
              if (configData.knowledgeDocs && configData.knowledgeDocs.length > 0) {
                const kbContext = configData.knowledgeDocs.map(doc => `[${doc.title}]\n${doc.content}`).join('\n\n---\n\n');
                session.systemPrompt = `${session.systemPrompt}\n\nKNOWLEDGE BASE:\n${kbContext}`;
                console.log(`[${reqId}] ✅ Added ${configData.knowledgeDocs.length} KB docs (total: ${session.systemPrompt.length} chars)`);
              }
              agentLoaded = true;
            } else {
              console.log(`[${reqId}] ❌ Agent config not found: ${configData.error || 'unknown'}`);
            }
          } else {
            const errText = await configRes.text();
            console.error(`[${reqId}] ❌ getAgentConfig HTTP ${configRes.status}: ${errText}`);
          }
        } catch (e) {
          console.error(`[${reqId}] ❌ Agent config lookup failed: ${e.message}`);
        }

        // Log final system prompt status
        if (agentLoaded) {
          console.log(`[${reqId}] ✅ Agent configuration loaded successfully`);
        } else {
          console.log(`[${reqId}] ⚠️ Using default system prompt (agent config not loaded)`);
        }
        console.log(`[${reqId}] 📝 Final system prompt length: ${session.systemPrompt.length} chars`);

        // Send welcome
        const welcome = 'Hello! How can I help you today?';
        session.conversationHistory.push({ role: 'assistant', content: welcome });
        session.transcript.push({ speaker: 'AI', text: welcome });

        await startSpeaking(welcome);
        return;
      }

      if (eventType === 'media' && msg.media?.payload) {
        session.totalMediaReceived++;

        const raw = atob(msg.media.payload);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
          bytes[i] = raw.charCodeAt(i);
        }

        if (session.state === STATE.SPEAKING) {
          handleSpeakingMedia(bytes);
        } else if (session.state === STATE.LISTENING) {
          handleListeningMedia(bytes);
        }
        return;
      }

      if (eventType === 'mark' && msg.mark?.name) {
        if (session.state === STATE.SPEAKING && msg.mark.name === session.pendingMarkName) {
          console.log(`[${reqId}] ✅ Mark confirmed`);
          session.pendingMarkName = null;
          transitionToListening();
        }
        return;
      }

      if (eventType === 'stop') {
        console.log(`[${reqId}] 📴 Stop event`);
        clearTimers();
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        await saveCallRecord(session, reqId, duration, base44);
        return;
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ Message error: ${err.message}`);
    }
  };

  socket.onclose = async () => {
    clearTimers();
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Socket closed, duration=${duration}s, transcript entries=${session.transcript.length}`);
    // Always attempt to save on close in case stop event was missed
    if (session.callLogId && session.state !== STATE.IDLE) {
      await saveCallRecord(session, reqId, duration, base44);
    }
    session.state = STATE.IDLE;
  };

  socket.onerror = () => {
    clearTimers();
    session.state = STATE.IDLE;
    console.error(`[${reqId}] ❌ Socket error`);
  };

  return response;
});