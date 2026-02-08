import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Call states
const CALL_STATES = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  SPEAKING: 'SPEAKING'
};

// VAD Configuration
const VAD_CONFIG = {
  SPEECH_THRESHOLD: 500, // RMS threshold for speech detection
  SILENCE_CHUNKS_FOR_END: 8, // Chunks of silence to mark end of speech
  BARGE_IN_THRESHOLD: 1500 // High energy threshold for barge-in detection
};

Deno.serve(async (req) => {
  console.log('[streamAudio] ==== NEW REQUEST ====');
  console.log('[streamAudio] Method:', req.method);
  console.log('[streamAudio] URL:', req.url);
  console.log('[streamAudio] Headers:');
  for (const [key, value] of req.headers) {
    if (key.includes('upgrade') || key.includes('connection') || key.includes('host')) {
      console.log(`  ${key}: ${value}`);
    }
  }

  // Only upgrade if it's a WebSocket request
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    console.log('[streamAudio] WebSocket upgrade detected, attempting upgrade...');
    try {
      const { socket, response } = Deno.upgradeWebSocket(req);
      const url = new URL(req.url);
      const callSid = url.searchParams.get('call_sid');
      console.log('[streamAudio] ✓ WebSocket upgraded successfully for call_sid:', callSid);

  let base44;
  try {
    base44 = createClientFromRequest(req);
  } catch (error) {
    console.log('Base44 client creation skipped:', error.message);
  }

  // Call context
  let callState = CALL_STATES.IDLE;
  let streamSid = null;
  let callLog = null;
  let agent = null;
  let lead = null;
  let conversationHistory = [];
  let audioBuffer = [];
  let hasSpeechStarted = false;
  let consecutiveSilentChunks = 0;
  let isProcessing = false;

  socket.onopen = async () => {
    console.log('WebSocket opened for call:', callSid);
    if (base44 && callSid) {
      try {
        const callLogs = await base44.asServiceRole.entities.CallLog.filter({ call_sid: callSid });
        if (callLogs.length > 0) {
          callLog = callLogs[0];
          agent = await base44.asServiceRole.entities.Agent.get(callLog.agent_id);
          lead = await base44.asServiceRole.entities.Lead.get(callLog.lead_id);
        }
      } catch (error) {
        console.error('Error loading call data:', error);
      }
    }
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.event === 'connected') {
        console.log('Stream connected');
        socket.send(JSON.stringify({ event: 'connected' }));
      }

      if (data.event === 'start') {
        streamSid = data.start?.streamSid;
        console.log('Call started, streamSid:', streamSid);
        callState = CALL_STATES.SPEAKING;
        
        // Send welcome message
        const welcomeText = agent?.system_prompt?.substring(0, 100) || 'Hello, how can I help?';
        await sendTTSAudio(socket, welcomeText, `welcome_${Date.now()}`, agent);
      }

      if (data.event === 'media' && data.media) {
        const audioPayload = data.media.payload;
        
        if (callState === CALL_STATES.LISTENING) {
          await handleListeningMedia(audioPayload, socket, agent, lead);
        } else if (callState === CALL_STATES.SPEAKING) {
          await handleSpeakingMedia(audioPayload, socket);
        }
      }

      if (data.event === 'mark') {
        console.log('Mark received:', data.mark?.name);
        callState = CALL_STATES.LISTENING;
        audioBuffer = [];
        hasSpeechStarted = false;
        consecutiveSilentChunks = 0;
      }

      if (data.event === 'clear') {
        console.log('Barge-in detected, stopping speech');
        callState = CALL_STATES.LISTENING;
      }

      if (data.event === 'stop') {
        console.log('Call stopped');
        await saveCallRecord(base44, callLog, conversationHistory);
        socket.close();
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  };

  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  socket.onclose = () => {
    console.log('WebSocket closed for call:', callSid);
  };

  // Handle incoming media while listening
  async function handleListeningMedia(audioPayload, socket, agent, lead) {
    try {
      if (isProcessing) return;

      const muLawBytes = Uint8Array.from(atob(audioPayload), c => c.charCodeAt(0));
      const pcmSamples = decodeMulaw(muLawBytes);
      const rms = getChunkRMS(pcmSamples);

      audioBuffer.push(...pcmSamples);

      if (rms > VAD_CONFIG.SPEECH_THRESHOLD) {
        hasSpeechStarted = true;
        consecutiveSilentChunks = 0;
      } else if (hasSpeechStarted) {
        consecutiveSilentChunks++;
      }

      // End of utterance detected
      if (hasSpeechStarted && consecutiveSilentChunks >= VAD_CONFIG.SILENCE_CHUNKS_FOR_END) {
        callState = CALL_STATES.PROCESSING;
        isProcessing = true;

        // Transcribe and process
        const wavBuffer = createWavBuffer(audioBuffer);
        const userText = await transcribeAudio(wavBuffer);

        if (userText) {
          console.log('Transcribed:', userText);
          conversationHistory.push({ role: 'user', content: userText });

          // Get AI response
          const aiText = await generateResponse(conversationHistory, agent, lead);
          conversationHistory.push({ role: 'assistant', content: aiText });

          // Send TTS
          callState = CALL_STATES.SPEAKING;
          await sendTTSAudio(socket, aiText, `response_${Date.now()}`, agent);
        }

        audioBuffer = [];
        hasSpeechStarted = false;
        consecutiveSilentChunks = 0;
        isProcessing = false;
      }
    } catch (error) {
      console.error('Error handling listening media:', error);
      isProcessing = false;
    }
  }

  // Handle incoming media while speaking (detect barge-in)
  async function handleSpeakingMedia(audioPayload, socket) {
    try {
      const muLawBytes = Uint8Array.from(atob(audioPayload), c => c.charCodeAt(0));
      const pcmSamples = decodeMulaw(muLawBytes);
      const rms = getChunkRMS(pcmSamples);

      if (rms > VAD_CONFIG.BARGE_IN_THRESHOLD) {
        console.log('Barge-in detected, sending clear');
        socket.send(JSON.stringify({ event: 'clear', streamSid }));
        callState = CALL_STATES.LISTENING;
      }
    } catch (error) {
      console.error('Error handling speaking media:', error);
    }
  }

  return response;
});

// Mu-law decoding
function decodeMulaw(muLawBytes) {
  const pcmSamples = new Int16Array(muLawBytes.length);
  for (let i = 0; i < muLawBytes.length; i++) {
    const muLaw = muLawBytes[i] ^ 0xFF;
    const sign = (muLaw & 0x80) ? -1 : 1;
    const exponent = (muLaw >> 4) & 0x07;
    const mantissa = muLaw & 0x0F;
    const sample = sign * ((1 << (exponent + 3)) + (mantissa << (exponent + 3 - 4)));
    pcmSamples[i] = Math.max(-32768, Math.min(32767, sample));
  }
  return pcmSamples;
}

// Mu-law encoding
function encodeMulaw(pcmSamples) {
  const muLawBytes = new Uint8Array(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    let sample = pcmSamples[i];
    const sign = (sample < 0) ? 0x80 : 0x00;
    sample = Math.abs(sample);
    const exponent = Math.max(0, Math.floor(Math.log2(sample / 16 + 0.5)) - 3);
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    muLawBytes[i] = (sign | (exponent << 4) | mantissa) ^ 0xFF;
  }
  return muLawBytes;
}

// Calculate RMS energy
function getChunkRMS(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// Create WAV buffer from PCM samples
function createWavBuffer(pcmSamples) {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const wavData = new ArrayBuffer(44 + pcmSamples.length * 2);
  const view = new DataView(wavData);

  // WAV header
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcmSamples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, pcmSamples.length * 2, true);

  // PCM data
  const pcmView = new Int16Array(wavData, 44);
  for (let i = 0; i < pcmSamples.length; i++) {
    pcmView[i] = pcmSamples[i];
  }

  return new Uint8Array(wavData);
}

// Transcribe audio using Azure Speech Services
async function transcribeAudio(wavBuffer) {
  try {
    const response = await fetch(
      `${Deno.env.get('AZURE_SPEECH_ENDPOINT')}/speech/recognition/conversation/cognitiveservices/v1?language=en-IN`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': Deno.env.get('AZURE_SPEECH_KEY'),
          'Content-Type': 'audio/wav'
        },
        body: wavBuffer
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.DisplayText || '';
    }
    return '';
  } catch (error) {
    console.error('STT error:', error);
    return '';
  }
}

// Generate response using Azure OpenAI
async function generateResponse(conversationHistory, agent, lead) {
  try {
    const systemPrompt = buildSystemPrompt(agent, lead);

    const response = await fetch(
      `${Deno.env.get('AZURE_OPENAI_ENDPOINT')}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2024-08-01-preview`,
      {
        method: 'POST',
        headers: {
          'api-key': Deno.env.get('AZURE_OPENAI_KEY'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversationHistory
          ],
          max_tokens: 150,
          temperature: 0.7
        })
      }
    );

    if (response.ok) {
      const data = await response.json();
      let text = data.choices?.[0]?.message?.content || 'I understand.';
      return cleanTextForTTS(text);
    }
    return 'I understand.';
  } catch (error) {
    console.error('LLM error:', error);
    return 'I understand.';
  }
}

// Build dynamic system prompt
function buildSystemPrompt(agent, lead) {
  let prompt = `You are ${agent?.name || 'an AI agent'}. `;
  
  if (agent?.system_prompt) {
    prompt += agent.system_prompt + '\n';
  }

  if (agent?.persona) {
    prompt += `Tone: ${agent.persona.tone || 'professional'}. Language: ${agent.persona.language || 'en-IN'}. `;
  }

  if (lead) {
    prompt += `You are speaking with ${lead.name}. `;
  }

  prompt += 'Keep responses brief and natural for voice. No emojis, markdown, or special formatting.';
  
  return prompt;
}

// Clean text for TTS compatibility
function cleanTextForTTS(text) {
  return text
    .replace(/[^\w\s,.'?!-]/g, '')
    .replace(/\*\*/g, '')
    .replace(/\n+/g, ' ')
    .substring(0, 300);
}

// Send TTS audio via WebSocket
async function sendTTSAudio(socket, text, markName, agent) {
  try {
    const response = await fetch(
      `${Deno.env.get('AZURE_SPEECH_ENDPOINT')}/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': Deno.env.get('AZURE_SPEECH_KEY'),
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'raw-8khz-16bit-mono-pcm'
        },
        body: `<speak version="1.0" xml:lang="en-IN"><voice xml:lang="en-IN" name="en-IN-BharatNeural">${text}</voice></speak>`
      }
    );

    if (response.ok) {
      const audioBuffer = await response.arrayBuffer();
      const pcmSamples = new Int16Array(audioBuffer);
      const muLawBytes = encodeMulaw(pcmSamples);
      const base64Audio = btoa(String.fromCharCode(...muLawBytes));

      // Send in 160-byte chunks (20ms at 8kHz)
      const chunkSize = 160;
      for (let i = 0; i < muLawBytes.length; i += chunkSize) {
        const chunk = base64Audio.substring(i, Math.min(i + chunkSize, muLawBytes.length));
        socket.send(JSON.stringify({
          event: 'media',
          streamSid: Date.now().toString(),
          media: { payload: chunk }
        }));
      }

      // Send mark when done
      socket.send(JSON.stringify({
        event: 'mark',
        streamSid: Date.now().toString(),
        mark: { name: markName }
      }));
    }
  } catch (error) {
    console.error('TTS error:', error);
  }
}

// Save call record
async function saveCallRecord(base44, callLog, conversationHistory) {
  if (!base44 || !callLog) return;

  try {
    const transcript = conversationHistory
      .map(msg => `${msg.role === 'user' ? 'Customer' : 'Agent'}: ${msg.content}`)
      .join('\n');

    await base44.asServiceRole.entities.CallLog.update(callLog.id, {
      status: 'completed',
      transcript: transcript,
      call_end_time: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error saving call record:', error);
  }
}