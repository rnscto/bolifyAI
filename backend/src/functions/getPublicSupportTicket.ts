import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Public read-only endpoint to view a support ticket via share token.
// No auth required — the token IS the auth. Returns sanitized data (no internal notes).



export default async function getPublicSupportTicket(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const url = new URL(req.url);
    let token = url.searchParams.get('token');
    if (!token && req.method === 'POST') {
      const body = await c.req.json().catch(() => ({}));
      token = body.token;
    }
    if (!token) return c.json({ data: { error: 'token required' } }, 400);

    const list = await svc.entities.SupportTicket.filter({ share_token: token });
    const ticket = list[0];
    if (!ticket || !ticket.share_enabled) return c.json({ data: { error: 'Not found or sharing disabled' } }, 404);

    const msgs = await svc.entities.SupportTicketMessage.filter({ ticket_id: ticket.id }, 'created_date', 200);
    const publicMessages = msgs
      .filter(m => !m.is_internal_note)
      .map(m => ({
        id: m.id,
        sender_type: m.sender_type,
        sender_name: m.sender_name,
        body_text: m.body_text,
        body_html: m.body_html,
        attachments: m.attachments || [],
        created_date: m.created_date
      }));

    return c.json({ data: {
      success: true,
      ticket: {
        ticket_number: ticket.ticket_number,
        subject: ticket.subject,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        requester_name: ticket.requester_name,
        requester_email: ticket.requester_email,
        created_date: ticket.created_date,
        resolved_at: ticket.resolved_at,
        closed_at: ticket.closed_at,
        last_message_at: ticket.last_message_at,
        tags: ticket.tags || []
      },
      messages: publicMessages
    } });
  } catch (e) {
    console.error('getPublicSupportTicket error:', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }

};