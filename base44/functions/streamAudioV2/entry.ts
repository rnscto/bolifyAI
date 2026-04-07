import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// ═══════════════════════════════════════════════════════════════════════════
// streamAudioV2 — Azure Voice Live API Pipeline
// Smartflo mu-law 8kHz ↔ Voice Live (native G.711 mu-law support)
// No sample rate conversion needed! Built-in noise suppression + semantic VAD
// ═══════════════════════════════════════════════════════════════════════════

function uint8ToBase64(bytes) {
  let b = ''; for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return btoa(b);
}

// ─── Save Call Record ───

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
              { role: 'system', content: `Analyze this call transcript comprehensively. SCORING (total 100): Sentiment(0-25), Intent(0-30), Engagement(0-25), Keywords(0-20). IMPORTANT: Short calls with single ambiguous words → "contacted" + "neutral". Only use "do_not_call" when customer EXPLICITLY refuses calls. Respond ONLY in valid JSON.` },
              { role: 'user', content: `Transcript:\n${transcript}\n\nReturn JSON:\n{"summary":"2-3 sentences","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0},"key_topics":[],"recommended_next_action":"..."}` }
            ],
            max_completion_tokens: 600,
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
      } catch (e) { console.error(`[${reqId}] ⚠️ AI analysis: ${e.message}`); }
    } else {
      summary = 'Call ended with minimal or no conversation.';
    }

    // Short call safeguard
    const custWords = session.transcript.filter(t => t.speaker === 'Customer').reduce((a, t) => a + t.text.split(/\s+/).length, 0);
    if (custWords <= 5 && duration < 30 && (leadStatus === 'do_not_call' || leadStatus === 'not_interested')) {
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
    }

    let tier = 'cold', tierReason = `Score ${leadScore}/100`;
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) tier = 'hot';
    else if (leadScore >= 50) tier = 'warm';
    else if (leadScore >= 25) tier = 'nurture';
    else if (['negative', 'very_negative'].includes(sentiment)) tier = 'disqualified';
    if (leadStatus === 'converted') tier = 'hot';
    if (leadStatus === 'do_not_call') tier = 'disqualified';

    const enrichedSummary = summary ? `${summary}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Tier: ${tier} | Signals: ${intentSignals.join(', ')}` : '';

    const currentLog = await svc.entities.CallLog.get(session.callLogId);
    const wasCompleted = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);

    const updateData = { transcript: transcript || '', duration, lead_status_updated: leadStatus, conversation_summary: enrichedSummary || summary || '' };
    if (!wasCompleted) { updateData.status = 'completed'; updateData.call_end_time = new Date().toISOString(); }
    await svc.entities.CallLog.update(session.callLogId, updateData);
    console.log(`[${reqId}] 💾 Saved: ${session.callLogId}, score=${leadScore}, tier=${tier}`);

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
      } catch (e) { console.error(`[${reqId}] ⚠️ Lead: ${e.message}`); }
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
        const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgT) {
          const cl = await svc.entities.Client.get(session._personalClientId);
          if (cl?.telegram_connected && cl?.telegram_chat_id && !cl.dnd_enabled && cl.owner_notification_channel === 'telegram') {
            const emj = cat === 'spam' ? '🚫' : cat === 'business' ? '💼' : '📋';
            fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: `${emj} <b>Call Summary</b>\n📱 From: <b>${currentLog.caller_id || 'Unknown'}</b>\n🏷️ ${cat}\n💬 ${(summary || msg).substring(0, 500)}`, parse_mode: 'HTML' })
            }).catch(() => {});
          }
        }
      } catch (e) { console.error(`[${reqId}] ⚠️ Voicemail: ${e.message}`); }
    }

    if (transcript.length > 50) {
      svc.functions.invoke('postCallActionExtractor', { call_log_id: session.callLogId }).catch(() => {});
    }
  } catch (err) { console.error(`[${reqId}] ❌ Save failed: ${err.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Handler
// ═══════════════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();

  console.log(`[${reqId}] 📨 VoiceLive ${req.method}, ws=${upgrade === 'websocket'}`);

  // Non-WebSocket: Smartflo dynamic endpoint response
  if (upgrade !== 'websocket') {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    const wssUrl = `wss://${host}/functions/streamAudioV2`;
    if (req.method === 'POST') { try { console.log(`[${reqId}] POST:`, JSON.stringify(await req.json())); } catch (_) {} }
    return new Response(JSON.stringify({ sucess: true, wss_url: wssUrl }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Upgrade Smartflo WebSocket
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
    streamSid: null, callSid: null, callLogId: null, clientId: null,
    calleeNumber: '', callerNumber: '',
    transcript: [], startTime: Date.now(),
    systemPrompt: 'You are a friendly AI voice assistant. Be professional and concise.',
    greetingMessage: '',
    voiceEngine: 'voice_live_azure', // voice_live_openai | voice_live_azure | realtime | azure_speech
    voiceType: 'hi-IN-SwaraNeural', // Voice name
    _saved: false, smartfloCallId: null,
    humanTransferNumber: '', enableAutoTransfer: true,
    hasShopify: false, _callEnded: false,
    // Voice Live WebSocket
    _vlWs: null, _vlReady: false, _vlSessionReady: false, _vlQueue: [], _vlReconnectAttempts: 0,
    _isSpeaking: false,
    // Agent config
    _configReady: false, _greetingSent: false,
    // Personal mode
    _personalMode: null, _personalClientId: null, _ownerName: '',
    _isTrustedCaller: false, _trustedContactName: '',
    _midCallTgSent: false, _awaitingOwnerDecision: false, _ownerDecisionExecuted: false,
    // Tools
    tools: []
  };

  // ─── Connect to Azure Voice Live API ───
  function connectVoiceLive() {
    const vlEndpoint = Deno.env.get('VOICE_LIVE_ENDPOINT');
    const vlKey = Deno.env.get('VOICE_LIVE_KEY');
    if (!vlEndpoint || !vlKey) {
      console.error(`[${reqId}] ❌ Missing VOICE_LIVE_ENDPOINT or VOICE_LIVE_KEY`);
      return;
    }

    // Build WebSocket URL: wss://<host>/voice-live/realtime?api-version=2025-10-01&model=gpt-realtime
    const host = vlEndpoint.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const wsUrl = `wss://${host}/voice-live/realtime?api-version=2025-10-01&model=gpt-realtime&api-key=${encodeURIComponent(vlKey)}`;
    const logUrl = wsUrl.replace(/api-key=[^&]+/, 'api-key=***');
    console.log(`[${reqId}] 🔌 Voice Live: ${logUrl}`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${reqId}] ✅ Voice Live connected`);
      session._vlReconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      try { handleVoiceLiveMessage(JSON.parse(event.data)); }
      catch (err) { console.error(`[${reqId}] ❌ VL parse: ${err.message}`); }
    };

    ws.onclose = (event) => {
      console.log(`[${reqId}] 🔴 Voice Live closed: code=${event.code} reason=${event.reason}`);
      session._vlReady = false;
      if (!session._callEnded && session._vlReconnectAttempts < 3) {
        session._vlReconnectAttempts++;
        const delay = session._vlReconnectAttempts * 1000;
        console.log(`[${reqId}] 🔄 Reconnecting Voice Live (${session._vlReconnectAttempts}/3) in ${delay}ms`);
        setTimeout(() => { if (!session._callEnded) connectVoiceLive(); }, delay);
      }
    };

    ws.onerror = () => { console.error(`[${reqId}] ❌ Voice Live error (readyState=${ws.readyState})`); };

    session._vlWs = ws;
  }

  // ─── Send to Voice Live ───
  // Only session.update can be sent before session.updated is received
  function sendToVL(msg) {
    if (session._vlWs?.readyState === WebSocket.OPEN) {
      // Block non-session.update messages until session is fully configured
      if (msg.type !== 'session.update' && !session._vlSessionReady) {
        // Queue for after session is ready
        if (!session._vlQueue) session._vlQueue = [];
        session._vlQueue.push(msg);
        return;
      }
      session._vlWs.send(JSON.stringify(msg));
    }
  }

  // Flush queued messages after session.updated
  function flushVLQueue() {
    if (session._vlQueue && session._vlWs?.readyState === WebSocket.OPEN) {
      for (const msg of session._vlQueue) {
        session._vlWs.send(JSON.stringify(msg));
      }
      session._vlQueue = [];
    }
  }

  // ─── Build Tool Definitions ───
  function buildTools() {
    const tools = [];
    tools.push({ type: 'function', name: 'end_call', description: 'End/disconnect the call. Say goodbye BEFORE calling this.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } });
    if (session.humanTransferNumber) {
      tools.push({ type: 'function', name: 'transfer_to_human', description: 'Transfer call to human agent. Only when customer explicitly asks. Say "hold" before transferring.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } });
    }
    if (session.hasShopify) {
      tools.push({ type: 'function', name: 'shopify_lookup', description: 'Look up Shopify store data: orders, products, tracking, refunds.', parameters: { type: 'object', properties: { lookup_type: { type: 'string', enum: ['order_by_number', 'order_by_phone', 'order_by_email', 'product_search', 'refund_status', 'tracking'] }, query: { type: 'string' } }, required: ['lookup_type', 'query'] } });
    }
    session.tools = tools;
    return tools;
  }

  // ─── Apply Session Config to Voice Live ───
  function applySessionConfig() {
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeCtx = `\n[LIVE CLOCK] Current IST: ${nowIST}\n`;
    const noiseNote = `\n[RULES] PHONE CALL in India. Only respond to CLEAR speech. Ignore background noise. Keep responses SHORT (1-2 sentences). NEVER end call based on single unclear word.\n`;

    let transferCtx = '';
    if (session.humanTransferNumber && session.enableAutoTransfer) {
      transferCtx = `\n[TRANSFER AVAILABLE] Use transfer_to_human when customer explicitly asks for human/manager. Always say "hold" before transferring.\n`;
    }

    const instructions = timeCtx + noiseNote + session.systemPrompt + transferCtx;
    const tools = buildTools();

    // Voice Live supports G.711 mu-law natively at 8kHz — perfect for Smartflo!
    const sessionConfig = {
      modalities: ['text', 'audio'],
      instructions: instructions,
      input_audio_format: 'g711_ulaw',
      output_audio_format: 'g711_ulaw',
      input_audio_sampling_rate: 8000,
      turn_detection: {
        type: 'azure_semantic_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 700
      },
      input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
      input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
      temperature: 0.8,
      max_response_output_tokens: 'inf'
    };

    // Voice configuration for Voice Live API
    // Supports: openai (alloy, ash, etc.), azure-standard (hi-IN-SwaraNeural, en-US-Ava:DragonHDLatestNeural, etc.)
    const openaiVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
    const voiceName = session.voiceType || 'hi-IN-SwaraNeural';

    // Determine voice type based on engine setting or voice name pattern
    const engine = session.voiceEngine || '';
    if (engine === 'voice_live_openai' || openaiVoices.includes(voiceName.toLowerCase())) {
      // Validate: only send known OpenAI voices; fall back to 'alloy' for unknown
      const resolvedName = openaiVoices.includes(voiceName.toLowerCase()) ? voiceName.toLowerCase() : 'alloy';
      sessionConfig.voice = { type: 'openai', name: resolvedName };
    } else {
      // Azure standard voice (Neural TTS, HD Dragon, etc.)
      sessionConfig.voice = { type: 'azure-standard', name: voiceName };
    }

    if (tools.length > 0) {
      sessionConfig.tools = tools;
      sessionConfig.tool_choice = 'auto';
    }

    sendToVL({ type: 'session.update', session: sessionConfig });
    console.log(`[${reqId}] 📤 Session configured: voice=${JSON.stringify(sessionConfig.voice)}, tools=${tools.length}, format=g711_ulaw`);

    // Trigger greeting
    triggerGreeting();
  }

  // ─── Handle Voice Live Messages ───
  function handleVoiceLiveMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Voice Live session created`);
      session._vlReady = true;
      if (session._configReady) {
        applySessionConfig();
      } else {
        // MUST send session.update as the first message — Voice Live requires it
        sendToVL({ type: 'session.update', session: {
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_sampling_rate: 8000,
          modalities: ['text', 'audio'],
          voice: { type: 'azure-standard', name: 'hi-IN-SwaraNeural' },
          instructions: 'You are a friendly AI voice assistant. Wait for further instructions before speaking.',
          turn_detection: { type: 'azure_semantic_vad', silence_duration_ms: 700 },
          input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
          input_audio_echo_cancellation: { type: 'server_echo_cancellation' }
        }});
        console.log(`[${reqId}] 📤 Minimal session.update sent (waiting for agent config)`);
      }
      return;
    }

    if (type === 'session.updated') {
      console.log(`[${reqId}] ✅ Voice Live session updated`);
      session._vlSessionReady = true;
      flushVLQueue();
      return;
    }

    // ─── Audio output → Smartflo (G.711 mu-law, no conversion needed!) ───
    if (type === 'response.audio.delta' && msg.delta) {
      session._isSpeaking = true;
      // Voice Live outputs G.711 mu-law base64 directly — send straight to Smartflo!
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        // Decode base64 to send in 160-byte aligned chunks
        const raw = atob(msg.delta);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

        // Send in chunks aligned to 160 bytes (20ms at 8kHz mu-law)
        for (let i = 0; i < bytes.length; i += 960) {
          const end = Math.min(i + 960, bytes.length);
          let chunk = bytes.slice(i, end);
          if (chunk.length % 160 !== 0) {
            const padded = new Uint8Array(Math.ceil(chunk.length / 160) * 160);
            padded.set(chunk);
            padded.fill(0xFF, chunk.length); // mu-law silence
            chunk = padded;
          }
          smartfloSocket.send(JSON.stringify({
            event: 'media', streamSid: session.streamSid,
            media: { payload: uint8ToBase64(chunk) }
          }));
        }
      }
      return;
    }

    if (type === 'response.audio.done') { session._isSpeaking = false; return; }

    // ─── Transcription ───
    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        // Noise filter
        const clean = text.toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g, '').trim();
        const wc = clean.split(/\s+/).filter(w => w).length;
        if (wc <= 2 && /^(bye[\s-]*bye|bye|ba+h*|hmm+|uh+|um+|ah+|oh+|huh|tch|shh|ss+|mm+|nah+|ha+)$/i.test(clean)) {
          console.log(`[${reqId}] 🔇 Noise: "${text}"`); return;
        }
        console.log(`[${reqId}] 🗣️ Customer: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'Customer', text });

        // Mid-call Telegram
        if (session._personalMode && session._personalClientId && !session._midCallTgSent) {
          const custCount = session.transcript.filter(t => t.speaker === 'Customer').length;
          if (custCount >= 2) { session._midCallTgSent = true; sendMidCallTelegram(); }
        }
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.failed') {
      console.error(`[${reqId}] ❌ STT failed`); return;
    }

    // ─── AI text transcript ───
    if (type === 'response.audio_transcript.done' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        console.log(`[${reqId}] 🤖 AI: "${text.substring(0, 100)}"`);
        session.transcript.push({ speaker: 'AI', text });
      }
      return;
    }

    // ─── User speech interruption ───
    if (type === 'input_audio_buffer.speech_started') {
      if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
        smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
      }
      session._isSpeaking = false;
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') return;

    // ─── Tool calls ───
    if (type === 'response.function_call_arguments.done') {
      executeToolCall(msg.call_id, msg.name, msg.arguments || '{}');
      return;
    }

    if (type === 'error') {
      console.error(`[${reqId}] ❌ Voice Live error:`, JSON.stringify(msg.error || msg));
      return;
    }
  }

  // ─── Execute Tool Calls ───
  async function executeToolCall(callId, funcName, argsStr) {
    console.log(`[${reqId}] 🔧 Tool: ${funcName}(${argsStr.substring(0, 200)})`);
    let result = { error: `Unknown tool: ${funcName}` };

    if (funcName === 'end_call') {
      const a = JSON.parse(argsStr);
      result = { success: true };
      sendToVL({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
      session.transcript.push({ speaker: 'System', text: `[Call ended: ${a.reason}]` });
      setTimeout(() => hangupCall(a.reason), 1500);
      return;
    }

    if (funcName === 'transfer_to_human' && session.humanTransferNumber) {
      const a = JSON.parse(argsStr);
      const success = await transferToHuman(a.reason || 'customer requested');
      result = success ? { success: true, message: 'Transferring to human agent.' } : { error: 'Transfer failed' };
      sendToVL({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
      sendToVL({ type: 'response.create' });
      return;
    }

    if (funcName === 'shopify_lookup' && session.clientId) {
      try {
        const args = JSON.parse(argsStr);
        const { createClient } = await import('npm:@base44/sdk@0.8.23');
        const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        const integrations = await svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, platform: 'shopify', status: 'active' });
        if (integrations.length === 0) { result = { error: 'No active Shopify' }; }
        else {
          const shop = integrations[0];
          const storeUrl = shop.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const apiVer = shop.api_version || '2024-01';
          const bUrl = `https://${storeUrl}/admin/api/${apiVer}`;
          const hdrs = { 'X-Shopify-Access-Token': shop.api_access_token, 'Content-Type': 'application/json' };
          if (args.lookup_type === 'order_by_number') {
            const name = args.query.startsWith('#') ? args.query : `#${args.query}`;
            const r = await fetch(`${bUrl}/orders.json?name=${encodeURIComponent(name)}&status=any&limit=3`, { headers: hdrs });
            result = r.ok ? { orders: (await r.json()).orders?.map(o => ({ order: o.name, status: o.fulfillment_status || 'unfulfilled', total: `${o.currency} ${o.total_price}` })) || [] } : { error: `API ${r.status}` };
          } else if (args.lookup_type === 'order_by_phone') {
            const r = await fetch(`${bUrl}/orders.json?status=any&limit=20`, { headers: hdrs });
            if (r.ok) { const d = await r.json(); const q = args.query.replace(/\D/g,''); result = { orders: (d.orders||[]).filter(o => (o.customer?.phone||o.phone||'').replace(/\D/g,'').includes(q)).slice(0,5).map(o=>({order:o.name,status:o.fulfillment_status||'unfulfilled',total:`${o.currency} ${o.total_price}`})) }; }
            else result = { error: `API ${r.status}` };
          } else if (args.lookup_type === 'product_search') {
            const r = await fetch(`${bUrl}/products.json?title=${encodeURIComponent(args.query)}&limit=5`, { headers: hdrs });
            result = r.ok ? { products: (await r.json()).products?.map(p => ({ title: p.title, available: p.variants?.some(v => (v.inventory_quantity||0) > 0) })) || [] } : { error: `API ${r.status}` };
          } else if (args.lookup_type === 'tracking') {
            const r = await fetch(`${bUrl}/orders/${args.query}/fulfillments.json`, { headers: hdrs });
            result = r.ok ? { fulfillments: (await r.json()).fulfillments?.map(f => ({ tracking: f.tracking_number, company: f.tracking_company, url: f.tracking_url })) || [] } : { error: `API ${r.status}` };
          } else if (args.lookup_type === 'refund_status') {
            const r = await fetch(`${bUrl}/orders/${args.query}/refunds.json`, { headers: hdrs });
            result = r.ok ? { refunds: (await r.json()).refunds?.map(r => ({ date: r.created_at, note: r.note })) || [] } : { error: `API ${r.status}` };
          } else {
            result = { error: `Unknown: ${args.lookup_type}` };
          }
        }
      } catch (e) { result = { error: e.message }; }
    }

    sendToVL({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
    sendToVL({ type: 'response.create' });
  }

  // ─── Trigger Greeting ───
  function triggerGreeting() {
    if (session._greetingSent) return;
    session._greetingSent = true;
    const greeting = session.greetingMessage;
    if (greeting) {
      console.log(`[${reqId}] 🎙️ Greeting: "${greeting.substring(0, 80)}"`);
      session.transcript.push({ speaker: 'AI', text: greeting });
      sendToVL({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[SYSTEM: Say this exact greeting: "${greeting}"]` }] } });
      sendToVL({ type: 'response.create' });
    } else {
      sendToVL({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: Call connected. Greet warmly in Hindi. 1 sentence.]' }] } });
      sendToVL({ type: 'response.create' });
    }
  }

  // ─── Hangup ───
  async function hangupCall(reason) {
    console.log(`[${reqId}] 📴 Hanging up: "${reason}"`);
    session._callEnded = true;
    if (session._vlWs?.readyState === WebSocket.OPEN) session._vlWs.close();
    try {
      const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
      if (sfE && sfP) {
        const lr = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sfE, password: sfP }) });
        const tk = (await lr.json()).access_token;
        if (tk) {
          const liveId = await findLiveCallId(tk);
          for (const id of [...new Set([liveId, session.smartfloCallId, session.callSid].filter(Boolean))]) {
            const hr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/hangup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` }, body: JSON.stringify({ call_id: id }) });
            if (hr.ok) { console.log(`[${reqId}] ✅ Hung up: ${id}`); break; }
          }
        }
      }
    } catch (e) { console.error(`[${reqId}] ⚠️ Hangup: ${e.message}`); }
  }

  async function findLiveCallId(token) {
    try {
      const r = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) return null;
      const calls = await r.json(); const list = Array.isArray(calls) ? calls : (calls.data || []);
      const ce = (session.calleeNumber || '').replace(/\D/g, '').slice(-10);
      const cr = (session.callerNumber || '').replace(/\D/g, '').slice(-10);
      const m = list.find(c => { const cn = (c.customer_number||'').replace(/\D/g,'').slice(-10); const did = (c.did||'').replace(/\D/g,'').slice(-10); return (ce && (cn===ce||did===ce)) || (cr && (cn===cr||did===cr)); });
      return m?.call_id || null;
    } catch (_) { return null; }
  }

  async function transferToHuman(reason) {
    try {
      const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
      if (!sfE || !sfP) return false;
      const tk = (await (await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sfE, password: sfP }) })).json()).access_token;
      if (!tk) return false;
      const txId = await findLiveCallId(tk) || session.smartfloCallId || session.callSid;
      const tr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` }, body: JSON.stringify({ type: 4, call_id: txId, intercom: String(session.humanTransferNumber) }) });
      if (tr.ok) {
        session.transcript.push({ speaker: 'System', text: `[Transferred: ${reason}]` });
        if (session.callLogId) {
          const { createClient } = await import('npm:@base44/sdk@0.8.23');
          createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true }).entities.CallLog.update(session.callLogId, { transferred_to: `Human (${session.humanTransferNumber})` }).catch(() => {});
        }
        return true;
      }
    } catch (e) { console.error(`[${reqId}] ❌ Transfer: ${e.message}`); }
    return false;
  }

  // ─── Mid-call Telegram ───
  async function sendMidCallTelegram() {
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!tgT || !session.callLogId) return;
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.23');
      const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      const cl = await svc.entities.Client.get(session._personalClientId);
      if (!cl?.telegram_connected || !cl?.telegram_chat_id || cl.dnd_enabled || cl.owner_notification_channel !== 'telegram') return;
      const convo = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
      let bUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT')||'').replace(/\/+$/,'');
      const o=bUrl.indexOf('/openai/'); if(o>0) bUrl=bUrl.substring(0,o);
      const p=bUrl.indexOf('/api/projects'); if(p>0) bUrl=bUrl.substring(0,p);
      const res = await fetch(`${bUrl}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2024-08-01-preview`, {
        method:'POST', headers:{'api-key':Deno.env.get('AZURE_OPENAI_KEY'),'Content-Type':'application/json'},
        body:JSON.stringify({messages:[{role:'system',content:'Classify call. JSON: {"reason":"label","emoji":"1","detail":"1 sentence","urgency":"low|medium|high|urgent","caller_name":"if said"}'},{role:'user',content:convo}],max_completion_tokens:100,response_format:{type:"json_object"}})
      });
      if (!res.ok) return;
      const r = JSON.parse((await res.json()).choices?.[0]?.message?.content||'{}');
      const label = (session._isTrustedCaller&&session._trustedContactName) ? session._trustedContactName : r.caller_name||session.callerNumber||'Unknown';
      const m = `${r.emoji||'📞'} <b>Live Call</b>\n📱 <b>${label}</b>\n📋 ${r.reason||'Unknown'}${r.detail?'\n💬 '+r.detail:''}\n👇 Choose:`;
      const kb = {inline_keyboard:[[{text:'📞 Transfer',callback_data:`decision:${session.callLogId}:transfer`},{text:'⏰ Callback',callback_data:`decision:${session.callLogId}:callback`}],[{text:'📝 Message',callback_data:`decision:${session.callLogId}:take_message`},{text:'🚫 End',callback_data:`decision:${session.callLogId}:block`}]]};
      const tgRes = await(await fetch(`https://api.telegram.org/bot${tgT}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:cl.telegram_chat_id,text:m,parse_mode:'HTML',reply_markup:kb})})).json();
      if(tgRes.ok){session._awaitingOwnerDecision=true; pollOwnerDecision(svc);}
    } catch(e){console.error(`[${reqId}] ⚠️ TG: ${e.message}`);}
  }

  async function pollOwnerDecision(svc) {
    if (!session.callLogId) return;
    let polls = 0;
    const iv = setInterval(async()=>{
      polls++;
      if(polls>60||session._callEnded||session._ownerDecisionExecuted){clearInterval(iv);return;}
      try{
        const decs=await svc.entities.CallDecision.filter({call_log_id:session.callLogId,status:'pending'});
        const dec=decs.find(d=>d.custom_message!=='__AWAITING_TIME__'&&d.custom_message!=='__AWAITING_MESSAGE__');
        if(!dec)return;
        clearInterval(iv);
        session._ownerDecisionExecuted=true;
        await svc.entities.CallDecision.update(dec.id,{status:'delivered'});
        executeOwnerDecision(dec);
      }catch(_){}
    }, 2000);
  }

  function executeOwnerDecision(dec) {
    const name = session._ownerName || 'Sir';
    let inst = '';
    if (dec.decision==='transfer') {
      if (session.humanTransferNumber) {
        inst = `[OWNER] ${name} ji ne transfer bola. Boliye: "Hold kariye, transfer kar rahi hu." Then use transfer_to_human tool.`;
      } else { inst = `[OWNER] ${name} ji jald call back karenge.`; }
    } else if (dec.decision==='callback') {
      inst = `[OWNER] ${name} ji ${dec.callback_time||dec.custom_message||'jald'} mein call back karenge.`;
    } else if (dec.decision==='take_message') {
      inst = `[OWNER] ${name} ji busy hain. Message le lijiye.`;
    } else if (dec.decision==='block') {
      inst = `[OWNER] Politely end. ${name} ji available nahi hain.`;
    }
    if (!inst) return;
    console.log(`[${reqId}] 🎯 Owner: ${dec.decision}`);
    sendToVL({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:inst}]}});
    sendToVL({type:'response.create'});
    if (dec.decision==='block') setTimeout(()=>hangupCall('owner blocked'),4000);
  }

  // ─── Load Agent Config ───
  async function loadAgentConfig() {
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.23');
      const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      let callLog = null;
      const cutoff = new Date(Date.now() - 120000).toISOString();

      // Strategy 1: call_sid
      if (session.callSid) {
        for (const sid of [session.callSid, session.callSid.replace(/^[^-]*-/,'').replace(/\.[^.]*$/,'')].filter(Boolean)) {
          if (callLog) break;
          try { const logs = await svc.entities.CallLog.filter({call_sid:sid}); if(logs.length) callLog=logs[0]; } catch(_){}
        }
      }

      // Strategy 2: recent ringing/initiated
      if (!callLog) {
        const ce = (session.calleeNumber||'').replace(/\D/g,'');
        const match = l => { const u=l.filter(x=>!x.stream_sid&&x.created_date>=cutoff); if(ce){const m=u.find(x=>(x.callee_number||'').replace(/\D/g,'').slice(-10)===ce.slice(-10)); if(m)return m;} return u[0]||null; };
        const [ring,init] = await Promise.all([svc.entities.CallLog.filter({status:'ringing'},'-created_date',20).catch(()=>[]), svc.entities.CallLog.filter({status:'initiated'},'-created_date',20).catch(()=>[])]);
        callLog = match(ring) || match(init);
      }

      // Strategy 3: DID→Agent (inbound)
      if (!callLog && (session.calleeNumber||session.callerNumber)) {
        const calleeDID = (session.calleeNumber||'').replace(/\D/g,'').slice(-10);
        const callerDID = (session.callerNumber||'').replace(/\D/g,'').slice(-10);
        if (calleeDID) {
          const allDIDs = await svc.entities.DID.list('-created_date', 200);
          const matched = allDIDs.find(d => { const n=(d.number||'').replace(/\D/g,'').slice(-10); return n===calleeDID||n===callerDID; });
          let agent = null, client = null;
          if (matched?.agent_id) agent = await svc.entities.Agent.get(matched.agent_id).catch(()=>null);
          if (matched?.client_id) client = await svc.entities.Client.get(matched.client_id).catch(()=>null);
          if (!agent) {
            const agents = await svc.entities.Agent.list('-created_date', 100);
            agent = agents.find(a => { const dids=a.assigned_dids||(a.assigned_did?[a.assigned_did]:[]); return dids.some(d=>(d||'').replace(/\D/g,'').slice(-10)===calleeDID||(d||'').replace(/\D/g,'').slice(-10)===callerDID); });
            if (agent && !client) client = await svc.entities.Client.get(agent.client_id).catch(()=>null);
          }
          if (agent) {
            session.clientId = client?.id || agent.client_id;
            session.systemPrompt = agent.system_prompt || session.systemPrompt;
            if (agent.greeting_message) session.greetingMessage = agent.greeting_message;
            if (agent.human_transfer_number) session.humanTransferNumber = agent.human_transfer_number;
            if (agent.persona?.voice_engine) session.voiceEngine = agent.persona.voice_engine;
            if (agent.persona?.voice_type) session.voiceType = agent.persona.voice_type;
            if (agent.knowledge_base_ids?.length) {
              const docs = await Promise.all(agent.knowledge_base_ids.map(id=>svc.entities.KnowledgeBase.get(id).catch(()=>null)));
              const kb = docs.filter(d=>d?.content).map(d=>`[${d.title}]\n${d.content}`).join('\n---\n');
              if (kb) session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${kb}`;
            }
            // Check Shopify
            try {
              const si = await svc.entities.MarketplaceIntegration.filter({client_id:session.clientId,platform:'shopify',status:'active'});
              if (si.length > 0) { session.hasShopify = true; session.systemPrompt += '\n\n--- SHOPIFY ACTIVE: Use shopify_lookup tool for orders/products/tracking. ---'; }
            } catch(_){}
            // Create inbound CallLog
            try {
              const log = await svc.entities.CallLog.create({ client_id:session.clientId, agent_id:agent.id, call_sid:session.callSid||`inbound_${Date.now()}`, stream_sid:session.streamSid, caller_id:session.callerNumber, callee_number:session.calleeNumber, direction:'inbound', status:'answered', call_start_time:new Date().toISOString(), agent_config_cache:{agent_name:agent.name,system_prompt:session.systemPrompt,persona:agent.persona||{},greeting_message:agent.greeting_message||''} });
              session.callLogId = log.id;
              console.log(`[${reqId}] ✅ Inbound CallLog: ${log.id}`);
            } catch(e) { console.error(`[${reqId}] ⚠️ CallLog: ${e.message}`); }
            if (client?.account_type === 'personal') await setupPersonalMode(svc, client);
            return;
          }
        }
      }

      if (!callLog) { console.log(`[${reqId}] ⚠️ No call log — default prompt`); return; }

      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      if (callLog.call_sid && callLog.call_sid !== session.callSid) session.smartfloCallId = callLog.call_sid;
      const cache = callLog.agent_config_cache;
      if (cache?.system_prompt) {
        session.systemPrompt = cache.system_prompt;
        if (cache.knowledge_base_content) session.systemPrompt += `\n\nKNOWLEDGE BASE:\n${cache.knowledge_base_content}`;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (cache.persona?.voice_engine) session.voiceEngine = cache.persona.voice_engine;
        if (cache.persona?.voice_type) session.voiceType = cache.persona.voice_type;
      }
      // Shopify check
      if (callLog.client_id) {
        try {
          const si = await svc.entities.MarketplaceIntegration.filter({client_id:callLog.client_id,platform:'shopify',status:'active'});
          if (si.length > 0) { session.hasShopify = true; if (!session.systemPrompt.includes('SHOPIFY')) session.systemPrompt += '\n\n--- SHOPIFY ACTIVE: Use shopify_lookup tool. ---'; }
        } catch(_){}
        const client = await svc.entities.Client.get(callLog.client_id).catch(()=>null);
        if (client?.account_type === 'personal') await setupPersonalMode(svc, client);
      }
      // Claim
      if (session.streamSid) svc.entities.CallLog.update(callLog.id, { stream_sid: session.streamSid }).catch(()=>{});
    } catch(e) { console.error(`[${reqId}] ❌ Config: ${e.message}`); }
  }

  async function setupPersonalMode(svc, client) {
    const aiMode = client.ai_response_mode || 'screen_all';
    session._personalMode = aiMode;
    session._personalClientId = client.id;
    session._ownerName = client.company_name || '';
    let pi = '\n\n--- PERSONAL AI ASSISTANT ---';
    if (aiMode==='block_all') pi += '\nBlock all. Say unavailable. End quickly.';
    else if (aiMode==='take_messages') pi += '\nTake messages from every caller.';
    else pi += '\nScreen all calls. Classify & take messages.';
    if (client.dnd_enabled) pi += '\nDND ON.';
    session.systemPrompt += pi;
    // Telegram notification
    if (client.telegram_connected && client.telegram_chat_id && !client.dnd_enabled && client.owner_notification_channel === 'telegram') {
      const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
      if (tgT) fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:client.telegram_chat_id,text:`📞 <b>Incoming</b>\n📱 <b>${session.callerNumber||'Unknown'}</b>\n💬 AI screening...`,parse_mode:'HTML'}) }).catch(()=>{});
    }
  }

  // ═══ Pre-warm Voice Live connection ═══
  connectVoiceLive();

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
        session.calleeNumber = s.customParameters?.customer_number || s.to || '';
        session.callerNumber = s.from || '';
        if (!s.customParameters?.customer_number && s.to && s.from) {
          session.calleeNumber = s.to; session.callerNumber = s.from;
        }
        console.log(`[${reqId}] 📞 START: stream=${session.streamSid}, callee=${session.calleeNumber}, caller=${session.callerNumber}`);

        loadAgentConfig().then(() => {
          session._configReady = true;
          console.log(`[${reqId}] 🚀 Config ready: voice=${session.voiceType}`);
          if (session._vlReady) applySessionConfig();
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        // Forward mu-law audio DIRECTLY to Voice Live (no conversion needed!)
        if (session._vlReady && session._vlWs?.readyState === WebSocket.OPEN) {
          sendToVL({ type: 'input_audio_buffer.append', audio: msg.media.payload });
        }
        return;
      }

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Stop`);
        session._callEnded = true;
        if (session._vlWs?.readyState === WebSocket.OPEN) session._vlWs.close();
        await saveCallRecord(session, reqId, Math.round((Date.now() - session.startTime) / 1000));
        return;
      }
    } catch (err) { console.error(`[${reqId}] ❌ Msg: ${err.message}`); }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    const dur = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Smartflo closed, ${dur}s`);
    if (session._vlWs?.readyState === WebSocket.OPEN) session._vlWs.close();
    if (session.callLogId) await saveCallRecord(session, reqId, dur);
  };

  smartfloSocket.onerror = () => {
    console.error(`[${reqId}] ❌ Smartflo error`);
    if (session._vlWs?.readyState === WebSocket.OPEN) session._vlWs.close();
  };

  return response;
});