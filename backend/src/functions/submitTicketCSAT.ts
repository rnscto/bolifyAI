import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Public CSAT capture — accepts { ticket_id, rating (1-5), comment? }.
// No auth: the link is sent to the requester's email; rating is single-shot
// (we only allow setting it if it's not already set).



export default async function submitTicketCSAT(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const { ticket_id, rating, comment = '' } = await c.req.json();
    if (!ticket_id || !rating) {
      return c.json({ data: { error: 'ticket_id and rating required' } }, 400);
    }
    const r = Number(rating);
    if (!Number.isFinite(r) || r < 1 || r > 5) {
      return c.json({ data: { error: 'rating must be 1-5' } }, 400);
    }

    const ticket = await svc.entities.SupportTicket.get(ticket_id);
    if (!ticket) return c.json({ data: { error: 'Ticket not found' } }, 404);

    if (ticket.satisfaction_rating) {
      return c.json({ data: { success: true, already_rated: true, rating: ticket.satisfaction_rating } });
    }

    await svc.entities.SupportTicket.update(ticket_id, {
      satisfaction_rating: r,
      satisfaction_comment: (comment || '').substring(0, 1000),
      satisfaction_rated_at: new Date().toISOString()
    });

    // Internal note on the thread so the team sees the feedback
    svc.entities.SupportTicketMessage.create({
      ticket_id,
      client_id: ticket.client_id || '',
      sender_type: 'system',
      sender_email: 'system@vaaniai.in',
      sender_name: 'CSAT',
      body_text: `Customer rated this ticket ${r}/5${comment ? ` — "${comment.substring(0, 500)}"` : ''}`,
      channel: 'internal_note',
      is_internal_note: true,
      delivery_status: 'delivered'
    }).catch(() => {});

    return c.json({ data: { success: true, rating: r } });
  } catch (e) {
    console.error('submitTicketCSAT error:', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }

};