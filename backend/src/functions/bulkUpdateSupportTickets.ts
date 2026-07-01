import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Bulk-update a set of support tickets (assign, change status, set priority, add/remove tags, close).
// Only callable by admin or support team members with appropriate role.



export default async function bulkUpdateSupportTickets(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    let teamMember = null;
    if (user.role !== 'admin') {
      const tm = await svc.entities.SupportTeamMember.filter({ user_email: user.email, is_active: true });
      teamMember = tm[0];
      if (!teamMember) return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    const { ticket_ids = [], action, value } = await c.req.json();
    if (!Array.isArray(ticket_ids) || ticket_ids.length === 0) {
      return c.json({ data: { error: 'ticket_ids required' } }, 400);
    }

    const now = new Date().toISOString();
    let updated = 0, failed = 0;

    for (const id of ticket_ids) {
      try {
        const t = await svc.entities.SupportTicket.get(id);
        if (!t) { failed++; continue; }

        const updates = {};
        if (action === 'assign') {
          // value = email of member; ''/null = unassign
          const email = value || '';
          updates.assigned_to_email = email;
          if (email) {
            const m = await svc.entities.SupportTeamMember.filter({ user_email: email });
            updates.assigned_to_name = m[0]?.full_name || email;
            updates.assigned_at = now;
          } else {
            updates.assigned_to_name = '';
          }
        } else if (action === 'status') {
          updates.status = value;
          if (value === 'resolved') updates.resolved_at = now;
          if (value === 'closed') updates.closed_at = now;
          updates.last_message_at = now;
          updates.last_message_by = 'system';
        } else if (action === 'priority') {
          updates.priority = value;
        } else if (action === 'add_tag') {
          const tags = new Set(t.tags || []);
          tags.add(String(value).trim().toLowerCase());
          updates.tags = Array.from(tags);
        } else if (action === 'remove_tag') {
          updates.tags = (t.tags || []).filter(x => x !== value);
        } else {
          failed++; continue;
        }

        await svc.entities.SupportTicket.update(id, updates);
        // System note
        svc.entities.SupportTicketMessage.create({
          ticket_id: id,
          client_id: t.client_id || '',
          sender_type: 'system',
          sender_email: user.email,
          sender_name: user.full_name || user.email,
          body_text: `Bulk action by ${user.full_name || user.email}: ${action} → ${value || '(cleared)'}`,
          channel: 'internal_note',
          is_internal_note: true,
          delivery_status: 'delivered'
        }).catch(() => {});
        updated++;
      } catch (e) {
        console.error('Bulk update failed for', id, e.message);
        failed++;
      }
    }

    return c.json({ data: { success: true, updated, failed } });
  } catch (e) {
    console.error('bulkUpdateSupportTickets error:', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }

};