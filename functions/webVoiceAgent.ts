import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const VAANI_KNOWLEDGE_BASE = `
=== ABOUT VAANIAI ===
VaaniAI is India's #1 AI-powered voice agent platform built for sales automation, lead qualification, customer engagement, and e-Governance solutions. We help businesses automate their outbound and inbound calling with human-like AI voice agents that can speak English, Hindi, and bilingual (Hinglish).

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
   - Industry-specific deal pipelines
   - Contact & lead management with scoring
   - Activity tracking, Deal Kanban board
   - Sales reports & analytics
   - 14-day free CRM trial

=== PRICING ===
- Voice AI Agent: ₹6,500/month per channel (₹19,500/quarter)
- Each channel = 1 concurrent call line (DID number)
- Unlimited calls & minutes (NO per-minute charges)
- CRM: ₹1,999/month (optional add-on)
- 7-day free trial, no credit card required
- 5 channels = 5 simultaneous calls = ₹32,500/month

=== INDUSTRIES (10+) ===
Real Estate, Healthcare, Education, Gym & Fitness, Insurance, Automotive, Travel & Hospitality, Retail & E-commerce, Financial Services, Government/e-Governance

=== HOW IT WORKS ===
1. Sign Up & Onboarding → Select industry → Configure AI agent → Get DID number
2. Train Agent → Upload knowledge base docs → Set system prompt → Configure persona
3. Import Leads & Launch → Upload CSV → Create campaign → Set follow-up rules
4. Track & Optimize → Monitor calls → Review transcripts → Analyze outcomes

=== COMPETITIVE ADVANTAGES ===
- Made in India, for Indian businesses
- Hindi + English + Bilingual support
- Affordable (₹6,500/month vs competitors at $500+/month)
- Enterprise-grade Tata Smartflo telephony
- Unlimited calls (no per-minute charges)
- 7-day free trial, no credit card
- Data preserved after trial expiry

=== FAQ ===
Q: Hindi support? A: Yes - English, Hindi, and bilingual (Hinglish)
Q: Simultaneous calls? A: 1 per channel. Buy multiple for concurrent calling.
Q: Per-minute charges? A: No! Unlimited calls & minutes per channel.
Q: Free trial? A: 7-day free trial, full features, no credit card.
Q: CRM integration? A: Salesforce, HubSpot, Zoho, custom webhooks/API.
Q: After trial? A: Data preserved. Subscribe to reactivate instantly.
Q: Data security? A: Enterprise-grade encryption, data stored in India.
Q: Appointment booking? A: Yes - AI books appointments, sends confirmations, creates follow-ups.
`;

const SYSTEM_PROMPT = `You are VaaniAI's friendly AI voice assistant on the website. Keep responses concise (2-3 sentences max).

GOALS:
1. Answer questions about VaaniAI using the knowledge base
2. Naturally collect visitor details during conversation (name, email, phone, solution interest)
3. Encourage the 7-day free trial

LEAD COLLECTION (weave naturally, don't ask all at once):
- After first answer: "May I know your name?"
- After discussing features: "Would you like pricing details sent to you? What's your email?"
- When they mention business: "What's the best number to reach you for a demo?"

Use Indian English naturally. Be warm and professional.

${VAANI_KNOWLEDGE_BASE}`;

Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWebSocket = upgrade === 'websocket';

  // ─── CORS preflight ───
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id'
      }
    });
  }

  // ─── Non-WebSocket: handle REST actions (create_lead) ───
  if (!isWebSocket) {
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
          notes: `Solution Interest: ${body.solution || 'Not specified'}\nIntent: ${body.intent || 'exploring'}\nSentiment: ${body.sentiment || 'neutral'}\n\nConversation Summary:\n${body.conversation_summary || ''}`,
          tags: ['website_lead', 'voice_agent', body.intent || 'exploring'].filter(Boolean),
          custom_fields: {
            solution_interest: body.solution || '',
            visitor_industry: body.industry || '',
            intent: body.intent || 'exploring',
            sentiment: body.sentiment || 'neutral',
            source_page: 'home'
          }
        });

        try { serviceClient.cleanup(); } catch (_) {}
        console.log(`[${reqId}] Lead created: ${lead.id} - ${body.name}`);
        return Response.json({ success: true, lead_id: lead.id });
      }

      return Response.json({ error: 'Unknown action. Use WebSocket for voice.' }, { status: 400 });
    } catch (err) {
      console.error(`[${reqId}] REST error:`, err.message);
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // ─── WebSocket upgrade for browser voice client ───
  let clientSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    clientSocket = upgraded.socket;
    response = upgraded.response;
    console.log(`[${reqId}] ✅ Browser WebSocket upgraded`);
  } catch (err) {
    console.error(`[${reqId}] ❌ Upgrade failed: ${err.message}`);
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  // ─── Session state ───
  const session = {
    realtimeWs: null,
    realtimeReady: false,
    transcript: [],
    startTime: Date.now(),
    isSpeaking: false,
    _saved: false
  };

  // ─── Helper: send JSON to browser client ───
  function sendToClient(data) {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify(data));
    }
  }

  // ─── Helper: send JSON to Azure Realtime ───
  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    }
  }

  // ─── Connect to Azure Realtime API ───
  function connectRealtime() {
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_KEY');

    if (!realtimeUrl || !realtimeKey) {
      console.error(`[${reqId}] ❌ Missing AZURE_REALTIME_ENDPOINT or AZURE_REALTIME_KEY`);
      sendToClient({ type: 'status', status: 'error', message: 'Server configuration error' });
      return;
    }

    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    const separator = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${separator}api-key=${encodeURIComponent(realtimeKey)}`;
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
        console.error(`[${reqId}] ❌ Realtime parse error: ${err.message}`);
      }
    };

    ws.onclose = (event) => {
      console.log(`[${reqId}] 🔴 Azure Realtime closed: code=${event.code}`);
      session.realtimeReady = false;
      sendToClient({ type: 'status', status: 'session_ended' });
    };

    ws.onerror = () => {
      console.error(`[${reqId}] ❌ Azure Realtime error`);
      sendToClient({ type: 'status', status: 'error', message: 'Realtime connection error' });
    };

    session.realtimeWs = ws;
  }

  // ─── Handle messages FROM Azure Realtime API ───
  function handleRealtimeMessage(msg) {
    const type = msg.type;

    // Session created → configure it
    if (type === 'session.created') {
      console.log(`[${reqId}] ✅ Realtime session created`);
      session.realtimeReady = true;

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
      console.log(`[${reqId}] 📤 Session configured`);
      return;
    }

    if (type === 'session.updated') {
      console.log(`[${reqId}] ✅ Session updated, sending ready to client`);
      sendToClient({ type: 'status', status: 'ready' });
      return;
    }

    // ─── Audio delta from AI → forward to browser ───
    if (type === 'response.audio.delta' && msg.delta) {
      session.isSpeaking = true;
      sendToClient({ type: 'audio_delta', audio: msg.delta });
      return;
    }

    if (type === 'response.audio.done') {
      session.isSpeaking = false;
      sendToClient({ type: 'status', status: 'listening' });
      return;
    }

    // ─── User speech transcription ───
    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        console.log(`[${reqId}] 🗣️ User: "${text.substring(0, 80)}"`);
        session.transcript.push({ speaker: 'User', text });
        sendToClient({ type: 'user_transcript', text });
      }
      return;
    }

    // ─── AI speech transcription ───
    if (type === 'response.audio_transcript.done' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        console.log(`[${reqId}] 🤖 AI: "${text.substring(0, 80)}"`);
        session.transcript.push({ speaker: 'AI', text });
        sendToClient({ type: 'ai_transcript', text });
      }
      return;
    }

    // ─── User started speaking (barge-in) ───
    if (type === 'input_audio_buffer.speech_started') {
      console.log(`[${reqId}] 🛑 Barge-in detected`);
      session.isSpeaking = false;
      sendToClient({ type: 'status', status: 'listening' });
      sendToClient({ type: 'barge_in' });
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      sendToClient({ type: 'status', status: 'processing' });
      return;
    }

    // ─── Response started ───
    if (type === 'response.created') {
      sendToClient({ type: 'status', status: 'speaking' });
      return;
    }

    if (type === 'error') {
      console.error(`[${reqId}] ❌ Realtime API error:`, JSON.stringify(msg.error || msg));
      sendToClient({ type: 'status', status: 'error', message: msg.error?.message || 'AI error' });
      return;
    }
  }

  // ─── Browser WebSocket handlers ───
  clientSocket.onopen = () => {
    console.log(`[${reqId}] 🟢 Browser client connected`);
    sendToClient({ type: 'status', status: 'connecting' });
    connectRealtime();
  };

  clientSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // Browser sends audio chunks as base64 PCM16 24kHz
      if (msg.type === 'audio_append' && msg.audio) {
        if (!session.realtimeReady) return;
        sendToRealtime({
          type: 'input_audio_buffer.append',
          audio: msg.audio
        });
        return;
      }

      // Browser requests to end session
      if (msg.type === 'end_session') {
        console.log(`[${reqId}] 📴 Client requested end`);
        if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
          session.realtimeWs.close();
        }
        sendToClient({ type: 'status', status: 'session_ended' });
        return;
      }
    } catch (err) {
      console.error(`[${reqId}] ❌ Client message error: ${err.message}`);
    }
  };

  clientSocket.onclose = () => {
    console.log(`[${reqId}] 🔴 Browser client disconnected`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  clientSocket.onerror = () => {
    console.error(`[${reqId}] ❌ Browser socket error`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  return response;
});