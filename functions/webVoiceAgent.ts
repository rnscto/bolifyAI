import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const VAANI_KNOWLEDGE_BASE = `
=== ABOUT VAANIAI ===
VaaniAI is India's #1 AI-powered voice agent platform built for sales automation, lead qualification, customer engagement, and e-Governance solutions. We help businesses automate their outbound and inbound calling with human-like AI voice agents that can speak English, Hindi, and bilingual (Hinglish).

=== OUR CORE PRODUCTS ===

1. AI VOICE AGENT (Primary Product)
   - AI-powered outbound & inbound calling
   - Human-like conversations with natural voice (powered by Azure OpenAI GPT-4o Realtime)
   - Automated lead qualification, appointment booking, follow-ups
   - Real-time call transcription & AI-generated summaries
   - Barge-in support (caller can interrupt AI mid-sentence)
   - Server-side Voice Activity Detection (VAD)
   - Call recording with playback
   - Concurrent multi-channel calling (up to 50+ simultaneous calls)
   - Automated post-call follow-up emails
   - Campaign management for bulk calling
   - Knowledge base training - upload PDFs, docs, CSVs to train your agent
   - Works with Tata Smartflo telephony infrastructure

2. CUSTOM SALES CRM (Add-on Product)
   - Industry-specific deal pipelines (customizable stages)
   - Contact & lead management with scoring
   - Activity tracking (calls, meetings, tasks, follow-ups)
   - Deal Kanban board with drag-and-drop
   - Sales reports & analytics
   - Automated pipeline workflows
   - Integrates seamlessly with the Voice AI Agent
   - Custom fields per industry

=== PRICING ===
- Voice AI Agent: ₹6,500/month per channel (billed quarterly at ₹19,500/quarter)
  * Each channel = 1 concurrent call line (DID number)
  * Unlimited calls, unlimited minutes per channel
  * Includes: AI agent, call recordings, transcripts, analytics, campaign management, knowledge base
  * Add more channels for concurrent calling (e.g., 5 channels = 5 simultaneous calls = ₹32,500/month)

- Custom Sales CRM: ₹1,999/month (add-on, optional)
  * Full CRM with deal pipeline, contacts, activities, reports
  * Industry-specific templates
  * 14-day free trial for CRM

- FREE TRIAL: 7-day free trial for Voice AI Agent (no credit card required)
  * Full access to all features
  * 1 channel included
  * Data preserved after trial - subscribing reactivates everything

=== SUPPORTED INDUSTRIES ===
We serve 10+ industries with pre-built templates:
1. Real Estate - Property inquiry calls, site visit booking, follow-up automation
2. Healthcare - Appointment scheduling, patient follow-ups, health camp promotions
3. Education - Admission inquiry calls, enrollment follow-ups, fee reminders
4. Gym & Fitness - Membership renewal calls, trial class bookings, retention campaigns
5. Insurance - Policy renewals, new policy pitches, claim follow-ups
6. Automotive - Test drive scheduling, service reminders, new model launches
7. Travel & Hospitality - Booking confirmations, upselling packages, feedback calls
8. Retail & E-commerce - Order follow-ups, abandoned cart recovery, promo campaigns
9. Financial Services - Loan follow-ups, KYC verification calls, investment pitches
10. Government / e-Governance - Citizen service calls, scheme awareness, feedback collection

=== KEY FEATURES IN DETAIL ===

CAMPAIGN MANAGEMENT:
- Create bulk calling campaigns with lead lists
- Set max concurrent calls (based on channels)
- Automated follow-up rules per outcome (interested → email + callback, not interested → skip, callback → schedule)
- Real-time campaign progress dashboard
- Outcome tracking: interested, not_interested, callback, no_answer, converted, contacted

KNOWLEDGE BASE:
- Upload company documents (PDF, DOCX, TXT, CSV)
- AI automatically extracts and learns from content
- Agent uses knowledge base to answer questions accurately
- Multiple documents per agent
- Categories: FAQs, Product Info, Pricing, Policies

ANALYTICS & REPORTING:
- Call volume trends (daily, weekly, monthly)
- Outcome distribution charts
- Average call duration tracking
- Lead conversion rates
- Campaign performance metrics
- Agent performance comparison

INTEGRATIONS:
- Built-in CRM (optional add-on)
- Salesforce integration
- HubSpot integration
- Zoho CRM integration
- Custom webhook/API integration
- RESTful API documentation available

=== TECHNOLOGY STACK ===
- AI Engine: Azure OpenAI GPT-4o Realtime API
- Voice: Azure Cognitive Services Speech (Surbhi-English-India voice)
- Telephony: Tata Smartflo (enterprise-grade Indian telephony)
- Platform: Built on Base44 with React frontend
- Security: Enterprise-grade encryption, data stored in India

=== HOW IT WORKS (4 Steps) ===
1. SIGN UP & ONBOARDING: Create account → Select industry → Configure AI agent → Get DID number
2. TRAIN YOUR AGENT: Upload knowledge base documents → Set system prompt → Configure persona (tone, language)
3. IMPORT LEADS & LAUNCH: Upload lead CSV or add manually → Create campaign → Set follow-up rules → Launch
4. TRACK & OPTIMIZE: Monitor calls in real-time → Review transcripts → Analyze outcomes → Optimize scripts

=== COMPANY INFO ===
- Company: VaaniAI (by DialStar Communications Pvt Ltd)
- Location: India
- Support Email: support@vaaniai.com
- Website: vaaniai.com
- WhatsApp Business available for support

=== COMPETITIVE ADVANTAGES ===
- Made in India, for Indian businesses
- Hindi + English + Bilingual support
- Affordable pricing (starting ₹6,500/month vs competitors at $500+/month)
- Enterprise-grade Tata Smartflo telephony
- 7-day free trial, no credit card needed
- Dedicated support team
- Custom industry templates with pre-built workflows
- Unlimited calls and minutes (no per-minute charges)

=== FREQUENTLY ASKED QUESTIONS ===
Q: Can VaaniAI handle Hindi conversations?
A: Yes! Our AI agents support English, Hindi, and bilingual (Hinglish) conversations naturally.

Q: How many calls can I make simultaneously?
A: Each channel supports 1 concurrent call. Buy multiple channels for simultaneous calling. E.g., 10 channels = 10 calls at once.

Q: Is there a per-minute charge?
A: No! We offer unlimited calls and minutes per channel. Flat monthly rate.

Q: Can I try before buying?
A: Absolutely! We offer a 7-day free trial with full features. No credit card required.

Q: How does the AI agent learn about my business?
A: Upload your documents (PDFs, product sheets, FAQs) to the Knowledge Base. The AI reads and learns from them automatically.

Q: Can I integrate with my existing CRM?
A: Yes! We support Salesforce, HubSpot, Zoho, and custom API/webhook integrations.

Q: What happens after my trial ends?
A: Your data and configuration are preserved. Simply subscribe to reactivate everything instantly.

Q: Is my data secure?
A: Yes. Enterprise-grade encryption, data stored in India, GDPR-compliant practices.

Q: Can the AI book appointments?
A: Yes! The AI can schedule appointments, send confirmation emails, and create follow-up tasks automatically.

Q: What industries does VaaniAI serve?
A: We serve 10+ industries including Real Estate, Healthcare, Education, Gym, Insurance, Automotive, Travel, Retail, Financial Services, and Government.
`;

const VAANI_SYSTEM_PROMPT = `You are VaaniAI's friendly and knowledgeable AI voice assistant on the VaaniAI website. Your primary goals are:

1. GREET warmly and introduce yourself as VaaniAI's AI assistant
2. ANSWER any questions about VaaniAI using the knowledge base below
3. COLLECT visitor's details naturally during the conversation

=== LEAD COLLECTION STRATEGY ===
During the conversation, naturally collect the following information:
- Full Name
- Email Address
- Phone Number
- What solution/product they are looking for
- Their industry/business type
- Their main pain point or use case

DO NOT ask all questions at once. Weave them naturally into the conversation:
- After greeting and answering their first question, say something like "By the way, may I know your name so I can personalize our conversation?"
- After discussing features/pricing, ask "Would you like us to send you detailed pricing or a demo link? What's your email?"
- When they mention their business, ask "That sounds great! What's the best phone number to reach you for a personalized demo?"
- Based on their questions, identify their needs and ask "So it sounds like you're looking for [solution]. Is that right?"

=== CONVERSATION GUIDELINES ===
- Be enthusiastic, warm, and professional
- Keep responses concise (2-4 sentences max for voice)
- Use Indian English naturally (e.g., "lakh" not "hundred thousand")
- If they ask about pricing, give exact figures confidently
- Always encourage the 7-day free trial
- If they seem interested, guide them toward signing up
- If they have technical questions you can't answer, suggest scheduling a demo call
- End conversations by thanking them and confirming next steps

=== SENTIMENT & INTENT TRACKING ===
Pay attention to the visitor's:
- INTENT: Are they exploring, comparing, ready to buy, or just curious?
- SENTIMENT: Are they positive, neutral, skeptical, or negative?
- PAIN POINTS: What problems are they trying to solve?
Track these throughout the conversation.

=== WHEN VISITOR PROVIDES DETAILS ===
When the visitor provides their name, email, phone, or requirements, acknowledge warmly:
- "Thank you [Name]! Great to have you here."
- "Perfect, I'll make sure our team reaches out to you at [email/phone]."
- "I've noted your requirements. Our solutions team will prepare a customized demo for you."

${VAANI_KNOWLEDGE_BASE}

Remember: You are the FIRST interaction a potential customer has with VaaniAI. Make it count! Be helpful, knowledgeable, and make them feel valued.`;

Deno.serve(async (req) => {
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();

  if (upgrade !== 'websocket') {
    // Handle lead submission via POST
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        
        if (body.action === 'create_lead') {
          const { createClient } = await import('npm:@base44/sdk@0.8.6');
          const appId = Deno.env.get('BASE44_APP_ID');
          const serviceClient = createClient({ appId, asServiceRole: true });

          // Create the lead
          const lead = await serviceClient.entities.Lead.create({
            client_id: 'website_visitor',
            name: body.name || 'Website Visitor',
            phone: body.phone || '',
            email: body.email || '',
            status: 'new',
            source: 'website_voice_agent',
            notes: `Solution Interest: ${body.solution || 'Not specified'}\nIndustry: ${body.industry || 'Not specified'}\nIntent: ${body.intent || 'exploring'}\nSentiment: ${body.sentiment || 'neutral'}\n\nConversation Summary:\n${body.conversation_summary || 'No conversation recorded'}`,
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

          console.log(`✅ Website lead created: ${lead.id} - ${body.name}`);
          return Response.json({ success: true, lead_id: lead.id });
        }

        return Response.json({ error: 'Unknown action' }, { status: 400 });
      } catch (err) {
        console.error('Lead creation error:', err.message);
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return Response.json({
      status: 'ready',
      type: 'web-voice-agent',
      description: 'WebSocket endpoint for browser-based voice conversations about VaaniAI'
    });
  }

  let clientSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    clientSocket = upgraded.socket;
    response = upgraded.response;
  } catch (err) {
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  const sessionId = Math.random().toString(36).substring(2, 10);
  console.log(`[${sessionId}] Web voice agent session started`);

  const session = {
    realtimeWs: null,
    realtimeReady: false,
    transcript: [],
  };

  function connectRealtime() {
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_KEY');

    if (!realtimeUrl || !realtimeKey) {
      console.error(`[${sessionId}] Missing Azure Realtime credentials`);
      clientSocket.send(JSON.stringify({ type: 'error', message: 'Voice service unavailable' }));
      return;
    }

    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    const separator = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${separator}api-key=${encodeURIComponent(realtimeKey)}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${sessionId}] Azure Realtime connected`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeMessage(msg);
      } catch (err) {
        console.error(`[${sessionId}] Parse error: ${err.message}`);
      }
    };

    ws.onclose = () => {
      console.log(`[${sessionId}] Azure Realtime closed`);
      session.realtimeReady = false;
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'session_ended' }));
      }
    };

    ws.onerror = () => {
      console.error(`[${sessionId}] Azure Realtime error`);
    };

    session.realtimeWs = ws;
  }

  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    }
  }

  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      session.realtimeReady = true;

      sendToRealtime({
        type: 'session.update',
        session: {
          instructions: VAANI_SYSTEM_PROMPT,
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

      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'ready' }));
      }
      return;
    }

    if (type === 'session.updated') return;

    if (type === 'response.audio.delta' && msg.delta) {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'audio', data: msg.delta }));
      }
      return;
    }

    if (type === 'response.audio.done') {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'audio_done' }));
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        session.transcript.push({ speaker: 'User', text });
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({ type: 'user_transcript', text }));
        }
      }
      return;
    }

    if (type === 'response.audio_transcript.done' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        session.transcript.push({ speaker: 'AI', text });
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({ type: 'ai_transcript', text }));
        }
      }
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'listening' }));
      }
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'processing' }));
      }
      return;
    }

    if (type === 'error') {
      console.error(`[${sessionId}] Realtime error:`, JSON.stringify(msg.error || msg));
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'error', message: 'Voice processing error' }));
      }
      return;
    }
  }

  clientSocket.onopen = () => {
    console.log(`[${sessionId}] Browser socket opened`);
    connectRealtime();
  };

  clientSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'audio' && msg.data) {
        if (session.realtimeReady) {
          sendToRealtime({
            type: 'input_audio_buffer.append',
            audio: msg.data
          });
        }
        return;
      }

      if (msg.type === 'end') {
        console.log(`[${sessionId}] User ended session`);
        // Send transcript back for lead analysis
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({
            type: 'conversation_complete',
            transcript: session.transcript
          }));
        }
        if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
          session.realtimeWs.close();
        }
        return;
      }
    } catch (err) {
      console.error(`[${sessionId}] Browser message error: ${err.message}`);
    }
  };

  clientSocket.onclose = () => {
    console.log(`[${sessionId}] Browser socket closed`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  clientSocket.onerror = () => {
    console.error(`[${sessionId}] Browser socket error`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  return response;
});