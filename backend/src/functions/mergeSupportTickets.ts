import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Merges a duplicate ticket into a primary ticket.
// - Moves all SupportTicketMessage rows from duplicate -> primary
// - Posts a system note on both tickets
// - Closes the duplicate ticket with status='closed'
// - Decrements the duplicate's assignee load if applicable
//
// Auth: only admin or active SupportTeamMember can merge.



export default async function mergeSupportTickets(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { primary_ticket_id, duplicate_ticket_id, reason = '' } = await c.req.json();
    if (!primary_ticket_id || !duplicate_ticket_id) {
      return c.json({ data: { error: 'primary_ticket_id and duplicate_ticket_id required' } }, 400);
    }
    if (primary_ticket_id === duplicate_ticket_id) {
      return c.json({ data: { error: 'Cannot merge a ticket into itself' } }, 400);
    }

    // RBAC
    if (user.role !== 'admin') {
      const tm = await svc.entities.SupportTeamMember.filter({ user_email: user.email, is_active: true });
      if (!tm.length) return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    const [primary, duplicate] = await Promise.all([
      svc.entities.SupportTicket.get(primary_ticket_id),
      svc.entities.SupportTicket.get(duplicate_ticket_id)
    ]);
    if (!primary || !duplicate) return c.json({ data: { error: 'Ticket not found' } }, 404);
    if (duplicate.status === 'closed') return c.json({ data: { error: 'Duplicate ticket is already closed' } }, 400);

    // Move messages from duplicate -> primary (preserve created_date by keeping rows; only re-key ticket_id)
    const dupMessages = await svc.entities.SupportTicketMessage.filter({ ticket_id: duplicate_ticket_id }, 'created_date', 1000);
    for (const m of dupMessages) {
      await svc.entities.SupportTicketMessage.update(m.id, { ticket_id: primary_ticket_id }).catch(() => {});
    }

    const mergedBy = user.full_name || user.email;
    const now = new Date().toISOString();

    // System note on primary
    await svc.entities.SupportTicketMessage.create({
      ticket_id: primary_ticket_id,
      client_id: primary.client_id || '',
      sender_type: 'system',
      sender_email: user.email,
      sender_name: mergedBy,
      body_text: `Merged ticket ${duplicate.ticket_number} into this one (${dupMessages.length} messages moved)${reason ? `. Reason: ${reason}` : '.'}`,
      channel: 'internal_note',
      is_internal_note: true,
      delivery_status: 'delivered'
    }).catch(() => {});

    // System note on duplicate (stays as the last visible thing on the closed copy)
    await svc.entities.SupportTicketMessage.create({
      ticket_id: duplicate_ticket_id,
      client_id: duplicate.client_id || '',
      sender_type: 'system',
      sender_email: user.email,
      sender_name: mergedBy,
      body_text: `This ticket was merged into ${primary.ticket_number} by ${mergedBy} and closed.`,
      channel: 'internal_note',
      is_internal_note: true,
      delivery_status: 'delivered'
    }).catch(() => {});

    // Close duplicate
    await svc.entities.SupportTicket.update(duplicate_ticket_id, {
      status: 'closed',
      closed_at: now,
      last_message_at: now,
      last_message_by: 'system'
    });

    // Decrement duplicate's assignee load if previously open
    if (duplicate.assigned_to_email && !['resolved', 'closed'].includes(duplicate.status)) {
      const members = await svc.entities.SupportTeamMember.filter({ user_email: duplicate.assigned_to_email });
      if (members.length) {
        const m = members[0];
        await svc.entities.SupportTeamMember.update(m.id, {
          current_open_count: Math.max(0, (m.current_open_count || 0) - 1)
        }).catch(() => {});
      }
    }

    // Bump primary last_message_at
    await svc.entities.SupportTicket.update(primary_ticket_id, {
      last_message_at: now
    }).catch(() => {});

    return c.json({ data: {
      success: true,
      primary_ticket_id,
      duplicate_ticket_id,
      messages_moved: dupMessages.length
    } });
  } catch (e) {
    console.error('mergeSupportTickets error:', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }

};