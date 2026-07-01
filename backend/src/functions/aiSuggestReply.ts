import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Generate an AI-suggested reply for a support ticket thread.
// Returns plain text the agent can paste / edit in the reply box.



export default async function aiSuggestReply(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    // Allow only support team / admin
    if (user.role !== 'admin') {
      const tm = await svc.entities.SupportTeamMember.filter({ user_email: user.email, is_active: true });
      if (!tm.length) return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    const { ticket_id, tone = 'friendly' } = await c.req.json();
    if (!ticket_id) return c.json({ data: { error: 'ticket_id required' } }, 400);

    const [ticket, msgs] = await Promise.all([
      svc.entities.SupportTicket.get(ticket_id),
      svc.entities.SupportTicketMessage.filter({ ticket_id }, 'created_date', 50)
    ]);
    if (!ticket) return c.json({ data: { error: 'Ticket not found' } }, 404);

    const thread = msgs
      .filter(m => !m.is_internal_note)
      .map(m => `[${m.sender_type === 'customer' ? 'CUSTOMER' : 'AGENT'} - ${m.sender_name || ''}]\n${m.body_text || ''}`)
      .join('\n\n---\n\n')
      .slice(0, 8000);

    const prompt = `You are a senior customer-support agent at Vaani AI (a voice-AI / CRM SaaS platform for Indian SMBs).
Draft a single reply to the LATEST customer message in this support thread. Be specific to what the customer asked.

GUIDELINES:
- Tone: ${tone}. Always polite, clear, never use slang.
- Address the customer by their first name if known: "${ticket.requester_name || ''}".
- If the issue is resolvable, give concrete next steps (numbered if multi-step).
- If you need more information, ask only the most important question.
- Sign off with the agent's name: "${user.full_name || 'Vaani Support'}".
- DO NOT include subject line, greeting block, or HTML — plain text only.
- Keep it under 150 words unless a technical answer requires more.

TICKET:
Subject: ${ticket.subject}
Category: ${ticket.category}
Priority: ${ticket.priority}

THREAD:
${thread}

Now write the reply:`;

    const res = await svc.functions.invoke('invokeAzureLLM', { prompt });

    const suggestion = res?.data?.result || res?.data?.text || res?.data?.content || '';
    if (!suggestion) return c.json({ data: { error: 'No suggestion generated' } }, 500);

    return c.json({ data: { success: true, suggestion: String(suggestion).trim() } });
  } catch (e) {
    console.error('aiSuggestReply error:', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }

};