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
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id' }
    });
  }

  try {
    const body = await req.json();
    const action = body.action;

    // Chat action - talk to AI
    if (action === 'chat') {
      const messages = body.messages || [];
      const conversationHistory = messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text
      }));

      const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
      const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
      const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

      const chatMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversationHistory
      ];

      const response = await fetch(
        `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`,
        {
          method: 'POST',
          headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: chatMessages,
            max_completion_tokens: 300,
            temperature: 0.7
          })
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error('Azure OpenAI error:', errText);
        return Response.json({ error: 'AI service error' }, { status: 500 });
      }

      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || "I'm sorry, could you repeat that?";
      return Response.json({ reply });
    }

    // Create lead action
    if (action === 'create_lead') {
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
      console.log(`Lead created: ${lead.id} - ${body.name}`);
      return Response.json({ success: true, lead_id: lead.id });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    console.error('Error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
});