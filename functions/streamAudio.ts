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

    // Also directly update CampaignLead if this was a campaign call
    try {
      const campaignLeads = await serviceClient.entities.CampaignLead.filter({ call_log_id: session.callLogId });
      if (campaignLeads.length > 0) {
        const cl = campaignLeads[0];
        console.log(`[${reqId}] 📊 Found campaign lead ${cl.id}, updating status...`);
        
        // Determine outcome from transcript
        let outcome = 'contacted';
        if (!transcript || transcript.trim().length < 30) {
          outcome = 'no_answer';
        } else if (summary) {
          try {
            const analysis = await serviceClient.integrations.Core.InvokeLLM({
              prompt: `Analyze this call briefly and determine the outcome.\nTRANSCRIPT: ${transcript}\nSUMMARY: ${summary}\nDetermine outcome: "interested","not_interested","callback","no_answer","converted","contacted".\nRules: "interested"=clear interest/pricing ask, "callback"=asked to call later, "not_interested"=declined, "no_answer"=no real conversation/voicemail, "converted"=committed, "contacted"=spoke but unclear`,
              response_json_schema: { type: "object", properties: { outcome: { type: "string" }, summary: { type: "string" } } }
            });
            outcome = analysis.outcome || 'contacted';
            if (analysis.summary) summary = analysis.summary;
          } catch (e) {
            console.log(`[${reqId}] ⚠️ LLM analysis failed, using default: ${e.message}`);
          }
        }

        await serviceClient.entities.CampaignLead.update(cl.id, {
          status: 'completed',
          outcome: outcome,
          conversation_summary: summary || '',
          transcript: transcript || '',
          call_duration: duration || 0
        });
        console.log(`[${reqId}] ✅ CampaignLead ${cl.id} → completed, outcome: ${outcome}`);

        // Update Lead entity
        if (cl.lead_id) {
          const leadStatusMap = { interested: 'interested', not_interested: 'not_interested', callback: 'callback', no_answer: 'callback', converted: 'converted', contacted: 'contacted' };
          await serviceClient.entities.Lead.update(cl.lead_id, {
            status: leadStatusMap[outcome] || 'contacted',
            last_call_date: new Date().toISOString()
          });
          console.log(`[${reqId}] ✅ Lead ${cl.lead_id} → ${leadStatusMap[outcome] || 'contacted'}`);
        }

        // Update Campaign counts
        const allLeads = await serviceClient.entities.CampaignLead.filter({ campaign_id: cl.campaign_id });
        const outcomes = { interested: 0, not_interested: 0, callback: 0, no_answer: 0, converted: 0, contacted: 0 };
        let completedCount = 0, failedCount = 0;
        allLeads.forEach(l => {
          if (l.status === 'completed') completedCount++;
          if (l.status === 'failed') failedCount++;
          if (l.outcome && outcomes[l.outcome] !== undefined) outcomes[l.outcome]++;
        });
        
        const campaignUpdate = { outcomes_summary: outcomes, calls_completed: completedCount, calls_failed: failedCount };
        const pendingCount = allLeads.filter(l => ['pending', 'calling'].includes(l.status)).length;
        if (pendingCount === 0) {
          campaignUpdate.status = 'completed';
          campaignUpdate.completed_at = new Date().toISOString();
        }
        await serviceClient.entities.Campaign.update(cl.campaign_id, campaignUpdate);
        console.log(`[${reqId}] ✅ Campaign ${cl.campaign_id} updated: completed=${completedCount}, pending=${pendingCount}`);
      }
    } catch (clErr) {
      console.error(`[${reqId}] ⚠️ CampaignLead update failed: ${clErr.message}`);
    }

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
    voiceType: 'alloy',       // Default voice, overridden from agent config
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
          voice: session.voiceType,
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
        // Load voice type from agent persona
        if (cache && cache.persona && cache.persona.voice_type) {
          // Azure Realtime API (gpt-4o-realtime) supports specific voice IDs.
          // Map display names to the correct Azure Realtime voice deployment name.
          // Dragon HD / Turbo / Multilingual voices use: en-IN-{Name}DragonHDLatest format
          const displayName = cache.persona.voice_type;
          const realtimeVoiceId = mapVoiceToRealtimeId(displayName);
          session.voiceType = realtimeVoiceId;
          console.log(`[${reqId}] 🎙️ Voice set: ${displayName} → ${realtimeVoiceId}`);
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