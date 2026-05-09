import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

const VAANI_KNOWLEDGE_BASE = `
=== ABOUT VAANIAI ===
VaaniAI is India's #1 AI-powered voice agent platform for sales automation, lead qualification, customer engagement, and e-Governance. We automate outbound and inbound calling with human-like AI voice agents in English, Hindi, and Hinglish.

=== CORE PRODUCTS ===
1. AI VOICE AGENT (₹6,500/month per channel, quarterly billing)
   - AI-powered outbound & inbound calling
   - Human-like conversations (Azure OpenAI GPT-4o Realtime)
   - Automated lead qualification & appointment booking
   - Real-time transcription & AI summaries
   - Call recording, concurrent multi-channel calling (50+)
   - Post-call follow-up emails, campaign management
   - Knowledge base training (PDF, DOCX, CSV)
   - Tata Smartflo enterprise telephony
   - Unlimited calls & minutes per channel

2. CUSTOM SALES CRM (₹1,999/month add-on)
   - Industry-specific deal pipelines, Contact & lead management
   - Activity tracking, Deal Kanban board, Sales reports & analytics

=== PRICING ===
- Voice AI Agent: ₹6,500/month per channel (₹19,500/quarter)
- Each channel = 1 concurrent call line (DID number)
- Unlimited calls & minutes (NO per-minute charges)
- CRM: ₹1,999/month (optional add-on)
- 7-day free trial, no credit card required

=== INDUSTRIES ===
Real Estate, Healthcare, Education, Gym & Fitness, Insurance, Automotive, Travel, Retail, Financial Services, Government

=== COMPETITIVE ADVANTAGES ===
- Made in India, Hindi + English + Bilingual
- ₹6,500/month vs competitors at $500+/month
- Enterprise-grade Tata Smartflo telephony
- Unlimited calls, 7-day free trial
`;

const SYSTEM_PROMPT = `You are VaaniAI's friendly voice assistant on the website. You speak naturally and concisely (2-3 sentences).
Your goals:
1. Answer questions about VaaniAI using your knowledge base
2. Naturally collect visitor details (name, email, phone, interest)
3. Encourage the 7-day free trial
Be warm, professional, and use Indian English naturally.

${VAANI_KNOWLEDGE_BASE}`;

Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const t0 = Date.now();
  const log = (level, ...args) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const prefix = `[${reqId}][${elapsed}s]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  };

  log('info', `📨 ${req.method} ${req.url} | upgrade=${upgrade} | origin=${req.headers.get('origin') || 'none'}`);

  // ─── CORS preflight ───
  if (req.method === 'OPTIONS') {
    log('info', '✅ CORS preflight response');
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id'
      }
    });
  }

  // ─── HTTP POST: create_lead action ───
  if (req.method === 'POST' && upgrade !== 'websocket') {
    try {
      const body = await req.json();
      log('info', `📋 POST action=${body.action}`);
      if (body.action === 'create_lead') {
        const { createClient } = await import('npm:@base44/sdk@0.8.18');
        const appId = Deno.env.get('BASE44_APP_ID');
        const serviceClient = createClient({ appId, asServiceRole: true });

        const lead = await serviceClient.entities.Lead.create({
          client_id: 'website_visitor',
          name: body.name || 'Website Visitor',
          phone: body.phone || '',
          email: body.email || '',
          status: 'new',
          source: 'website_voice_agent',
          notes: `Solution: ${body.solution || 'N/A'}\nIntent: ${body.intent || 'exploring'}\nSentiment: ${body.sentiment || 'neutral'}\n\n${body.conversation_summary || ''}`,
          tags: ['website_lead', 'voice_agent'],
          custom_fields: {
            solution_interest: body.solution || '',
            intent: body.intent || 'exploring',
            sentiment: body.sentiment || 'neutral'
          }
        });

        try { serviceClient.cleanup(); } catch (_) {}
        log('info', `✅ Lead created: ${lead.id} | name=${body.name} email=${body.email} phone=${body.phone}`);
        return Response.json({ success: true, lead_id: lead.id });
      }

      log('warn', `⚠️ Unknown POST action: ${body.action}`);
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    } catch (err) {
      log('error', `❌ POST error: ${err.message}`);
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // ─── HTTP GET (non-WS): return status ───
  if (upgrade !== 'websocket') {
    log('info', '📋 HTTP GET status check');
    return Response.json({
      status: 'ready',
      version: 'v7.0-web-realtime',
      info: 'Connect via WebSocket for real-time voice'
    });
  }

  // ─── WebSocket upgrade: browser <-> Azure Realtime relay ───
  let browserSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    browserSocket = upgraded.socket;
    response = upgraded.response;
    log('info', '✅ Browser WebSocket upgraded successfully');
  } catch (err) {
    log('error', `❌ WS upgrade failed: ${err.message}`);
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  // ─── Session State ───
  const session = {
    realtimeWs: null,
    realtimeReady: false,
    transcript: [],
    startTime: Date.now(),
    stats: {
      browserAudioPackets: 0,
      browserAudioBytes: 0,
      azureAudioDeltas: 0,
      azureAudioBytes: 0,
      browserTextMessages: 0,
      transcriptsReceived: 0,
      bargeIns: 0,
      errors: 0
    }
  };

  // ─── Connect to Azure Realtime API ───
  function connectRealtime() {
    // Prefer new gpt-realtime-whisper deployment (launched 2026-05-07).
    // Falls back to legacy AZURE_REALTIME_ENDPOINT/KEY if new secrets aren't set.
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_WHISPER_ENDPOINT') || Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_WHISPER_KEY') || Deno.env.get('AZURE_REALTIME_KEY');
    const useWhisper = !!(Deno.env.get('AZURE_REALTIME_WHISPER_ENDPOINT') && Deno.env.get('AZURE_REALTIME_WHISPER_KEY'));
    const deploymentName = useWhisper ? 'gpt-realtime-whisper' : 'gpt-realtime-1.5';

    log('info', `🔌 Azure config: endpoint=${realtimeUrl ? realtimeUrl.substring(0, 50) + '...' : 'MISSING'}, key=${realtimeKey ? 'SET (' + realtimeKey.length + ' chars)' : 'MISSING'}, model=${deploymentName}`);

    if (!realtimeUrl || !realtimeKey) {
      log('error', '❌ Missing AZURE_REALTIME_WHISPER_ENDPOINT/KEY (or fallback AZURE_REALTIME_ENDPOINT/KEY)');
      session.stats.errors++;
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'error', message: 'Server misconfigured: missing Azure credentials' }));
      }
      return;
    }

    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    // Foundry GA endpoints (services.ai.azure.com) use /openai/v1/realtime?model=<deployment>
    // Legacy Azure OpenAI endpoints (openai.azure.com) use /openai/realtime?api-version=...&deployment=<deployment>
    const isFoundry = wsUrl.includes('services.ai.azure.com');
    if (!wsUrl.includes('/openai/realtime') && !wsUrl.includes('/openai/v1/realtime')) {
      if (isFoundry) {
        wsUrl = wsUrl.replace(/\/+$/, '') + `/openai/v1/realtime?model=${deploymentName}`;
      } else {
        wsUrl = wsUrl.replace(/\/+$/, '') + `/openai/realtime?api-version=2025-04-01-preview&deployment=${deploymentName}`;
      }
    }
    if (!isFoundry) {
      wsUrl = wsUrl.replace('api-version=2025-04-01&', 'api-version=2025-04-01-preview&');
    }
    const sep = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${sep}api-key=${encodeURIComponent(realtimeKey)}`;
    log('info', `🔌 Connecting to Azure Realtime: ${wsUrl.substring(0, 80)}... | model=${deploymentName}`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      log('info', '✅ Azure Realtime WebSocket connected');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeMessage(msg);
      } catch (err) {
        log('error', `❌ Azure message parse error: ${err.message}`);
        session.stats.errors++;
      }
    };

    ws.onclose = (event) => {
      log('info', `🔴 Azure Realtime closed: code=${event.code} reason="${event.reason || 'none'}" wasClean=${event.wasClean}`);
      session.realtimeReady = false;
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'session_ended' }));
      }
    };

    ws.onerror = () => {
      log('error', '❌ Azure Realtime WebSocket error event');
      session.stats.errors++;
    };

    session.realtimeWs = ws;
  }

  // ─── Handle messages FROM Azure Realtime ───
  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      log('info', `✅ Realtime session created | id=${msg.session?.id || 'unknown'}`);
      session.realtimeReady = true;

      // Configure session
      const sessionConfig = {
        instructions: SYSTEM_PROMPT,
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600
        }
      };

      log('info', `📤 Sending session.update | prompt_length=${SYSTEM_PROMPT.length} | voice=alloy | format=pcm16 | vad=server`);
      sendToRealtime({ type: 'session.update', session: sessionConfig });

      // Tell browser we're ready
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'session_ready' }));
        log('info', '📤 Sent session_ready to browser');
      }
      return;
    }

    if (type === 'session.updated') {
      log('info', '✅ Session configured successfully');
      return;
    }

    // Audio from AI → forward to browser as base64 PCM16 24kHz
    if (type === 'response.audio.delta' && msg.delta) {
      session.stats.azureAudioDeltas++;
      session.stats.azureAudioBytes += msg.delta.length;
      if (session.stats.azureAudioDeltas <= 3 || session.stats.azureAudioDeltas % 50 === 0) {
        log('info', `🔊 Azure→Browser audio delta #${session.stats.azureAudioDeltas} | ${msg.delta.length} b64 chars | total=${session.stats.azureAudioBytes} | browserWS=${browserSocket.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED'}`);
      }
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'audio', data: msg.delta }));
      } else {
        log('warn', `⚠️ Browser socket not open, dropping audio delta #${session.stats.azureAudioDeltas}`);
      }
      return;
    }

    if (type === 'response.audio.done') {
      log('info', `🔊 AI audio response complete | total_deltas=${session.stats.azureAudioDeltas} | total_b64_bytes=${session.stats.azureAudioBytes}`);
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'audio_done' }));
      }
      return;
    }

    // User speech transcription
    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        session.stats.transcriptsReceived++;
        session.transcript.push({ speaker: 'user', text });
        log('info', `🗣️ USER transcript #${session.stats.transcriptsReceived}: "${text.substring(0, 120)}"`);
        if (browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.send(JSON.stringify({ type: 'transcript', role: 'user', text }));
        }
      }
      return;
    }

    // AI speech transcription
    if (type === 'response.audio_transcript.done' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        session.stats.transcriptsReceived++;
        session.transcript.push({ speaker: 'ai', text });
        log('info', `🤖 AI transcript #${session.stats.transcriptsReceived}: "${text.substring(0, 120)}"`);
        if (browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.send(JSON.stringify({ type: 'transcript', role: 'ai', text }));
        }
      }
      return;
    }

    // Barge-in
    if (type === 'input_audio_buffer.speech_started') {
      session.stats.bargeIns++;
      log('info', `🛑 User speech started (barge-in #${session.stats.bargeIns})`);
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'speech_started' }));
      }
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      log('info', '🔇 User speech stopped');
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'speech_stopped' }));
      }
      return;
    }

    if (type === 'error') {
      session.stats.errors++;
      log('error', `❌ Azure Realtime error #${session.stats.errors}: ${JSON.stringify(msg.error || msg)}`);
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'error', message: msg.error?.message || 'AI error' }));
      }
      return;
    }

    // Log all other Azure events for debugging
    if (!['response.created', 'response.output_item.added', 'response.content_part.added',
          'response.output_item.done', 'response.content_part.done', 'response.done',
          'conversation.item.created', 'rate_limits.updated'].includes(type)) {
      log('info', `📩 Azure event (unhandled): ${type}`);
    }
  }

  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    } else {
      log('warn', `⚠️ Cannot send to Azure Realtime: ws=${session.realtimeWs ? 'exists' : 'null'} readyState=${session.realtimeWs?.readyState}`);
    }
  }

  function logSessionStats() {
    const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
    const s = session.stats;
    log('info', `📊 SESSION STATS | duration=${duration}s | browser_audio_pkts=${s.browserAudioPackets} (${(s.browserAudioBytes/1024).toFixed(1)}KB) | azure_audio_deltas=${s.azureAudioDeltas} (${(s.azureAudioBytes/1024).toFixed(1)}KB b64) | text_msgs=${s.browserTextMessages} | transcripts=${s.transcriptsReceived} | barge_ins=${s.bargeIns} | errors=${s.errors} | transcript_lines=${session.transcript.length}`);
    if (session.transcript.length > 0) {
      log('info', `📝 FULL TRANSCRIPT:\n${session.transcript.map(t => `  ${t.speaker}: ${t.text}`).join('\n')}`);
    }
  }

  // ─── Browser WebSocket Handlers ───
  browserSocket.onopen = () => {
    log('info', '🟢 Browser socket opened → connecting to Azure Realtime...');
    connectRealtime();
  };

  browserSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // Browser sends audio as base64 PCM16 24kHz
      if (msg.type === 'audio') {
        session.stats.browserAudioPackets++;
        session.stats.browserAudioBytes += (msg.data?.length || 0);
        if (session.stats.browserAudioPackets <= 3 || session.stats.browserAudioPackets % 100 === 0) {
          log('info', `🎤 Browser→Azure audio #${session.stats.browserAudioPackets} | ${msg.data?.length || 0} b64 chars | realtimeReady=${session.realtimeReady}`);
        }
        if (session.realtimeReady) {
          sendToRealtime({
            type: 'input_audio_buffer.append',
            audio: msg.data
          });
        } else {
          if (session.stats.browserAudioPackets <= 5) {
            log('warn', `⏳ Azure not ready yet, dropping browser audio #${session.stats.browserAudioPackets}`);
          }
        }
        return;
      }

      // Browser requests to commit audio buffer (optional)
      if (msg.type === 'commit') {
        log('info', '📤 Browser requested audio buffer commit');
        sendToRealtime({ type: 'input_audio_buffer.commit' });
        return;
      }

      // Browser sends text message
      if (msg.type === 'text') {
        session.stats.browserTextMessages++;
        log('info', `💬 Browser text #${session.stats.browserTextMessages}: "${msg.text?.substring(0, 100)}"`);
        sendToRealtime({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: msg.text }]
          }
        });
        sendToRealtime({ type: 'response.create' });
        return;
      }

      log('warn', `⚠️ Unknown browser message type: ${msg.type}`);
    } catch (err) {
      log('error', `❌ Browser msg parse/handle error: ${err.message}`);
      session.stats.errors++;
    }
  };

  browserSocket.onclose = (event) => {
    log('info', `🔴 Browser socket closed: code=${event.code} reason="${event.reason || 'none'}" wasClean=${event.wasClean}`);
    logSessionStats();
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      log('info', '🔌 Closing Azure Realtime connection...');
      session.realtimeWs.close();
    }
  };

  browserSocket.onerror = () => {
    log('error', '❌ Browser socket error event');
    session.stats.errors++;
    logSessionStats();
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  return response;
});