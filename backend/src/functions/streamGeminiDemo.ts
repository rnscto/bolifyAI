import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// WebSocket relay for Vaani's automated demo agent.
// Uses Gemini 3.1 Flash Live Preview with context-window compression + session
// resumption so 30-min audio+screen sessions don't die at the 2-minute hard limit.
//
// Client → relay protocol (JSON over WS):
//   { type:'start', token, mode:'voice'|'screen' }   first message
//   { type:'audio', audio:<base64 pcm16 16kHz mono> }
//   { type:'video', image:<base64 jpeg>, mime:'image/jpeg' }   screen-share frame, ≤1 FPS
//   { type:'mode', mode:'voice'|'screen' }   toggle screen-share on/off mid-call
//   { type:'text', text }   optional text turn (e.g. "switch to Hindi")
//
// Relay → client:
//   { type:'ready' }                       Gemini setup complete
//   { type:'audio', audio:<base64 pcm24> } 24kHz mono audio chunk to play
//   { type:'transcript_user', text }
//   { type:'transcript_ai', text }
//   { type:'turn_complete' }
//   { type:'interrupted' }
//   { type:'goaway', seconds }             upstream warned of disconnect
//   { type:'resumed' }                     successfully resumed after a drop
//   { type:'error', message }
//   { type:'ended', reason }

const MODEL = 'models/gemini-3.1-flash-live-preview';

function buildSetup({ systemPrompt, voiceName, resumeHandle }) {
  const setup = {
    model: MODEL,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } }
      }
    },
    systemInstruction: { parts: [{ text: systemPrompt }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Extend session past the 2-min audio+video hard limit
    contextWindowCompression: { slidingWindow: {} },
    // Allow seamless reconnect on the ~10-min connection drop
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {}
  };
  return { setup };
}

// Default config used when DemoAgentConfig is empty/inactive
const DEFAULT_CONFIG = {
  agent_name: 'Vaani',
  voice_name: 'Aoede',
  default_language: 'bilingual',
  persona_description: `You are a warm, confident, consultative product expert from Vaani.ai (The Better Business AI). You sound human — never robotic. You have deep understanding of Indian SMB challenges (missed leads, manual follow-ups, agent training costs, multi-language customers). You speak with the personal touch of a friendly sales engineer who genuinely wants to help, not push.`,
  tone_guidelines: `- Warm, friendly, Indian accent. Use the prospect's first name occasionally.
- Conversational, not scripted. Use natural fillers ("hmm", "right", "got it", "achha").
- Mirror the prospect's energy — formal with formal, casual with casual.
- Show empathy when they describe pain points ("Yeah, that's a really common issue — I hear this from gym owners every week").
- Use micro-stories ("Last week a real-estate client of ours saved 6 hours/day by automating just the first call"). Keep them brief.
- NEVER monologue. Pause every 1-3 sentences for their reaction.`,
  demo_flow: `IMPORTANT: YOU NEVER SHARE YOUR SCREEN. YOU NEVER OFFER TO SHARE YOUR SCREEN. THE LEAD shares THEIR screen and YOU guide them step-by-step by looking at what they have on screen. Adapt naturally based on their interest:

1. **Warm greeting (15 sec)** — Greet by first name, confirm you're Vaani from Vaani.ai, acknowledge what they want to see. Example: "Hi Rahul! I'm Vaani — really glad we could connect today. I see you wanted to explore voice agents for your real-estate team — perfect, that's one of our strongest use cases."

2. **Discovery (2-3 min, VOICE ONLY — no screen yet)** — Ask 2-3 short questions:
   - "Quickly, how are you handling lead follow-ups today? Manual calls? A CRM?"
   - "What's your biggest pain — missed leads, slow response time, or training cost?"
   - "How many leads come in daily?"
   Listen, acknowledge, build context.

3. **Ask THE LEAD to share THEIR screen** — Say exactly: "Great, to make this hands-on — could you please click the green 'Share Screen' button at the bottom of your demo room? Share your entire screen or just a browser tab with vaaniai.com open. I'll see what you see and walk you through it step by step." Do NOT proceed until you receive [LEAD_SHARED_SCREEN]. If they hesitate, reassure: "Don't worry, I only see what you choose to share and nothing is recorded without your consent."

4. **Step-by-step guided walkthrough (after [LEAD_SHARED_SCREEN] is received)** — You can now SEE the lead's screen via video frames. React to what's actually visible. Use phrases like "I can see you're on the home page now", "perfect, click the orange Get Started button at the top right", "good — now I see the onboarding screen". Be a real-time guide, not a presenter. Pause after every instruction and wait for them to do it. Order:
   a. **Signup & Login** — "First, on vaaniai.com click 'Get Started' → enter your business email → magic link login, no password."
   b. **Onboarding wizard** — "After login you land in onboarding. Step 1 is profile (company name, GSTIN), step 2 is industry — we have plug-and-play templates for real-estate, gym, EdTech, healthcare, finance..."
   c. **Agreement signing** — "Step 3 is the service agreement — DPDP & DLT compliant, e-sign right in the browser. Takes 30 seconds."
   d. **Agent Setup** — "Now the fun part — your AI agent. Name it, pick a voice (we have Hindi + English voices), set the greeting, paste your sales script or just pick our industry template — it auto-generates the system prompt for you."
   e. **DID Selection** — "Then you pick a phone number — we provision Indian DIDs via Smartflo. ₹500 setup, included in your channel."
   f. **Knowledge Base** — "Upload your brochures, FAQs, price lists as PDF/DOCX/text — the agent learns from them instantly. No fine-tuning needed."
   g. **Leads Import** — "Go to Leads → Import CSV, or sync from Google Sheets / Shopify / your existing CRM. Lead groups let you segment (hot, cold, paid, free trial)."
   h. **Sample call from lead page** — "Click any lead → 'Call now' — your AI agent calls them in 5 seconds, conversation gets transcribed live, summary + outcome auto-detected at the end."
   i. **Campaigns** — "For bulk — create a campaign, pick a lead group, set max concurrent calls (5/10/20), schedule it, hit start. Real-time dashboard shows progress."
   j. **CRM** — "Every call updates the lead — status, score, next action. Built-in Kanban deal board. Optional CRM add-on adds contacts, deals, sales reports."
   k. **WhatsApp + Email campaigns** — "Post-call follow-ups go out automatically — AI-personalized emails and WhatsApp templates. You can also send bulk campaigns from lead groups."
   l. **Analytics & Call logs** — "Every call recorded, transcribed, scored. Dashboard shows conversion rate, average duration, outcome breakdown."
   m. **Add-on marketplace** — "Need call transfer to human? Google Sheets sync? Social media auto-posting? It's all in the marketplace — activate with one click, monthly billing."

5. **Q&A and ROI (5 min)** — Pricing: ₹9,999/channel/month base, free trial with 10 calls. Custom rates for high volume. DLT-registered, DPDP-compliant. Mention savings vs human agent (₹25k-40k/month per agent in India).

6. **Close** — Confirm next steps. Options:
   - Free trial signup (immediate)
   - Follow-up call with a human sales rep within 1 business hour
   - Custom proposal (for 5+ channels)
   If user says "talk to a human", acknowledge warmly and confirm a Vaani team member will reach out within 1 business hour.`,
  platform_knowledge: `# COMPLETE VAANI PLATFORM KNOWLEDGE

## Login & Signup
- URL: vaaniai.com → "Get Started" button
- Magic link auth (no passwords) — enter email, click link in inbox
- Two account types: Business (₹9,999/channel/mo) and Personal AI (₹1,999/mo for personal call screening)

## Onboarding (4 steps)
1. Account type (Business / Personal)
2. Profile — company name, GSTIN, address, owner contact
3. Industry — pick from templates (real-estate, gym, healthcare, EdTech, finance, hospitality, e-commerce, other) → agent prompt auto-generated
4. Compliance consent (DPDP) + service agreement e-sign
5. DID selection — pick 1+ Indian phone number(s) via Smartflo
6. Agent ready → 10 free trial calls

## Agent Setup
- Voice engines: Realtime (Azure GPT-4o), Azure Speech, Gemini Live
- Voices: 10+ Indian English & Hindi voices (male/female)
- Bilingual mode — auto-detects user language mid-call
- System prompt: industry template OR AI-generated from a 3-line description OR fully custom
- Greeting message — first thing the AI says
- Knowledge base — upload PDF, DOCX, TXT, CSV; auto-extracted and indexed
- Human transfer — set extension number, AI hands off when user says "talk to a human"
- Multiple DIDs per agent for concurrent calling

## DIDs (Phone Numbers)
- Indian numbers via Smartflo
- ₹500 setup, included in monthly plan
- Multiple DIDs per agent for parallel calls
- Incoming + outgoing on the same number

## Leads & Lead Groups
- Import: CSV, XLSX, Google Sheets sync, Shopify orders, WooCommerce, UniCommerce
- Lead groups: tag leads (hot/cold/paid/trial/etc) — color-coded
- Lead score: AI auto-scores 1-10 based on interaction history
- Bulk actions: assign group, export, delete, run campaign
- Single-lead actions: call now, send WhatsApp, send email, schedule callback

## Sample Call from Lead Page
- Open any lead → click "Call Now" button
- AI agent calls in 3-5 seconds
- Live transcript appears in browser
- After call: AI summary, outcome (interested/not interested/callback/converted), next action all auto-set
- Recording saved, transcript searchable

## Campaigns
- Cold call campaigns OR follow-up campaigns
- Pick agent, pick lead group, set max concurrent calls (1-20)
- Schedule for later or run now
- Auto-pause on quota exceed
- Live dashboard: progress %, outcomes, conversion rate
- AI-driven follow-up rules: send email if interested, retry if no-answer, schedule callback, etc.

## CRM (built-in, free with Business plan)
- Lead lifecycle: New → Contacted → Qualified → Negotiation → Converted/Lost
- Activities: tasks, notes, calls, meetings
- Deal pipeline (Kanban) — drag-drop between stages
- Reports: conversion, agent productivity, deal velocity
- Optional CRM+ add-on (₹1,999/mo) adds contacts module, advanced analytics

## WhatsApp & Email Campaigns
- WhatsApp via Meta Cloud, Gupshup, AiSensy, Wati, Interakt (any provider)
- Email via SMTP, Resend, SendGrid, Azure Communication Services
- Templates with variables ({{name}}, {{company}}, {{offer}})
- Bulk campaigns with throttling, unsubscribe handling, delivery tracking
- Post-call automated follow-ups (AI-personalized using call transcript)

## Analytics
- Call logs with recording + transcript
- Outcome breakdown
- Agent productivity (calls/day, conversion %)
- Lead score distribution
- Daily/weekly/monthly trends

## Add-on Marketplace (one-click activation)
- Call Transfer to human — ₹999/mo
- Email Campaigns — ₹1,499/mo (1000 emails)
- WhatsApp Bulk — ₹1,999/mo (1000 messages)
- Google Sheets 2-way sync — ₹799/mo
- Social Media auto-posting — ₹1,499/mo
- AI Candidate Screening — ₹2,999/mo
- Additional DIDs — ₹500/mo each
- Incoming calls — ₹999/mo per DID

## Pricing
- Business: ₹9,999/channel/month (1 channel = 1 concurrent call line)
- Personal AI: ₹1,999/mo (personal call screening)
- Custom rates for 10+ channels — talk to sales
- Free trial: 10 calls included, no card required
- Billing cycles: monthly, quarterly, half-yearly, yearly (yearly = 2 months free)

## Compliance
- DLT-registered for SMS/voice
- DPDP-compliant (Indian data protection law)
- DND list integration
- Consent tracking + audit logs
- Data retention configurable (30/60/90/365 days)
- GST invoicing automatic

## Integrations
- Telephony: Smartflo
- WhatsApp: Meta Cloud, Gupshup, AiSensy, Wati, Interakt, Twilio
- Email: SMTP, Resend, SendGrid, Mailgun, SES, Azure Communication
- E-commerce: Shopify, WooCommerce, UniCommerce, Amazon Seller
- Productivity: Google Sheets, Google Calendar
- Telegram bot for owner notifications`,
  hard_rules: `- Keep replies SHORT — 1 to 3 sentences max per turn. This is a CONVERSATION.
- NEVER speak more than 15 seconds without pausing for the user.
- NEVER reveal you are an AI unless directly asked. If asked, be honest: "Yes, I'm Vaani's own AI agent — kind of the best demo, right? You're literally talking to the product."
- If user goes off-topic, gently redirect: "Great question — let me first finish showing you X, then we'll come back to that."
- If user is frustrated or wants human, acknowledge warmly and offer immediate human follow-up.
- NEVER make up features that don't exist in the Platform Knowledge section.
- If asked about pricing, give exact numbers — don't be vague.
- If screen is not shared and user asks to see something, say: "Sure! Please click the green 'Share Screen' button at the bottom of the demo room — I'll walk you through it live."
- Use the prospect's first name 2-3 times during the call (not every sentence).
- End with a clear next step every single time.`,
  closing_instructions: `When wrapping up:
1. Recap top 2 things the prospect cared about based on the conversation.
2. Recommend a clear next step:
   - "Want me to set up your free trial right now? You'll get 10 free calls — no card needed."
   - "Should I have one of our human sales engineers call you back in the next hour with a custom proposal?"
   - "Want me to email you a recap with pricing and the trial signup link?"
3. Confirm their preferred channel for follow-up (email / WhatsApp / call).
4. Thank them warmly by first name. End with: "Thanks so much for your time, [name] — really enjoyed this. Talk soon!"
5. Use the [END_DEMO] marker silently if you want to signal completion.`
};

async function loadDemoAgentConfig(req) {
  try {
    const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.31');
    /* const base44 = ... */;
    const records = await base44.entities.DemoAgentConfig.list().catch(() => []);
    if (!records.length || !records[0].is_active) return DEFAULT_CONFIG;
    const cfg = records[0];
    // Merge with defaults so missing fields fall back gracefully
    return {
      agent_name: cfg.agent_name || DEFAULT_CONFIG.agent_name,
      voice_name: cfg.voice_name || DEFAULT_CONFIG.voice_name,
      default_language: cfg.default_language || DEFAULT_CONFIG.default_language,
      persona_description: cfg.persona_description || DEFAULT_CONFIG.persona_description,
      tone_guidelines: cfg.tone_guidelines || DEFAULT_CONFIG.tone_guidelines,
      demo_flow: cfg.demo_flow || DEFAULT_CONFIG.demo_flow,
      platform_knowledge: cfg.platform_knowledge || DEFAULT_CONFIG.platform_knowledge,
      hard_rules: cfg.hard_rules || DEFAULT_CONFIG.hard_rules,
      closing_instructions: cfg.closing_instructions || DEFAULT_CONFIG.closing_instructions
    };
  } catch (e) {
    console.error('[demo] config load error', e);
    return DEFAULT_CONFIG;
  }
}

function buildSystemPrompt(booking, config) {
  const lang = booking.language || config.default_language || 'bilingual';
  const langInstr = lang === 'hi'
    ? 'Speak ONLY in natural conversational Hindi.'
    : lang === 'en'
      ? 'Speak ONLY in clear, friendly English with an Indian accent.'
      : 'Detect whether the user speaks in English or Hindi and respond in the SAME language. Mix Hindi/English naturally when the user does (Hinglish is fine).';

  return `You are "${config.agent_name}" — the AI demo host for Vaani.ai (The Better Business AI), an Indian AI voice-agent platform.

# 🚨 ABSOLUTE TOP RULE (overrides everything else)
You have NO screen. You CANNOT share your screen. NEVER say "I'll share my screen", "let me share", "I'm sharing", or anything similar — those phrases are BANNED. The LEAD shares THEIR screen via the green "Share Screen" button in their demo room. After they share, you watch their browser and guide them step-by-step to open vaaniai.com and click around. Until they share, you do NOT walk through any feature visually — you only describe verbally and keep asking them to share. If they ask to see something, your only response is: "Sure — please click the green Share Screen button at the bottom of your demo room and open vaaniai.com. I will guide you the moment you share."

# Persona
${config.persona_description}

# Caller context
- Name: ${booking.lead_name || 'the guest'}
- Company: ${booking.company_name || 'their company'}
- Industry: ${booking.industry || 'unspecified'}
- Team size: ${booking.team_size || 'unspecified'}
- They want to see: ${booking.focus_area || 'general Vaani capabilities'}

# Language
${langInstr}

# Tone & conversational style
${config.tone_guidelines}

# Demo flow
${config.demo_flow}

# Platform knowledge (use ONLY these facts when explaining features)
${config.platform_knowledge}

# Hard rules
${config.hard_rules}

# Closing
${config.closing_instructions}`;
}

// Helper: browser WebSocket connections cannot set custom headers, so the
// 'Base44-App-Id' header that createClientFromRequest() requires is missing.
// We synthesize a new Request that carries the app id from env so the SDK
// can still authenticate the function-to-platform calls inside this handler.
function makeSdkRequest(origReq) {
  const appId = Deno.env.get('BASE44_APP_ID') || '';
  const headers = new Headers(origReq.headers);
  if (appId && !headers.get('Base44-App-Id')) headers.set('Base44-App-Id', appId);
  return new Request(origReq.url, { method: 'POST', headers });
}

export default async function streamGeminiDemo(c: any) {
  const req = c.req.raw || c.req;
  const upgrade = req.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() !== 'websocket') {
    // Self-report the wss:// URL so callers (e.g. getDemoBooking) can discover it.
    const url = new URL(req.url);
    const wsUrl = `wss://${url.host}${url.pathname}`;
    return c.json({ data: { status: 'ready', function: 'streamGeminiDemo', model: MODEL, ws_url: wsUrl } });
  }

  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
  let geminiWs = null;
  let booking = null;
  let bookingId = null;
  let agentConfig = null;
  let configured = false;
  let resumeHandle = null;
  let endingFlag = false;
  let currentMode = 'voice'; // tracks last screen-share state to dedupe repeated mode events
  const transcriptBuf = { user: '', ai: '' };

  const sendClient = (obj) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(obj));
  };

  const closeGemini = () => {
    if (geminiWs && geminiWs.readyState <= 1) geminiWs.close();
    geminiWs = null;
    configured = false;
  };

  // Auto-fallback state: FREE key first, switch to PAID on 429/quota close
  let _usingPaidKey = false;
  let _triedKeyFallback = false;
  function isQuotaClose(e) {
    if (!e) return false;
    if (e.code === 1011 || e.code === 1008) return true;
    const r = (e.reason || '').toLowerCase();
    return r.includes('quota') || r.includes('resource_exhausted') || r.includes('429') || r.includes('rate limit');
  }

  async function connectGemini({ systemPrompt, voiceName }) {
    const freeKey = Deno.env.get('GEMINI_API_KEY');
    const paidKey = Deno.env.get('GEMINI_API_KEY_PAID');
    if (!freeKey && !paidKey) { sendClient({ type: 'error', message: 'GEMINI_API_KEY not set' }); return; }
    if (!freeKey) _usingPaidKey = true;
    const key = _usingPaidKey ? paidKey : freeKey;
    console.log(`[demo] Connecting Gemini with ${_usingPaidKey ? 'PAID' : 'FREE'} key`);
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
    geminiWs = new WebSocket(url);

    geminiWs.onopen = () => {
      geminiWs.send(JSON.stringify(buildSetup({ systemPrompt, voiceName, resumeHandle })));
    };

    geminiWs.onmessage = async (ev) => {
      try {
        const text = typeof ev.data === 'string' ? ev.data
          : ev.data instanceof Blob ? await ev.data.text()
          : new TextDecoder().decode(ev.data);
        const m = JSON.parse(text);

        if (m.setupComplete) {
          configured = true;
          if (resumeHandle) sendClient({ type: 'resumed' });
          else sendClient({ type: 'ready' });
          return;
        }

        if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate?.newHandle) {
          resumeHandle = m.sessionResumptionUpdate.newHandle;
          return;
        }

        if (m.goAway) {
          sendClient({ type: 'goaway', seconds: m.goAway.timeLeft?.seconds || 10 });
          // Pre-emptively reconnect on the next message — Gemini will close anyway
          return;
        }

        if (m.serverContent) {
          const sc = m.serverContent;

          // Multi-part content in 3.1 — iterate ALL parts
          if (sc.modelTurn?.parts) {
            for (const p of sc.modelTurn.parts) {
              if (p.inlineData?.data) sendClient({ type: 'audio', audio: p.inlineData.data });
              if (p.text) sendClient({ type: 'transcript_ai', text: p.text });
            }
          }

          if (sc.outputTranscription?.text) {
            transcriptBuf.ai += sc.outputTranscription.text;
            sendClient({ type: 'transcript_ai', text: sc.outputTranscription.text });
          }
          if (sc.inputTranscription?.text) {
            transcriptBuf.user += sc.inputTranscription.text;
            sendClient({ type: 'transcript_user', text: sc.inputTranscription.text });
          }

          if (sc.interrupted) sendClient({ type: 'interrupted' });
          if (sc.turnComplete) sendClient({ type: 'turn_complete' });
        }
      } catch (e) {
        console.error('[demo] gemini parse error', e);
      }
    };

    geminiWs.onclose = async (e) => {
      console.log(`[demo] gemini closed code=${e.code} reason=${e.reason}`);
      if (endingFlag) return;
      // Auto-fallback to PAID key on FREE key quota exhaustion
      if (!_usingPaidKey && !_triedKeyFallback && Deno.env.get('GEMINI_API_KEY_PAID') && isQuotaClose(e) && booking && agentConfig) {
        _triedKeyFallback = true;
        _usingPaidKey = true;
        console.log('[demo] FREE key hit quota → retrying with PAID key');
        const sys = buildSystemPrompt(booking, agentConfig);
        connectGemini({ systemPrompt: sys, voiceName: agentConfig.voice_name });
        return;
      }
      // If we have a resume handle and client is still open → reconnect
      if (resumeHandle && clientWs.readyState === WebSocket.OPEN && booking && agentConfig) {
        const sys = buildSystemPrompt(booking, agentConfig);
        connectGemini({ systemPrompt: sys, voiceName: agentConfig.voice_name });
      } else {
        sendClient({ type: 'error', message: `Gemini closed: ${e.reason || e.code}` });
        // Alert sales team on terminal Gemini failure during an active demo
        if (bookingId && !endingFlag) {
          try {
            const { createClientFromRequest: ccfr } = await import('npm:@base44/sdk@0.8.31');
            const b44 = ccfr(makeSdkRequest(req));
            b44.entities.DemoBooking.update(bookingId, {
              ai_failure_count: (booking?.ai_failure_count || 0) + 1
            }).catch(() => {});
            b44.functions.invoke('notifyDemoAlert', {
              severity: 'critical',
              title: 'Demo AI FAILED mid-session',
              message: `Lead: ${booking?.lead_name || booking?.lead_email}\nReason: ${e.reason || e.code}\nUsing ${_usingPaidKey ? 'PAID' : 'FREE'} key`,
              booking_id: bookingId
            }).catch(() => {});
          } catch (_) {}
        }
      }
    };

    geminiWs.onerror = () => {
      console.error('[demo] gemini upstream error');
      sendClient({ type: 'error', message: 'Gemini upstream error' });
    };
  }

  clientWs.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'start') {
      try {
        const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.31');
        /* const base44 = ... */;
        const svc = base44;
        const matches = await svc.entities.DemoBooking.filter({ room_token: msg.token });
        if (!matches.length) { sendClient({ type: 'error', message: 'Invalid token' }); clientWs.close(); return; }
        booking = matches[0];
        bookingId = booking.id;

        // Hard expiry / status gate
        if (booking.expires_at && new Date(booking.expires_at).getTime() < Date.now()) {
          sendClient({ type: 'error', message: 'This demo link has expired.' });
          clientWs.close(); return;
        }
        if (['cancelled', 'expired', 'completed'].includes(booking.status)) {
          sendClient({ type: 'error', message: `Demo is ${booking.status}.` });
          clientWs.close(); return;
        }

        // Concurrent-session cap (fail open if cap check fails)
        try {
          const capRes = await svc.functions.invoke('checkDemoSessionCap', {});
          if (capRes?.data && capRes.data.allowed === false) {
            sendClient({ type: 'error', message: `Too many concurrent demos right now (${capRes.data.current}/${capRes.data.max}). Please retry in a minute.` });
            svc.functions.invoke('notifyDemoAlert', {
              severity: 'warning',
              title: 'Demo concurrent-session cap HIT',
              message: `Booking ${booking.booking_code} blocked. Current: ${capRes.data.current}/${capRes.data.max}`,
              booking_id: bookingId
            }).catch(() => {});
            clientWs.close(); return;
          }
        } catch (_) { /* fail open */ }

        // Mark started
        if (booking.status === 'scheduled') {
          await svc.entities.DemoBooking.update(bookingId, {
            status: 'in_progress', started_at: new Date().toISOString()
          });
        }
      } catch (e) {
        sendClient({ type: 'error', message: 'Could not load booking: ' + e.message });
        return;
      }

      agentConfig = await loadDemoAgentConfig(req);
      const systemPrompt = buildSystemPrompt(booking, agentConfig);
      connectGemini({ systemPrompt, voiceName: agentConfig.voice_name });
      return;
    }

    if (!geminiWs || !configured) return;

    if (msg.type === 'audio' && msg.audio) {
      geminiWs.send(JSON.stringify({
        realtimeInput: { audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' } }
      }));
      return;
    }

    if (msg.type === 'video' && msg.image) {
      geminiWs.send(JSON.stringify({
        realtimeInput: { video: { data: msg.image, mimeType: msg.mime || 'image/jpeg' } }
      }));
      return;
    }

    if (msg.type === 'mode') {
      // Dedupe: ignore mode messages that match the current state (prevents double-greeting)
      if (msg.mode === currentMode) return;
      currentMode = msg.mode;
      const note = msg.mode === 'screen'
        ? '[LEAD_SHARED_SCREEN] The lead just shared their screen. In ONE short sentence acknowledge ("Perfect, I can see your screen now") and then ask them to open vaaniai.com. Do NOT restart the conversation or repeat your introduction. Pause and wait for them.'
        : '[LEAD_STOPPED_SCREEN] The lead stopped sharing. Briefly note this and continue by voice. Do NOT repeat the greeting.';
      geminiWs.send(JSON.stringify({
        realtimeInput: { text: note }
      }));
      return;
    }

    if (msg.type === 'ai_mute') {
      // Human agent took over — pause AI by ending its current turn and instructing silence
      geminiWs.send(JSON.stringify({
        realtimeInput: { text: '[HUMAN_AGENT_TAKEOVER] A human Vaani team member has joined and is taking over. Stop speaking immediately. Do not respond to any audio until you receive [AI_RESUME].' }
      }));
      return;
    }

    if (msg.type === 'ai_resume') {
      geminiWs.send(JSON.stringify({
        realtimeInput: { text: '[AI_RESUME] The human handed control back to you. Briefly acknowledge ("Thanks, I am back!") and continue the demo from where it left off.' }
      }));
      return;
    }

    if (msg.type === 'text' && msg.text) {
      geminiWs.send(JSON.stringify({
        realtimeInput: { text: msg.text }
      }));
      return;
    }

    if (msg.type === 'end') {
      endingFlag = true;
      try {
        const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.31');
        /* const base44 = ... */;
        if (bookingId) {
          const ended = new Date();
          const started = booking?.started_at ? new Date(booking.started_at) : ended;
          await base44.entities.DemoBooking.update(bookingId, {
            status: 'completed',
            ended_at: ended.toISOString(),
            duration_seconds: Math.floor((ended - started) / 1000),
            transcript: (transcriptBuf.user ? `USER: ${transcriptBuf.user}\n\n` : '') + (transcriptBuf.ai ? `AI: ${transcriptBuf.ai}` : '')
          });
        }
      } catch (e) { console.error('[demo] end save error', e); }
      sendClient({ type: 'ended', reason: msg.reason || 'user' });
      closeGemini();
      clientWs.close();
    }
  };

  clientWs.onclose = async () => {
    closeGemini();
    // Best-effort save partial transcript if call ended without explicit 'end'
    if (bookingId && !endingFlag) {
      try {
        const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.31');
        /* const base44 = ... */;
        await base44.entities.DemoBooking.update(bookingId, {
          ended_at: new Date().toISOString(),
          transcript: (transcriptBuf.user ? `USER: ${transcriptBuf.user}\n\n` : '') + (transcriptBuf.ai ? `AI: ${transcriptBuf.ai}` : '')
        });
      } catch (_) { /* ignore */ }
    }
  };

  return response;

};