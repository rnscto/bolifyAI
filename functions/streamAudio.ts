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

    const { createClient } = await import('npm:@base44/sdk@0.8.18');
    const appId = Deno.env.get('BASE44_APP_ID');
    const serviceClient = createClient({ appId, asServiceRole: true });

    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

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
        ...(enrichedSummary ? { conversation_summary: enrichedSummary } : {})
      });
      console.log(`[${reqId}] 💾 Call already ${currentLog.status}, added transcript+analysis: ${session.callLogId}`);
    } else {
      await serviceClient.entities.CallLog.update(session.callLogId, {
        status: 'completed',
        transcript: transcript || '',
        duration: duration,
        call_end_time: new Date().toISOString(),
        lead_status_updated: leadStatus,
        ...(enrichedSummary ? { conversation_summary: enrichedSummary } : {})
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

    // ===== STEP 5: Auto-enroll in email sequence (fire-and-forget) =====
    if (currentLog.lead_id && qualificationTier && !['disqualified'].includes(qualificationTier) && transcript.length > 30) {
      serviceClient.functions.invoke('autoEnrollSequence', {
        lead_id: currentLog.lead_id,
        client_id: currentLog.client_id,
        qualification_tier: qualificationTier,
        call_outcome: leadStatus,
        call_summary: summary.substring(0, 500),
        call_topics: keyTopics.slice(0, 10),
        objections: objections,
        intent_signals: intentSignals,
        ai_score: leadScore
      }).then(r => {
        if (r?.enrolled) console.log(`[${reqId}] ✉️ Auto-enrolled in sequence: ${r.sequence_name}`);
      }).catch(e => console.error(`[${reqId}] ⚠️ Auto-enroll failed: ${e.message}`));
    }

    // ===== STEP 6: Trigger post-call action extraction (fire-and-forget) =====
    if (transcript.length > 50) {
      serviceClient.functions.invoke('postCallActionExtractor', {
        call_log_id: session.callLogId
      }).then(() => console.log(`[${reqId}] 📋 Action extraction triggered`))
        .catch(e => console.error(`[${reqId}] ⚠️ Action extraction failed: ${e.message}`));
    }

    // ===== STEP 7: Directly update CampaignLead if this is a campaign call =====
    // The entity automation (campaignPostCall) should also handle this, but as a
    // reliability measure we update the CampaignLead directly here to prevent
    // "stuck calling" issues when the automation doesn't fire or races.
    try {
      const campaignLeads = await serviceClient.entities.CampaignLead.filter({ call_log_id: session.callLogId });
      if (campaignLeads.length > 0) {
        const cl = campaignLeads[0];
        if (cl.status === 'calling') {
          await serviceClient.entities.CampaignLead.update(cl.id, {
            status: 'completed',
            outcome: leadStatus || 'contacted',
            conversation_summary: enrichedSummary || summary || 'Call completed.',
            transcript: transcript || '',
            call_duration: duration || 0
          });
          console.log(`[${reqId}] 📋 CampaignLead ${cl.id} (${cl.lead_name}) updated to completed directly`);

          // Trigger next campaign call via executeCampaign (fire-and-forget)
          serviceClient.functions.invoke('executeCampaign', {
            campaign_id: cl.campaign_id,
            _internal: true
          }).then(r => console.log(`[${reqId}] 🚀 Next campaign batch triggered: ${JSON.stringify(r).substring(0, 200)}`))
            .catch(e => console.error(`[${reqId}] ⚠️ Next batch trigger failed: ${e.message}`));
        }
      }
    } catch (clErr) {
      console.error(`[${reqId}] ⚠️ CampaignLead direct update failed: ${clErr.message}`);
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

  function applySessionConfig() {
    const isHybrid = session.voiceEngine === 'azure_speech';
    const sessionConfig = {
      input_audio_format: 'pcm16',
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.6,
        prefix_padding_ms: 500,
        silence_duration_ms: 700
      }
    };

    // Inject live IST timestamp so the agent knows the current time
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}. Use this to compute relative times (e.g. "30 minutes later", "tomorrow 10 AM"). Always state callback times in IST.\n`;

    if (isHybrid) {
      sessionConfig.instructions = 'You are a transcription-only assistant. Do not respond.';
      sessionConfig.modalities = ['text'];
      sessionConfig.voice = 'alloy';
      session.chatHistory = [{ role: 'system', content: timeInjection + session.systemPrompt }];
      console.log(`[${reqId}] 🔀 Hybrid mode: Realtime STT → LLM → Azure Speech TTS (${session.voiceType})`);
    } else {
      sessionConfig.modalities = ['text', 'audio'];
      sessionConfig.instructions = timeInjection + session.systemPrompt;
      sessionConfig.voice = session.voiceType;
      sessionConfig.output_audio_format = 'pcm16';
    }

    sendToRealtime({ type: 'session.update', session: sessionConfig });
    console.log(`[${reqId}] 📤 Session configured: engine=${session.voiceEngine}, voice=${session.voiceType}`);
  }

  // ─── Handle messages FROM Azure Realtime API ───
  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Realtime session created`);
      session.realtimeReady = true;

      // If agent config already loaded (race won by DB), apply full config immediately
      if (session._agentConfigReady) {
        console.log(`[${reqId}] ⚡ Agent config was ready before Realtime — applying immediately`);
        applySessionConfig();
      } else {
        // Realtime connected first — send minimal config so audio flows immediately
        // Will be reconfigured with proper agent prompt once loadAgentConfig completes
        sendToRealtime({ type: 'session.update', session: {
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          modalities: ['text', 'audio'],
          voice: 'alloy',
          instructions: 'You are a friendly AI voice assistant. Greet the caller warmly. Be professional and concise.',
          turn_detection: { type: 'server_vad', threshold: 0.6, prefix_padding_ms: 500, silence_duration_ms: 700 }
        }});
        console.log(`[${reqId}] 📤 Minimal config sent (agent config still loading)`);
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

  // ─── Clean text for TTS (remove markdown, emojis, special chars) ───
  function cleanTextForTTS(text) {
    return text
      .replace(/\*\*([^*]+)\*\*/g, '$1')  // **bold** → bold
      .replace(/\*([^*]+)\*/g, '$1')       // *italic* → italic
      .replace(/__([^_]+)__/g, '$1')       // __underline__ → underline
      .replace(/_([^_]+)_/g, '$1')         // _italic_ → italic
      .replace(/#{1,6}\s*/g, '')           // # headers
      .replace(/```[\s\S]*?```/g, '')      // code blocks
      .replace(/`([^`]+)`/g, '$1')         // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link](url) → link
      .replace(/[😊🙏👋✅❌🎯📋🕐⚠️💡🔊🎙️]/gu, '') // common emojis
      .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // emoticons
      .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // misc symbols
      .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // transport
      .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // flags
      .replace(/[\u{2600}-\u{26FF}]/gu, '')   // misc symbols
      .replace(/[\u{2700}-\u{27BF}]/gu, '')   // dingbats
      .replace(/\n{2,}/g, '. ')            // multiple newlines → pause
      .replace(/\n/g, ' ')                 // single newline → space
      .replace(/\s{2,}/g, ' ')            // multiple spaces
      .trim();
  }

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
  // PHASE 1: Fast — find CallLog, extract agent persona & prompt, apply to Realtime session
  // PHASE 2: Background — claim CallLog with stream_sid (non-blocking)
  async function loadAgentConfig() {
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.18');
      const appId = Deno.env.get('BASE44_APP_ID');
      const svc = createClient({ appId, asServiceRole: true });

      let callLog = null;
      const cutoff = new Date(Date.now() - 60000).toISOString();

      // ── SINGLE fast query: get recent unclaimed ringing/initiated calls ──
      try {
        const recentLogs = await svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 5);
        const unclaimed = recentLogs.filter(l => !l.stream_sid && l.created_date >= cutoff);
        if (unclaimed.length === 1) {
          callLog = unclaimed[0];
          console.log(`[${reqId}] ⚡ Fast match: ringing call ${callLog.id}`);
        } else if (unclaimed.length === 0) {
          // Try initiated
          const initLogs = await svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 5);
          const unclaimedInit = initLogs.filter(l => !l.stream_sid && l.created_date >= cutoff);
          if (unclaimedInit.length === 1) {
            callLog = unclaimedInit[0];
            console.log(`[${reqId}] ⚡ Fast match: initiated call ${callLog.id}`);
          }
        }
      } catch (e) {
        console.log(`[${reqId}] ⚠️ Fast lookup failed: ${e.message}`);
      }

      // Fallback: call_sid (single attempt, no retries — speed over perfection)
      if (!callLog && session.callSid) {
        const numericCore = session.callSid.replace(/^[^-]*-/, '').replace(/\.[^.]*$/, '');
        for (const sid of [session.callSid, numericCore]) {
          if (callLog || !sid) continue;
          try {
            const logs = await svc.entities.CallLog.filter({ call_sid: sid });
            if (logs.length > 0) {
              callLog = logs[0];
              console.log(`[${reqId}] 🔍 call_sid match: ${callLog.id}`);
            }
          } catch (e) {}
        }
      }

      if (!callLog) {
        console.log(`[${reqId}] ⚠️ No call log found. callSid=${session.callSid}`);
        return;
      }

      // ── IMMEDIATELY extract config and apply to session (before any DB writes) ──
      session.callLogId = callLog.id;
      const cache = callLog.agent_config_cache;

      if (cache && cache.system_prompt) {
        session.systemPrompt = cache.system_prompt;
        if (cache.knowledge_base_content) {
          session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${cache.knowledge_base_content}`;
        }
        console.log(`[${reqId}] ✅ Agent config loaded (${session.systemPrompt.length} chars)`);
      }

      if (cache && cache.persona) {
        if (cache.persona.voice_engine) session.voiceEngine = cache.persona.voice_engine;
        if (cache.persona.voice_type) {
          if (session.voiceEngine === 'realtime') {
            const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
            const voice = cache.persona.voice_type.toLowerCase();
            if (validVoices.includes(voice)) session.voiceType = voice;
          } else {
            session.voiceType = cache.persona.voice_type;
          }
        }
      }
      console.log(`[${reqId}] 🎙️ engine=${session.voiceEngine}, voice=${session.voiceType}`);

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

        // Connect Realtime + load agent config IN PARALLEL for minimum latency
        // Both run concurrently — whichever finishes second triggers applySessionConfig
        connectRealtime();
        loadAgentConfig().then(() => {
          session._agentConfigReady = true;
          console.log(`[${reqId}] 🚀 Agent config ready: engine=${session.voiceEngine}, voice=${session.voiceType}`);
          // If Realtime is already connected, apply config now
          if (session.realtimeReady) {
            applySessionConfig();
          }
        });
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