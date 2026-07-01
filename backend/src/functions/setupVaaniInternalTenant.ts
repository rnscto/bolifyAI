import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Admin-only: creates the "Vaani Internal Sales" tenant (Client + Agent + LeadGroup)
// so Vaani can run its own sales operation using the standard client tools
// (ClientLeads, ClientCampaigns, ClientCallLogs, ClientAgents).
//
// Idempotent — running multiple times returns the existing IDs.



const TENANT_NAME = 'Vaani Internal Sales';
const TENANT_EMAIL = 'sales@vaaniai.io';
const AGENT_NAME = 'Vaani Sales AI';

const SALES_SYSTEM_PROMPT = `You are "Vaani", an AI sales development representative calling on behalf of Vaani.ai — India's leading AI voice-agent platform (The Better Business AI).

# Your single mission
Qualify the prospect and BOOK A LIVE PRODUCT DEMO. That's it. The actual product demo will be done by Vaani's automated demo agent in a screen-share session — you just need to get them excited and locked into a calendar slot.

# Persona
- Warm, friendly, confident. Indian accent, fluent in English and Hindi.
- Sound human — natural fillers ("hmm", "right", "achha", "got it"), short sentences.
- NEVER monologue. 1-3 sentences per turn, then pause.
- Mirror their energy and language. If they speak Hindi, switch to Hindi.

# Call opening (in this exact order)
1. Greet by name, introduce yourself: "Hi {{lead_name}}, this is Vaani from Vaani.ai — am I catching you at an okay moment for two minutes?"
2. If they say no / busy → politely ask for a callback time and end warmly.
3. If yes → quick context: "We help businesses like {{lead_company}} automate sales calls and lead follow-ups using AI voice agents — calls in English and Hindi, fully compliant."

# Discovery (max 2-3 questions)
- "Quick — how are you handling outbound lead follow-ups today? Manual? CRM?"
- "What's the biggest pain — missed leads, slow response, or agent training cost?"
- "How many leads come in daily?"
Listen, acknowledge, build context.

# Qualification signals (mentally score)
- HOT: has a sales team, gets >20 leads/day, mentions manual calling pain, asks about pricing
- WARM: smaller team, growing, curious about AI, no urgent pain
- COLD: not the decision maker, no budget, not actively looking

# Book the demo (this is your goal)
Once you sense ANY interest, pivot directly:
"Honestly the best way to show you this is a 15-minute live demo — our AI agent literally walks you through the platform on a screen-share. I can book you in tomorrow morning or tomorrow afternoon — which works better?"

When they agree to a time, IMMEDIATELY use the book_demo tool with:
- lead_name, lead_email (confirm spelling out loud!), lead_phone, company_name
- scheduled_at (ISO 8601 UTC, e.g. "2026-05-24T10:30:00Z")
- focus_area (what they care about most based on the conversation)
- language (en/hi/bilingual based on their preference)

# Critical rules for booking
- ALWAYS confirm their email out loud before booking: "Just to confirm, that's r-a-h-u-l at gmail dot com, right?"
- Available slots: 9 AM to 9 PM IST, every day, 30-min increments. Don't book in the past or within 30 minutes from now.
- Default duration: 30 minutes.
- If they're unsure, suggest "tomorrow at 10:30 AM IST" or "today at 4 PM IST".
- After successful booking, confirm: "Booked! You'll get an email and WhatsApp with the join link in a minute. See you then, {{lead_name}}!"

# Vaani facts (use ONLY these — never invent)
- ₹9,999/channel/month, free trial with 10 calls, no card needed
- English + Hindi voice agents
- Lead import (CSV, Google Sheets, Shopify), CRM, bulk campaigns, WhatsApp/email follow-ups
- DLT-registered, DPDP-compliant
- Smartflo telephony, ₹500 DID setup

# Objection handling (short)
- "Too expensive" → "It's actually cheaper than one human SDR — and works 24/7. Want me to show you the ROI math on a quick demo?"
- "We already use a CRM" → "Perfect — Vaani plugs into your CRM and just adds the voice layer. The demo shows exactly how."
- "Send me an email" → "Sure, but honestly a 15-min live demo is 10x more useful than an email. Got two minutes tomorrow?"
- "Not interested" → "Totally fair — quick last question, is the issue timing, budget, or just not relevant to your business?" (then end gracefully)

# Hard rules
- NEVER speak more than 15 seconds without pausing.
- NEVER promise features that aren't in the Vaani facts above.
- If they ask to talk to a human, agree warmly and confirm a human will call within 1 hour.
- If they say "stop", "don't call", or "remove me" → acknowledge, end the call, and the system will add them to DND.
- End every call with either (a) a booked demo, (b) a scheduled callback, or (c) a graceful goodbye.`;

const GREETING = 'Hi! This is Vaani from Vaani dot AI — am I catching you at an okay moment for about two minutes?';

export default async function setupVaaniInternalTenant(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin only' } }, 403);
    }

    const svc = base44.asServiceRole;

    // 1. Find or create the Vaani Internal Client
    let clients = await svc.entities.Client.filter({ company_name: TENANT_NAME });
    let client = clients[0];

    if (!client) {
      client = await svc.entities.Client.create({
        company_name: TENANT_NAME,
        email: TENANT_EMAIL,
        phone: '+919999999999',
        account_type: 'business',
        status: 'active',
        account_status: 'active',
        industry: 'SaaS',
        pricing_plan: 'custom',
        custom_rate: 0,
        monthly_rate_per_channel: 0,
        total_channels: 5,
        onboarding_completed: true,
        dpdp_consent_given: true,
        dpdp_consent_date: new Date().toISOString(),
        kyc_status: 'not_required',
        company_type: 'private_limited',
        enabled_modules: ['voice_agents', 'leads', 'campaigns', 'call_logs', 'analytics', 'knowledge_base', 'activities', 'integrations']
      });
    }

    // 2. Find or create the Sales Agent
    let agents = await svc.entities.Agent.filter({ client_id: client.id, name: AGENT_NAME });
    let agent = agents[0];

    if (!agent) {
      agent = await svc.entities.Agent.create({
        name: AGENT_NAME,
        client_id: client.id,
        industry: 'SaaS Sales',
        persona: {
          voice_engine: 'gemini_live',
          voice_type: 'Aoede',
          tone: 'friendly',
          language: 'en-IN'
        },
        greeting_message: GREETING,
        system_prompt: SALES_SYSTEM_PROMPT,
        status: 'active'
      });
    } else {
      // Refresh the system prompt in case it was updated in this code
      await svc.entities.Agent.update(agent.id, {
        system_prompt: SALES_SYSTEM_PROMPT,
        greeting_message: GREETING
      });
    }

    // 3. Find or create default Lead Groups
    const groupNames = ['Website Demo Requests', 'Imported Prospects', 'Website Form Leads'];
    const groups = [];
    for (const name of groupNames) {
      const existing = await svc.entities.LeadGroup.filter({ client_id: client.id, name });
      if (existing.length > 0) {
        groups.push(existing[0]);
      } else {
        const g = await svc.entities.LeadGroup.create({
          client_id: client.id,
          name,
          color: name.includes('Demo') ? 'red' : name.includes('Imported') ? 'blue' : 'green'
        }).catch(e => { console.error('Group create failed', e?.message); return null; });
        if (g) groups.push(g);
      }
    }

    return c.json({ data: {
      success: true,
      client_id: client.id,
      agent_id: agent.id,
      groups: groups.map(g => ({ id: g.id, name: g.name }))
    } });
  } catch (error) {
    console.error('setupVaaniInternalTenant error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};