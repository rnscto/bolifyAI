import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

  // ─── CORS preflight ───
  if (req.method === 'OPTIONS') {
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
      if (body.action === 'create_lead') {
        const { createClient } = await import('npm:@base44/sdk@0.8.6');
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
        console.log(`[${reqId}] Lead created: ${lead.id}`);
        return Response.json({ success: true, lead_id: lead.id });
      }

      return Response.json({ error: 'Unknown action' }, { status: 400 });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // ─── HTTP GET (non-WS): return status ───
  if (upgrade !== 'websocket') {
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
    console.log(`[${reqId}] ✅ Browser WebSocket upgraded`);
  } catch (err) {
    console.error(`[${reqId}] ❌ WS upgrade failed: ${err.message}`);
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  // ─── Session State ───
  const session = {
    realtimeWs: null,
    realtimeReady: false,
    transcript: [],
    startTime: Date.now()
  };

  // ─── Connect to Azure Realtime API ───
  function connectRealtime() {
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_KEY');

    if (!realtimeUrl || !realtimeKey) {
      console.error(`[${reqId}] ❌ Missing AZURE_REALTIME_ENDPOINT or AZURE_REALTIME_KEY`);
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'error', message: 'Server misconfigured' }));
      }
      return;
    }

    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    const sep = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${sep}api-key=${encodeURIComponent(realtimeKey)}`;
    console.log(`[${reqId}] 🔌 Connecting to Azure Realtime...`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${reqId}] ✅ Azure Realtime connected`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeMessage(msg);
      } catch (err) {
        console.error(`[${reqId}] Parse error: ${err.message}`);
      }
    };

    ws.onclose = (event) => {
      console.log(`[${reqId}] 🔴 Azure closed: ${event.code}`);
      session.realtimeReady = false;
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'session_ended' }));
      }
    };

    ws.onerror = () => {
      console.error(`[${reqId}] ❌ Azure Realtime error`);
    };

    session.realtimeWs = ws;
  }

  // ─── Handle messages FROM Azure Realtime ───
  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Realtime session created`);
      session.realtimeReady = true;

      // Configure session
      sendToRealtime({
        type: 'session.update',
        session: {
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
        }
      });

      // Tell browser we're ready
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'session_ready' }));
      }
      return;
    }

    if (type === 'session.updated') {
      console.log(`[${reqId}] ✅ Session configured`);
      return;
    }

    // Audio from AI → forward to browser as base64 PCM16 24kHz
    if (type === 'response.audio.delta' && msg.delta) {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({
          type: 'audio',
          data: msg.delta  // base64 PCM16 LE 24kHz
        }));
      }
      return;
    }

    if (type === 'response.audio.done') {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'audio_done' }));
      }
      return;
    }

    // User speech transcription
    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        session.transcript.push({ speaker: 'user', text });
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
        session.transcript.push({ speaker: 'ai', text });
        if (browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.send(JSON.stringify({ type: 'transcript', role: 'ai', text }));
        }
      }
      return;
    }

    // Barge-in
    if (type === 'input_audio_buffer.speech_started') {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'speech_started' }));
      }
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'speech_stopped' }));
      }
      return;
    }

    if (type === 'error') {
      console.error(`[${reqId}] ❌ Realtime error:`, JSON.stringify(msg.error || msg));
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(JSON.stringify({ type: 'error', message: msg.error?.message || 'AI error' }));
      }
      return;
    }
  }

  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    }
  }

  // ─── Browser WebSocket Handlers ───
  browserSocket.onopen = () => {
    console.log(`[${reqId}] 🟢 Browser socket opened`);
    connectRealtime();
  };

  browserSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // Browser sends audio as base64 PCM16 24kHz
      if (msg.type === 'audio') {
        if (session.realtimeReady) {
          sendToRealtime({
            type: 'input_audio_buffer.append',
            audio: msg.data
          });
        }
        return;
      }

      // Browser requests to commit audio buffer (optional)
      if (msg.type === 'commit') {
        sendToRealtime({ type: 'input_audio_buffer.commit' });
        return;
      }

      // Browser sends text message
      if (msg.type === 'text') {
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

    } catch (err) {
      console.error(`[${reqId}] ❌ Browser msg error: ${err.message}`);
    }
  };

  browserSocket.onclose = () => {
    console.log(`[${reqId}] 🔴 Browser socket closed`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  browserSocket.onerror = () => {
    console.error(`[${reqId}] ❌ Browser socket error`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  return response;
});