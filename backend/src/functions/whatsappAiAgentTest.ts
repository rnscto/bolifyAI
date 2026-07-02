import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// whatsappAiAgentTest — Sandbox tester for the WhatsApp AI agent.
//
// Lets a client preview how their WhatsApp AI agent would reply, WITHOUT
// sending any real WhatsApp message and WITHOUT touching live sessions/leads.
// Mirrors whatsappAiAgent's prompt-building (persona + KB + media list +
// lead context + onboarding rule) so the preview is faithful.
//
// Uses Azure OpenAI DIRECTLY (own keys) — NOT Base44 integration credits.
//
// Payload: {
//   client_id,
//   message,                       // the customer's latest message
//   history: [{role, text}],       // prior turns in this test chat
//   simulate_known: boolean,       // true = pretend a known lead "Karan"
//   simulated_name?, simulated_email?
// }
// Returns: { reply } or { error }
// ═══════════════════════════════════════════════════════════════════════



async function azureChat(messages) {
  const baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');
  const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_completion_tokens: 500 })
  });
  if (!res.ok) throw new Error(`Azure OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

export default async function whatsappAiAgentTest(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload').catch(() => null);
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const svc = base44.asServiceRole;
    const body = await c.req.json();
    const { client_id, simulate_known = false } = body;
    if (!client_id || !body.message) {
      return c.json({ data: { error: 'client_id and message are required' } }, 400);
    }

    // Ownership check — the requester must own this client, be a linked team
    // member of it, or be an admin.
    if (user.role !== 'admin') {
      const owned = await svc.entities.Client.filter({ id: client_id, user_id: user.id }).catch(() => []);
      const isTeamMember = user.client_id === client_id;
      if (!owned.length && !isTeamMember) return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    // ── Input caps — prevent token/cost blow-up & latency DoS ──
    const message = String(body.message).slice(0, 2000);
    const simulated_name = body.simulated_name ? String(body.simulated_name).slice(0, 100) : undefined;
    const simulated_email = body.simulated_email ? String(body.simulated_email).slice(0, 200) : undefined;
    const history = (Array.isArray(body.history) ? body.history : [])
      .slice(-20)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text || '').slice(0, 2000) }));

    // ── Rate limit (per-user, 30 test calls/min) — Azure cost-DoS protection ──
    const LIMIT_PER_MIN = 30;
    try {
      const windowStart = new Date();
      windowStart.setSeconds(0, 0);
      const bucketKey = `user:${user.id}:wa_test:${windowStart.toISOString()}`;
      const existing = await svc.entities.RateBucket.filter({ bucket_key: bucketKey });
      const bucket = existing[0];
      if (bucket) {
        if ((bucket.count || 0) >= LIMIT_PER_MIN) {
          return c.json({ data: { error: 'Rate limit exceeded (30 test messages/min). Please wait a moment.' } }, 429);
        }
        await svc.entities.RateBucket.update(bucket.id, { count: (bucket.count || 0) + 1 });
      } else {
        await svc.entities.RateBucket.create({
          bucket_key: bucketKey, identity: user.id, endpoint: 'wa_test',
          window_start: windowStart.toISOString(), count: 1
        });
      }
    } catch (rlErr) {
      console.error('[whatsappAiAgentTest] rate-limit check failed (allowing):', rlErr.message);
    }

    const configs = await svc.entities.ClientMessagingConfig.filter({ client_id });
    const config = configs[0] || {};

    // Resolve the assigned WhatsApp agent (persona + KB) — same logic as live.
    const agents = await svc.entities.Agent.filter({ client_id });
    const agent = (config.whatsapp_agent_id && agents.find(a => a.id === config.whatsapp_agent_id))
      || agents.find(a => a.is_primary)
      || agents.find(a => a.status === 'active')
      || agents[0] || null;

    // KB snippet
    let kbText = '';
    if (agent?.knowledge_base_ids?.length) {
      const docs = await Promise.all(agent.knowledge_base_ids.slice(0, 5).map(id =>
        svc.entities.KnowledgeBase.get(id).catch(() => null)));
      kbText = docs.filter(d => d?.content).map(d => `[${d.title}]\n${d.content}`).join('\n\n---\n\n').slice(0, 6000);
    }

    // Media library (names only, for context)
    const mediaAssets = (await svc.entities.MediaAsset.filter({ client_id, is_active: true }).catch(() => [])) || [];
    const mediaList = mediaAssets.length
      ? mediaAssets.map(m => `- ${m.name} (intent: ${m.intent})`).join('\n')
      : '';

    // Lead context — simulate either a known lead or an unknown contact.
    const onboardingEnabled = config.whatsapp_ai_onboarding_enabled !== false;
    const simName = simulated_name || 'Karan';
    const leadContext = simulate_known
      ? `KNOWN CUSTOMER (already in CRM):
- Name: ${simName} (first name: ${simName.split(/\s+/)[0]})
- Email: ${simulated_email || 'not on file'}
Greet them BY THEIR FIRST NAME ("${simName.split(/\s+/)[0]}") right away. Never use placeholders like {{lead_name}} or "there".`
      : `UNKNOWN CONTACT (not yet in CRM — needs onboarding):
We only have their phone number. You do NOT know their name or email yet.`;

    const onboardingRule = simulate_known
      ? '- This customer is known — greet by first name and help directly.'
      : onboardingEnabled
        ? `- ONBOARDING: warmly greet, briefly introduce the business, then ask for their FIRST NAME, then their EMAIL — one at a time. Once you know their first name, greet them by it.`
        : `- Onboarding is OFF — just help them directly. Don't push for name/email.`;

    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

    const systemPrompt = `You are a helpful WhatsApp chat assistant for this business. (THIS IS A TEST PREVIEW — no real messages are sent and no tools run; just write the reply text you WOULD send.)
${agent?.system_prompt ? `\nBUSINESS PERSONA & INSTRUCTIONS:\n${agent.system_prompt.slice(0, 1500)}\n` : ''}
CONTACT CONTEXT:
${leadContext}

RULES:
- Reply in the SAME language the customer uses (English / Hindi / Hinglish). Keep replies short and WhatsApp-friendly.
${onboardingRule}
- Answer product/pricing/feature questions ONLY from the knowledge base below. If it's not there, say you'll have someone follow up — never invent facts.
- Be warm and concise. Current time: ${nowIST} IST.
${mediaList ? `\nAVAILABLE MEDIA (files you could send):\n${mediaList}` : ''}
${kbText ? `\nKNOWLEDGE BASE:\n${kbText}` : ''}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ role: m.role, content: m.text })),
      { role: 'user', content: message }
    ];

    const reply = await azureChat(messages);
    return c.json({ data: { reply: reply || 'Thanks for your message! How can I help you today?' } });
  } catch (error) {
    console.error('[whatsappAiAgentTest] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};