import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// ═══════════════════════════════════════════════════════════════════════════
// streamAudioV2 — Hybrid Voice Pipeline (no Azure Realtime API dependency)
// Pipeline: Smartflo mu-law audio → Azure Speech STT → Azure OpenAI LLM → Azure Speech TTS → Smartflo mu-law
// ═══════════════════════════════════════════════════════════════════════════

// ─── Audio Helpers ───

function decodeMulaw(b) {
  const BIAS = 33;
  let mu = ~b & 0xFF;
  const sign = (mu & 0x80) ? -1 : 1;
  const exp = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0F;
  let sample = ((mantissa << 3) + BIAS) << exp;
  sample -= BIAS;
  return sign * sample;
}

function encodeMulaw(sample) {
  const MAX = 32635, BIAS = 33;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MAX) sample = MAX;
  sample += BIAS;
  let exp = 7;
  for (; exp > 0; exp--) { if (sample & 0x4000) break; sample <<= 1; }
  return ~(sign | (exp << 4) | ((sample >> 10) & 0x0F)) & 0xFF;
}

function uint8ToBase64(bytes) {
  let b = ''; for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return btoa(b);
}

// Convert mu-law 8kHz → PCM16 16kHz LE ArrayBuffer (for Azure Speech STT)
function mulawToPcm16_16k(mulawBytes) {
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) pcm8k[i] = decodeMulaw(mulawBytes[i]);
  // Upsample 8k → 16k (2x linear interpolation)
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = pcm8k[i];
    const s1 = i < pcm8k.length - 1 ? pcm8k[i + 1] : s0;
    pcm16k[i * 2] = s0;
    pcm16k[i * 2 + 1] = Math.round((s0 + s1) / 2);
  }
  const buf = new Uint8Array(pcm16k.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < pcm16k.length; i++) view.setInt16(i * 2, pcm16k[i], true);
  return buf;
}

// ─── Save Call Record (mirrors streamAudio) ───

async function saveCallRecord(session, reqId, duration) {
  if (!session.callLogId || session._saved) return;
  session._saved = true;
  try {
    const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
    const { createClient } = await import('npm:@base44/sdk@0.8.23');
    const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

    const rawEndpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT') || '';
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
    let baseUrl = rawEndpoint.replace(/\/+$/, '');
    const oIdx = baseUrl.indexOf('/openai/'); if (oIdx > 0) baseUrl = baseUrl.substring(0, oIdx);
    const pIdx = baseUrl.indexOf('/api/projects'); if (pIdx > 0) baseUrl = baseUrl.substring(0, pIdx);

    let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0;
    let intentSignals = [], scoreBreakdown = {}, keyTopics = [];

    if (transcript && transcript.trim().length > 30) {
      try {
        const analysisRes = await fetch(`${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`, {
          method: 'POST',
          headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: `Analyze this call transcript. SCORING (total 100): Sentiment(0-25), Intent(0-30), Engagement(0-25), Keywords(0-20). Short calls with single words → lead_status "contacted", sentiment "neutral". Only "do_not_call" when customer EXPLICITLY refuses. Respond ONLY in valid JSON.` },
              { role: 'user', content: `Transcript:\n${transcript}\n\nReturn JSON: {"summary":"2-3 sentences","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0},"key_topics":[],"recommended_next_action":"..."}` }
            ],
            max_completion_tokens: 500,
            response_format: { type: "json_object" }
          })
        });
        if (analysisRes.ok) {
          const d = await analysisRes.json();
          const a = JSON.parse(d.choices?.[0]?.message?.content || '{}');
          summary = a.summary || '';
          leadStatus = a.lead_status || 'contacted';
          sentiment = a.sentiment || 'neutral';
          leadScore = Math.min(100, Math.max(0, a.lead_score || 0));
          intentSignals = a.intent_signals || [];
          scoreBreakdown = a.score_breakdown || {};
          keyTopics = a.key_topics || [];
        }
      } catch (e) { console.error(`[${reqId}] ⚠️ AI analysis error: ${e.message}`); }
    } else {
      summary = 'Call ended with minimal or no conversation.';
    }

    // Short call safeguard
    const custWords = session.transcript.filter(t => t.speaker === 'Customer').reduce((a, t) => a + t.text.split(/\s+/).length, 0);
    if (custWords <= 5 && duration < 30 && (leadStatus === 'do_not_call' || leadStatus === 'not_interested')) {
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
    }

    let tier = 'cold', tierReason = `Score ${leadScore}/100`;
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) { tier = 'hot'; }
    else if (leadScore >= 50) { tier = 'warm'; }
    else if (leadScore >= 25) { tier = 'nurture'; }
    else if (['negative', 'very_negative'].includes(sentiment)) { tier = 'disqualified'; }
    if (leadStatus === 'converted') { tier = 'hot'; }
    if (leadStatus === 'do_not_call') { tier = 'disqualified'; }

    const enrichedSummary = summary ? `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Tier: ${tier} | Signals: ${intentSignals.join(', ')}` : '';

    const currentLog = await svc.entities.CallLog.get(session.callLogId);
    const wasCompleted = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);

    const updateData = { transcript: transcript || '', duration, lead_status_updated: leadStatus, conversation_summary: enrichedSummary || summary || '' };
    if (!wasCompleted) { updateData.status = 'completed'; updateData.call_end_time = new Date().toISOString(); }
    await svc.entities.CallLog.update(session.callLogId, updateData);
    console.log(`[${reqId}] 💾 Call saved: ${session.callLogId}, score=${leadScore}, tier=${tier}`);

    // Update Lead
    if (currentLog.lead_id) {
      try {
        const lead = await svc.entities.Lead.get(currentLog.lead_id);
        await svc.entities.Lead.update(currentLog.lead_id, {
          status: leadStatus, score: leadScore, sentiment, intent_signals: intentSignals,
          score_breakdown: scoreBreakdown, qualification_tier: tier, qualification_reason: tierReason,
          tags: [...new Set([...(lead.tags || []), ...keyTopics.slice(0, 10)])],
          last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString(),
          engagement_count: (lead.engagement_count || 0) + 1,
          notes: `[Score: ${leadScore}/100 | ${sentiment} | ${tier}] ${summary.substring(0, 300)}`
        });
        console.log(`[${reqId}] 📊 Lead ${currentLog.lead_id} updated: score=${leadScore}, tier=${tier}`);
      } catch (e) { console.error(`[${reqId}] ⚠️ Lead update: ${e.message}`); }
    }

    // Voicemail for personal accounts
    if (session._personalMode && session._personalClientId) {
      try {
        const custLines = session.transcript.filter(t => t.speaker === 'Customer').map(t => t.text);
        const msg = custLines.join(' ').substring(0, 1000) || summary || 'No message';
        const sLow = (summary || '').toLowerCase();
        let cat = 'unknown';
        if (sLow.includes('spam')) cat = 'spam';
        else if (sLow.includes('business') || sLow.includes('meeting')) cat = 'business';
        else if (sLow.includes('family') || sLow.includes('friend')) cat = 'family';
        let urg = 'medium';
        if (sLow.includes('urgent') || sLow.includes('emergency')) urg = 'urgent';
        else if (cat === 'spam') urg = 'low';
        await svc.entities.VoicemailMessage.create({ client_id: session._personalClientId, call_log_id: session.callLogId, caller_number: currentLog.caller_id || '', message: summary || msg, urgency: urg, category: cat, is_read: false });
        // Telegram summary
        const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgT) {
          const cl = await svc.entities.Client.get(session._personalClientId);
          if (cl?.telegram_connected && cl?.telegram_chat_id && !cl.dnd_enabled && cl.owner_notification_channel === 'telegram') {
            const emj = cat === 'spam' ? '🚫' : cat === 'business' ? '💼' : '📋';
            fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: `${emj} <b>Call Summary</b>\n\n📱 From: <b>${currentLog.caller_id || 'Unknown'}</b>\n🏷️ ${cat}\n\n💬 ${(summary || msg).substring(0, 500)}`, parse_mode: 'HTML' })
            }).catch(() => {});
          }
        }
      } catch (e) { console.error(`[${reqId}] ⚠️ Voicemail: ${e.message}`); }
    }

    // Trigger post-call action extraction
    if (transcript.length > 50) {
      svc.functions.invoke('postCallActionExtractor', { call_log_id: session.callLogId }).catch(() => {});
    }
  } catch (err) { console.error(`[${reqId}] ❌ Save failed: ${err.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main WebSocket Handler
// ═══════════════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();

  console.log(`[${reqId}] 📨 V2 ${req.method} ${req.url}, ws=${upgrade === 'websocket'}`);

  // Non-WebSocket: return Smartflo dynamic endpoint
  if (upgrade !== 'websocket') {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    const wssUrl = `wss://${host}/functions/streamAudioV2`;
    if (req.method === 'POST') { try { const b = await req.json(); console.log(`[${reqId}] POST:`, JSON.stringify(b)); } catch (_) {} }
    return new Response(JSON.stringify({ sucess: true, wss_url: wssUrl }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Upgrade WebSocket
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
    streamSid: null, callSid: null, callLogId: null, clientId: null,
    calleeNumber: '', callerNumber: '',
    transcript: [], startTime: Date.now(),
    systemPrompt: 'You are a friendly AI voice assistant. Be professional and concise.',
    greetingMessage: '', voiceType: 'hi-IN-SwaraNeural',
    chatHistory: [], _saved: false, smartfloCallId: null,
    humanTransferNumber: '', enableAutoTransfer: true,
    hasShopify: false, _callEnded: false,
    // STT state
    _sttWs: null, _sttReady: false, _sttBuffer: [],
    // Personal mode
    _personalMode: null, _personalClientId: null, _ownerName: '',
    _isTrustedCaller: false, _trustedContactName: '',
    _midCallTgSent: false, _awaitingOwnerDecision: false, _ownerDecisionExecuted: false,
    // TTS
    _ttsAbort: null, _isSpeaking: false,
    // Config loaded flag
    _configReady: false, _greetingSent: false
  };

  // ─── Azure Speech STT via WebSocket ───
  function connectSTT() {
    const speechKey = Deno.env.get('AZURE_SPEECH_KEY');
    const speechRegion = Deno.env.get('AZURE_SPEECH_REGION');
    if (!speechKey || !speechRegion) {
      console.error(`[${reqId}] ❌ Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION`);
      return;
    }

    const sttUrl = `wss://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=hi-IN&format=simple&profanity=raw`;
    console.log(`[${reqId}] 🎤 Connecting STT: ${speechRegion}, lang=hi-IN`);

    const ws = new WebSocket(sttUrl, [], {
      headers: {
        'Ocp-Apim-Subscription-Key': speechKey,
        'Content-Type': 'audio/x-wav;codec=audio/pcm;samplerate=16000',
      }
    });

    // Note: Deno WebSocket doesn't support custom headers in constructor.
    // We'll use the REST STT approach instead for reliability.
    ws.onopen = () => {
      console.log(`[${reqId}] ✅ STT WebSocket connected`);
      session._sttReady = true;
      // Flush buffered audio
      for (const chunk of session._sttBuffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      }
      session._sttBuffer = [];
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.RecognitionStatus === 'Success' && msg.DisplayText) {
          const text = msg.DisplayText.trim();
          if (text) {
            handleCustomerSpeech(text);
          }
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      console.log(`[${reqId}] 🔴 STT closed`);
      session._sttReady = false;
      // Reconnect if call is still active
      if (!session._callEnded) { setTimeout(() => connectSTT(), 500); }
    };

    ws.onerror = () => { console.error(`[${reqId}] ❌ STT error`); };

    session._sttWs = ws;
  }

  // ─── Chunked STT via REST (more reliable than WebSocket in Deno) ───
  // Accumulate audio chunks and send to Azure STT REST API periodically
  let _audioAccumulator = [];
  let _audioAccumulatorBytes = 0;
  let _sttProcessing = false;
  let _silenceTimer = null;
  const STT_CHUNK_THRESHOLD = 16000 * 2 * 1.5; // ~1.5 seconds of 16kHz 16-bit audio
  const SILENCE_TIMEOUT = 800; // ms after last audio to trigger STT

  function feedAudioToSTT(pcm16kBytes) {
    if (session._callEnded) return;
    _audioAccumulator.push(pcm16kBytes);
    _audioAccumulatorBytes += pcm16kBytes.length;

    // Reset silence timer
    if (_silenceTimer) clearTimeout(_silenceTimer);
    _silenceTimer = setTimeout(() => {
      if (_audioAccumulatorBytes > 3200 && !_sttProcessing) { // At least 100ms of audio
        flushSTT();
      }
    }, SILENCE_TIMEOUT);

    // Also flush if we have enough audio accumulated
    if (_audioAccumulatorBytes >= STT_CHUNK_THRESHOLD && !_sttProcessing) {
      flushSTT();
    }
  }

  async function flushSTT() {
    if (_audioAccumulator.length === 0 || _sttProcessing) return;
    _sttProcessing = true;

    // Combine all accumulated audio chunks
    const totalLen = _audioAccumulator.reduce((s, c) => s + c.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of _audioAccumulator) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    _audioAccumulator = [];
    _audioAccumulatorBytes = 0;

    // Build WAV header for Azure STT REST API
    const wavHeader = buildWavHeader(combined.length, 16000, 16, 1);
    const wavData = new Uint8Array(wavHeader.length + combined.length);
    wavData.set(wavHeader, 0);
    wavData.set(combined, wavHeader.length);

    const speechKey = Deno.env.get('AZURE_SPEECH_KEY');
    const speechRegion = Deno.env.get('AZURE_SPEECH_REGION');

    try {
      const res = await fetch(`https://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=hi-IN&format=detailed&profanity=raw`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
          'Accept': 'application/json'
        },
        body: wavData
      });

      if (res.ok) {
        const data = await res.json();
        if (data.RecognitionStatus === 'Success' && data.NBest?.[0]?.Display) {
          const text = data.NBest[0].Display.trim();
          const confidence = data.NBest[0].Confidence || 0;
          if (text && confidence > 0.3) {
            console.log(`[${reqId}] 🗣️ STT: "${text.substring(0, 100)}" (conf=${confidence.toFixed(2)})`);
            handleCustomerSpeech(text);
          } else if (text) {
            console.log(`[${reqId}] 🔇 Low confidence STT: "${text.substring(0, 50)}" (${confidence.toFixed(2)})`);
          }
        }
      } else {
        const errText = await res.text();
        console.error(`[${reqId}] ❌ STT API error: ${res.status} ${errText.substring(0, 200)}`);
      }
    } catch (e) {
      console.error(`[${reqId}] ❌ STT fetch error: ${e.message}`);
    } finally {
      _sttProcessing = false;
    }
  }

  function buildWavHeader(dataSize, sampleRate, bitsPerSample, channels) {
    const blockAlign = channels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const buf = new ArrayBuffer(44);
    const v = new DataView(buf);
    // RIFF header
    v.setUint32(0, 0x52494646, false); // "RIFF"
    v.setUint32(4, 36 + dataSize, true);
    v.setUint32(8, 0x57415645, false); // "WAVE"
    // fmt chunk
    v.setUint32(12, 0x666d7420, false); // "fmt "
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, byteRate, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, bitsPerSample, true);
    // data chunk
    v.setUint32(36, 0x64617461, false); // "data"
    v.setUint32(40, dataSize, true);
    return new Uint8Array(buf);
  }

  // ─── Handle recognized customer speech ───
  function handleCustomerSpeech(text) {
    // Noise filter
    const clean = text.toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g, '').trim();
    const wc = clean.split(/\s+/).filter(w => w).length;
    if (wc <= 2 && /^(bye[\s-]*bye|bye|ba+h*|hmm+|uh+|um+|ah+|oh+|huh|tch|shh|ss+|mm+|nah+|ha+)$/i.test(clean)) {
      console.log(`[${reqId}] 🔇 Noise filtered: "${text}"`);
      return;
    }

    session.transcript.push({ speaker: 'Customer', text });

    // Interrupt current TTS if speaking
    if (session._isSpeaking && session._ttsAbort) {
      session._ttsAbort.abort();
      session._ttsAbort = null;
      session._isSpeaking = false;
      // Clear Smartflo audio buffer
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
      }
    }

    // Generate LLM response
    generateLLMResponse(text);

    // Mid-call Telegram for personal accounts
    if (session._personalMode && session._personalClientId && !session._midCallTgSent) {
      const custCount = session.transcript.filter(t => t.speaker === 'Customer').length;
      if (custCount >= 2) { session._midCallTgSent = true; sendMidCallTelegram(); }
    }
  }

  // ─── LLM Response Generation (streaming) ───
  async function generateLLMResponse(userText) {
    const endpoint = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');

    if (!endpoint || !apiKey || !deployment) {
      console.error(`[${reqId}] ❌ Missing Azure OpenAI config`);
      return;
    }

    // Normalize endpoint
    let baseUrl = endpoint;
    const oIdx = baseUrl.indexOf('/openai/'); if (oIdx > 0) baseUrl = baseUrl.substring(0, oIdx);
    const pIdx = baseUrl.indexOf('/api/projects'); if (pIdx > 0) baseUrl = baseUrl.substring(0, pIdx);

    session.chatHistory.push({ role: 'user', content: userText });

    try {
      const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            ...session.chatHistory.slice(0, 1), // system prompt
            { role: 'system', content: 'VOICE CALL RULES:\n1. LIVE PHONE CALL. Text→Hindi TTS.\n2. ALWAYS respond in Hindi (देवनागरी).\n3. No English unless brand names.\n4. No markdown/emojis.\n5. MAX 2 sentences. Be conversational.\n6. Plain text only.' },
            ...session.chatHistory.slice(1)
          ],
          max_completion_tokens: 150,
          stream: true
        })
      });

      if (!res.ok) {
        console.error(`[${reqId}] ❌ LLM: ${res.status} ${(await res.text()).substring(0, 200)}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '', sentenceBuffer = '', sentencesSent = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
            if (!delta) continue;
            fullText += delta;
            sentenceBuffer += delta;
            const match = sentenceBuffer.match(/^(.*?[.?!।\n])\s*(.*)/s);
            if (match) {
              const sentence = cleanForTTS(match[1]);
              sentenceBuffer = match[2] || '';
              if (sentence && sentence.length > 3) {
                sentencesSent++;
                if (sentencesSent === 1) console.log(`[${reqId}] 🤖 First: "${sentence.substring(0, 80)}"`);
                synthesizeTTS(sentence);
              }
            }
          } catch (_) {}
        }
      }

      const remaining = cleanForTTS(sentenceBuffer);
      if (remaining && remaining.length > 3) synthesizeTTS(remaining);

      const cleanFull = cleanForTTS(fullText);
      console.log(`[${reqId}] 🤖 LLM: "${cleanFull.substring(0, 100)}" (${sentencesSent} sentences)`);
      session.chatHistory.push({ role: 'assistant', content: fullText });
      session.transcript.push({ speaker: 'AI', text: cleanFull });

    } catch (err) {
      console.error(`[${reqId}] ❌ LLM failed: ${err.message}`);
    }
  }

  const cleanForTTS = t => t.replace(/\*\*([^*]+)\*\*/g,'$1').replace(/\*([^*]+)\*/g,'$1').replace(/#{1,6}\s*/g,'').replace(/```[\s\S]*?```/g,'').replace(/`([^`]+)`/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu,'').replace(/\n{2,}/g,'. ').replace(/\n/g,' ').replace(/\s{2,}/g,' ').trim();

  // ─── Azure Speech TTS → Smartflo ───
  async function synthesizeTTS(text) {
    const speechKey = Deno.env.get('AZURE_SPEECH_KEY');
    const speechRegion = Deno.env.get('AZURE_SPEECH_REGION');
    if (!speechKey || !speechRegion) return;

    const xmlLang = /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-IN';
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'><voice name='${session.voiceType}'>${escaped}</voice></speak>`;

    const controller = new AbortController();
    session._ttsAbort = controller;
    session._isSpeaking = true;

    try {
      const res = await fetch(`https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'raw-8khz-8bit-mono-mulaw'
        },
        body: ssml,
        signal: controller.signal
      });

      if (!res.ok) { console.error(`[${reqId}] ❌ TTS: ${res.status}`); session._isSpeaking = false; return; }

      const audioBuffer = new Uint8Array(await res.arrayBuffer());
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        // Send in 160-byte aligned chunks
        for (let i = 0; i < audioBuffer.length; i += 1600) {
          if (controller.signal.aborted) break;
          let chunk = audioBuffer.slice(i, Math.min(i + 1600, audioBuffer.length));
          if (chunk.length % 160 !== 0) {
            const p = new Uint8Array(Math.ceil(chunk.length / 160) * 160);
            p.set(chunk);
            p.fill(0xFF, chunk.length);
            chunk = p;
          }
          smartfloSocket.send(JSON.stringify({
            event: 'media', streamSid: session.streamSid,
            media: { payload: uint8ToBase64(chunk) }
          }));
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.error(`[${reqId}] ❌ TTS failed: ${err.message}`);
    } finally {
      session._isSpeaking = false;
      session._ttsAbort = null;
    }
  }

  // ─── Hangup ───
  async function hangupCall(reason) {
    console.log(`[${reqId}] 📴 Hanging up: "${reason}"`);
    session._callEnded = true;
    try {
      const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
      if (sfE && sfP) {
        const lr = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: sfE, password: sfP })
        });
        const ld = await lr.json();
        const tk = ld.access_token || ld.token;
        if (tk) {
          // Find live call ID
          const liveId = await findLiveCallId(tk);
          const candidates = [...new Set([liveId, session.smartfloCallId, session.callSid].filter(Boolean))];
          for (const id of candidates) {
            const hr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/hangup', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
              body: JSON.stringify({ call_id: id })
            });
            const hb = await hr.json().catch(() => ({}));
            if (hr.ok && hb.success !== false) { console.log(`[${reqId}] ✅ Hung up: ${id}`); break; }
          }
        }
      }
    } catch (e) { console.error(`[${reqId}] ⚠️ Hangup: ${e.message}`); }
  }

  async function findLiveCallId(token) {
    try {
      const r = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      });
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

  // ─── Transfer to human ───
  async function transferToHuman(reason) {
    console.log(`[${reqId}] 📞 Transfer: ${reason}, intercom=${session.humanTransferNumber}`);
    try {
      const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
      if (!sfE || !sfP) return false;
      const lr = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: sfE, password: sfP })
      });
      const ld = await lr.json();
      const tk = ld.access_token || ld.token;
      if (!tk) return false;
      const txId = await findLiveCallId(tk) || session.smartfloCallId || session.callSid;
      const tr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
        body: JSON.stringify({ type: 4, call_id: txId, intercom: String(session.humanTransferNumber) })
      });
      const td = await tr.json();
      console.log(`[${reqId}] 📞 Transfer: ${tr.status}`, JSON.stringify(td));
      if (tr.ok) {
        session.transcript.push({ speaker: 'System', text: `[Transferred: ${reason}]` });
        if (session.callLogId) {
          const { createClient } = await import('npm:@base44/sdk@0.8.23');
          createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true })
            .entities.CallLog.update(session.callLogId, { transferred_to: `Human (${session.humanTransferNumber}, ${reason})` }).catch(() => {});
        }
        return true;
      }
    } catch (e) { console.error(`[${reqId}] ❌ Transfer: ${e.message}`); }
    return false;
  }

  // ─── Mid-call Telegram (personal accounts) ───
  async function sendMidCallTelegram() {
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!tgT || !session.callLogId) return;
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.23');
      const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      const cl = await svc.entities.Client.get(session._personalClientId);
      if (!cl?.telegram_connected || !cl?.telegram_chat_id || cl.dnd_enabled || cl.owner_notification_channel !== 'telegram') return;

      const convo = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
      let bUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
      const o = bUrl.indexOf('/openai/'); if (o > 0) bUrl = bUrl.substring(0, o);
      const p = bUrl.indexOf('/api/projects'); if (p > 0) bUrl = bUrl.substring(0, p);
      const dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT'), ak = Deno.env.get('AZURE_OPENAI_KEY');

      const res = await fetch(`${bUrl}/openai/deployments/${dep}/chat/completions?api-version=2024-08-01-preview`, {
        method: 'POST', headers: { 'api-key': ak, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: 'Classify call. JSON: {"reason":"label","emoji":"1","detail":"1 sentence","urgency":"low|medium|high|urgent","caller_name":"if said"}' },
          { role: 'user', content: convo }
        ], max_completion_tokens: 100, response_format: { type: "json_object" } })
      });
      if (!res.ok) return;
      const r = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');

      const callerLabel = (session._isTrustedCaller && session._trustedContactName) ? session._trustedContactName : r.caller_name || session.callerNumber || 'Unknown';
      const clId = session.callLogId;
      const m = `${r.emoji || '📞'} <b>Live Call</b>\n\n📱 From: <b>${callerLabel}</b>\n📋 ${r.reason || 'Unknown'}${r.detail ? '\n💬 ' + r.detail : ''}\n\n👇 Choose:`;
      const kb = { inline_keyboard: [
        [{ text: '📞 Transfer', callback_data: `decision:${clId}:transfer` }, { text: '⏰ Callback', callback_data: `decision:${clId}:callback` }],
        [{ text: '📝 Message', callback_data: `decision:${clId}:take_message` }, { text: '🚫 End', callback_data: `decision:${clId}:block` }]
      ]};
      const tgRes = await (await fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: m, parse_mode: 'HTML', reply_markup: kb })
      })).json();
      if (tgRes.ok) { session._awaitingOwnerDecision = true; pollOwnerDecision(svc); }
    } catch (e) { console.error(`[${reqId}] ⚠️ TG: ${e.message}`); }
  }

  async function pollOwnerDecision(svc) {
    if (!session.callLogId) return;
    let polls = 0;
    const iv = setInterval(async () => {
      polls++;
      if (polls > 60 || session._callEnded || session._ownerDecisionExecuted) { clearInterval(iv); return; }
      try {
        const decs = await svc.entities.CallDecision.filter({ call_log_id: session.callLogId, status: 'pending' });
        const dec = decs.find(d => d.custom_message !== '__AWAITING_TIME__' && d.custom_message !== '__AWAITING_MESSAGE__');
        if (!dec) return;
        clearInterval(iv);
        session._ownerDecisionExecuted = true;
        await svc.entities.CallDecision.update(dec.id, { status: 'delivered' });
        executeOwnerDecision(dec);
      } catch (_) {}
    }, 2000);
  }

  function executeOwnerDecision(dec) {
    const name = session._ownerName || 'Sir';
    let inst = '';
    if (dec.decision === 'transfer') {
      if (session.humanTransferNumber) {
        inst = `${name} ji ne call transfer bola hai. Boliye: "${name} ji aapka call transfer kar rahe hain, hold kariye." Then transfer.`;
        generateLLMResponse(inst);
        setTimeout(() => transferToHuman('owner requested'), 3000);
        return;
      }
      inst = `${name} ji jald call back karenge.`;
    } else if (dec.decision === 'callback') {
      inst = `${name} ji ${dec.callback_time || dec.custom_message || 'jald'} mein call back karenge.`;
    } else if (dec.decision === 'take_message') {
      inst = `${name} ji busy hain. Message le lijiye.`;
    } else if (dec.decision === 'block') {
      inst = `${name} ji available nahi hain. Politely end karo.`;
      generateLLMResponse(inst);
      setTimeout(() => hangupCall('owner blocked'), 3000);
      return;
    }
    if (inst) generateLLMResponse(inst);
  }

  // ─── Load Agent Config (same logic as streamAudio) ───
  async function loadAgentConfig() {
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.23');
      const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

      let callLog = null;
      const cutoff = new Date(Date.now() - 120000).toISOString();

      // Strategy 1: call_sid match
      if (session.callSid) {
        const variants = [session.callSid, session.callSid.replace(/^[^-]*-/, '').replace(/\.[^.]*$/, '')].filter(Boolean);
        for (const sid of variants) {
          if (callLog) break;
          try { const logs = await svc.entities.CallLog.filter({ call_sid: sid }); if (logs.length) callLog = logs[0]; } catch (_) {}
        }
      }

      // Strategy 2: Recent ringing/initiated
      if (!callLog) {
        const cleanCallee = (session.calleeNumber || '').replace(/\D/g, '');
        const match = (list) => {
          const unclaimed = list.filter(l => !l.stream_sid && l.created_date >= cutoff);
          if (cleanCallee) { const m = unclaimed.find(l => (l.callee_number||'').replace(/\D/g,'').slice(-10) === cleanCallee.slice(-10)); if (m) return m; }
          return unclaimed[0] || null;
        };
        const [ring, init] = await Promise.all([
          svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 20).catch(() => []),
          svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 20).catch(() => [])
        ]);
        callLog = match(ring) || match(init);
        if (callLog) console.log(`[${reqId}] ⚡ Status match: ${callLog.id}`);
      }

      // Strategy 3: DID→Agent (inbound)
      if (!callLog && (session.calleeNumber || session.callerNumber)) {
        const calleeDID = (session.calleeNumber || '').replace(/\D/g, '').slice(-10);
        const callerDID = (session.callerNumber || '').replace(/\D/g, '').slice(-10);
        if (calleeDID) {
          const allDIDs = await svc.entities.DID.list('-created_date', 200);
          const matched = allDIDs.find(d => {
            const n = (d.number||'').replace(/\D/g,'').slice(-10);
            return n === calleeDID || n === callerDID;
          });
          let agent = null, client = null;
          if (matched?.agent_id) agent = await svc.entities.Agent.get(matched.agent_id).catch(() => null);
          if (matched?.client_id) client = await svc.entities.Client.get(matched.client_id).catch(() => null);
          if (!agent) {
            const agents = await svc.entities.Agent.list('-created_date', 100);
            agent = agents.find(a => {
              const dids = a.assigned_dids || (a.assigned_did ? [a.assigned_did] : []);
              return dids.some(d => { const n = (d||'').replace(/\D/g,'').slice(-10); return n === calleeDID || n === callerDID; });
            });
            if (agent && !client) client = await svc.entities.Client.get(agent.client_id).catch(() => null);
          }
          if (agent) {
            console.log(`[${reqId}] ✅ INBOUND: Agent="${agent.name}"`);
            session.clientId = client?.id || agent.client_id;
            session.systemPrompt = agent.system_prompt || session.systemPrompt;
            if (agent.greeting_message) session.greetingMessage = agent.greeting_message;
            if (agent.human_transfer_number) session.humanTransferNumber = agent.human_transfer_number;
            if (agent.persona?.voice_type) session.voiceType = agent.persona.voice_type;

            // Fetch KB
            if (agent.knowledge_base_ids?.length) {
              const docs = await Promise.all(agent.knowledge_base_ids.map(id => svc.entities.KnowledgeBase.get(id).catch(() => null)));
              const kb = docs.filter(d => d?.content).map(d => `[${d.title}]\n${d.content}`).join('\n\n---\n\n');
              if (kb) session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${kb}`;
            }

            // Create inbound CallLog
            try {
              const log = await svc.entities.CallLog.create({
                client_id: session.clientId, agent_id: agent.id,
                call_sid: session.callSid || `inbound_${Date.now()}`,
                stream_sid: session.streamSid, caller_id: session.callerNumber,
                callee_number: session.calleeNumber, direction: 'inbound',
                status: 'answered', call_start_time: new Date().toISOString(),
                agent_config_cache: { agent_name: agent.name, system_prompt: session.systemPrompt, persona: agent.persona || {}, greeting_message: agent.greeting_message || '' }
              });
              session.callLogId = log.id;
              console.log(`[${reqId}] ✅ Inbound CallLog: ${log.id}`);
            } catch (e) { console.error(`[${reqId}] ⚠️ CallLog create: ${e.message}`); }

            // Personal account mode
            if (client?.account_type === 'personal') {
              await setupPersonalMode(svc, client);
            }

            return;
          }
        }
      }

      if (!callLog) {
        console.log(`[${reqId}] ⚠️ No call log found — using default prompt`);
        return;
      }

      // Extract config from CallLog
      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      if (callLog.call_sid && callLog.call_sid !== session.callSid) session.smartfloCallId = callLog.call_sid;
      const cache = callLog.agent_config_cache;

      if (cache?.system_prompt) {
        session.systemPrompt = cache.system_prompt;
        if (cache.knowledge_base_content) session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${cache.knowledge_base_content}`;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (cache.persona?.voice_type) session.voiceType = cache.persona.voice_type;
        console.log(`[${reqId}] ✅ Config from CallLog ${callLog.id} (${session.systemPrompt.length}ch)`);
      }

      // Personal mode check
      if (callLog.client_id) {
        const client = await svc.entities.Client.get(callLog.client_id).catch(() => null);
        if (client?.account_type === 'personal') await setupPersonalMode(svc, client);
      }

      // Claim CallLog
      const upd = {};
      if (session.streamSid) upd.stream_sid = session.streamSid;
      if (Object.keys(upd).length) svc.entities.CallLog.update(callLog.id, upd).catch(() => {});

    } catch (e) {
      console.error(`[${reqId}] ❌ Config load failed: ${e.message}`);
    }
  }

  async function setupPersonalMode(svc, client) {
    const aiMode = client.ai_response_mode || 'screen_all';
    session._personalMode = aiMode;
    session._personalClientId = client.id;
    session._ownerName = client.company_name || '';

    let pi = '\n\n--- PERSONAL AI ASSISTANT MODE ---';
    if (aiMode === 'block_all') pi += '\nBlock all. Politely say unavailable. End quickly.';
    else if (aiMode === 'take_messages') pi += '\nTake messages from every caller.';
    else pi += '\nScreen all calls. Classify and take messages.';
    if (client.dnd_enabled) pi += '\nDND ON.';
    session.systemPrompt += pi;
    console.log(`[${reqId}] 🛡️ Personal: mode=${aiMode}, owner=${session._ownerName}`);

    // Telegram notification
    if (client.telegram_connected && client.telegram_chat_id && !client.dnd_enabled && client.owner_notification_channel === 'telegram') {
      const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
      if (tgT) {
        fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: client.telegram_chat_id, text: `📞 <b>Incoming Call</b>\n📱 From: <b>${session.callerNumber || 'Unknown'}</b>\n💬 AI is screening...`, parse_mode: 'HTML' })
        }).catch(() => {});
      }
    }
  }

  // ─── Send greeting ───
  function sendGreeting() {
    if (session._greetingSent) return;
    session._greetingSent = true;

    const greeting = session.greetingMessage;
    if (greeting) {
      console.log(`[${reqId}] 🎙️ Greeting: "${greeting.substring(0, 80)}"`);
      session.transcript.push({ speaker: 'AI', text: greeting });
      session.chatHistory.push({ role: 'assistant', content: greeting });
      synthesizeTTS(greeting);
    } else {
      console.log(`[${reqId}] 🎙️ Generating greeting via LLM`);
      generateLLMResponse('[SYSTEM: Call just connected. Greet warmly. Hindi. 1 sentence.]');
    }
  }

  // ─── Initialize session with system prompt ───
  function initializeChat() {
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeCtx = `\n[CLOCK] ${nowIST} IST\n`;
    const noiseRules = `\n[RULES] Phone call in India. Only respond to clear speech. Ignore noise. Keep responses SHORT (1-2 sentences). Hindi only.\n`;

    let transferCtx = '';
    if (session.humanTransferNumber && session.enableAutoTransfer) {
      transferCtx = `\n[TRANSFER] You can transfer to human. Only when customer explicitly asks. Say "hold" before transferring.\n`;
    }

    session.chatHistory = [{ role: 'system', content: timeCtx + noiseRules + session.systemPrompt + transferCtx }];
    console.log(`[${reqId}] ✅ Chat initialized: voice=${session.voiceType}, prompt=${session.systemPrompt.length}ch`);
  }

  // ═══ Smartflo WebSocket Handlers ═══

  smartfloSocket.onopen = () => { console.log(`[${reqId}] 🟢 Smartflo opened`); };

  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.event === 'connected') { console.log(`[${reqId}] ✅ Smartflo connected`); return; }

      if (msg.event === 'start') {
        const s = msg.start || {};
        session.streamSid = s.streamSid;
        session.callSid = s.callSid;

        // Extract numbers
        session.calleeNumber = s.customParameters?.customer_number || s.to || '';
        session.callerNumber = s.from || '';
        if (!s.customParameters?.customer_number && s.to && s.from) {
          session.calleeNumber = s.to; session.callerNumber = s.from;
        }

        console.log(`[${reqId}] 📞 START: stream=${session.streamSid}, callee=${session.calleeNumber}, caller=${session.callerNumber}`);

        // Load config then initialize
        loadAgentConfig().then(() => {
          session._configReady = true;
          initializeChat();
          sendGreeting();
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        if (!session._configReady) return; // Drop until config ready

        // Decode mu-law → PCM16 16kHz → feed to STT
        const raw = atob(msg.media.payload);
        const mulaw = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) mulaw[i] = raw.charCodeAt(i);
        const pcm16k = mulawToPcm16_16k(mulaw);
        feedAudioToSTT(pcm16k);
        return;
      }

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Stop`);
        session._callEnded = true;
        if (_silenceTimer) clearTimeout(_silenceTimer);
        // Flush remaining audio for STT
        if (_audioAccumulatorBytes > 3200) await flushSTT();
        await saveCallRecord(session, reqId, Math.round((Date.now() - session.startTime) / 1000));
        return;
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ Message error: ${err.message}`);
    }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    if (_silenceTimer) clearTimeout(_silenceTimer);
    const dur = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Smartflo closed, duration=${dur}s`);
    if (session.callLogId) await saveCallRecord(session, reqId, dur);
  };

  smartfloSocket.onerror = () => { console.error(`[${reqId}] ❌ Smartflo error`); };

  return response;
});