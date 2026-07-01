import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Assign or re-assign a ticket to a team member. Admin / support_manager only.


export default async function assignSupportTicket(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { ticket_id, assignee_email, new_status = null, new_priority = null, new_category = null } = await c.req.json();
    if (!ticket_id) return c.json({ data: { error: 'ticket_id required' } }, 400);

    const svc = base44.asServiceRole;

    // Authorize: admin OR support_admin/support_manager
    let allowed = user.role === 'admin';
    if (!allowed) {
      const members = await svc.entities.SupportTeamMember.filter({ user_email: user.email });
      const m = members[0];
      allowed = m && m.is_active && ['support_admin', 'support_manager'].includes(m.support_role);
    }
    if (!allowed) return c.json({ data: { error: 'Forbidden' } }, 403);

    const ticket = await svc.entities.SupportTicket.get(ticket_id);
    if (!ticket) return c.json({ data: { error: 'Not found' } }, 404);

    const updates = {};
    if (assignee_email !== undefined) {
      // Decrement old assignee
      if (ticket.assigned_to_email && ticket.assigned_to_email !== assignee_email) {
        const old = (await svc.entities.SupportTeamMember.filter({ user_email: ticket.assigned_to_email }))[0];
        if (old) svc.entities.SupportTeamMember.update(old.id, { current_open_count: Math.max(0, (old.current_open_count || 1) - 1) }).catch(() => {});
      }
      if (assignee_email) {
        const newM = (await svc.entities.SupportTeamMember.filter({ user_email: assignee_email }))[0];
        updates.assigned_to_email = assignee_email;
        updates.assigned_to_name = newM?.full_name || '';
        updates.assigned_at = new Date().toISOString();
        if (newM && newM.user_email !== ticket.assigned_to_email) {
          svc.entities.SupportTeamMember.update(newM.id, { current_open_count: (newM.current_open_count || 0) + 1 }).catch(() => {});
        }
      } else {
        updates.assigned_to_email = '';
        updates.assigned_to_name = '';
      }
    }
    if (new_status) {
      updates.status = new_status;
      if (new_status === 'resolved') updates.resolved_at = new Date().toISOString();
      if (new_status === 'closed') updates.closed_at = new Date().toISOString();
    }
    if (new_priority) updates.priority = new_priority;
    if (new_category) updates.category = new_category;

    await svc.entities.SupportTicket.update(ticket_id, updates);

    // Email new assignee (only if assignee actually changed)
    if (assignee_email && assignee_email !== ticket.assigned_to_email) {
      const ticketUrl = `https://vaaniai.in/SupportTicketDetail?id=${ticket_id}`;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <div style="background:#1e3a5f;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0;font-size:18px">🎫 New Ticket Assigned to You</h2>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:0;padding:24px;border-radius:0 0 8px 8px">
            <p>Hi ${updates.assigned_to_name || ''},</p>
            <p><b>${user.full_name || user.email}</b> has assigned ticket <b>${ticket.ticket_number}</b> to you.</p>
            <div style="margin:16px 0;padding:14px;background:#f9fafb;border-left:4px solid #1e3a5f;border-radius:4px">
              <div><b>Subject:</b> ${ticket.subject}</div>
              <div style="margin-top:6px"><b>Priority:</b> ${ticket.priority} &nbsp;•&nbsp; <b>Category:</b> ${ticket.category}</div>
              <div style="margin-top:6px"><b>Requester:</b> ${ticket.requester_name || ticket.requester_email}</div>
            </div>
            <p><a href="${ticketUrl}" style="display:inline-block;padding:10px 20px;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Open Ticket →</a></p>
          </div>
        </div>`;
      svc.functions.invoke('sendAcsSmtpEmail', {
        to: assignee_email,
        subject: `[${ticket.ticket_number}] Assigned to you — ${ticket.subject}`,
        html,
        from_name: 'Vaani Support'
      }).catch(() => {});
    }

    // Email assignee on status change (if ticket has an assignee)
    if (new_status && new_status !== ticket.status) {
      const notifyTo = updates.assigned_to_email || ticket.assigned_to_email;
      if (notifyTo) {
        const ticketUrl = `https://vaaniai.in/SupportTicketDetail?id=${ticket_id}`;
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
            <div style="background:#1e3a5f;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
              <h2 style="margin:0;font-size:18px">🔄 Ticket Status Updated</h2>
            </div>
            <div style="border:1px solid #e5e7eb;border-top:0;padding:24px;border-radius:0 0 8px 8px">
              <p>Ticket <b>${ticket.ticket_number}</b> status changed by <b>${user.full_name || user.email}</b>:</p>
              <div style="margin:16px 0;padding:14px;background:#f9fafb;border-left:4px solid #f59e0b;border-radius:4px">
                <div style="font-size:15px"><span style="color:#9ca3af;text-decoration:line-through">${ticket.status}</span> &nbsp;→&nbsp; <b style="color:#1e3a5f">${new_status}</b></div>
                <div style="margin-top:8px"><b>Subject:</b> ${ticket.subject}</div>
              </div>
              <p><a href="${ticketUrl}" style="display:inline-block;padding:10px 20px;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Open Ticket →</a></p>
            </div>
          </div>`;
        svc.functions.invoke('sendAcsSmtpEmail', {
          to: notifyTo,
          subject: `[${ticket.ticket_number}] Status → ${new_status}`,
          html,
          from_name: 'Vaani Support'
        }).catch(() => {});
      }
    }

    // System message log
    const changes = [];
    if (assignee_email !== undefined) changes.push(`assigned to ${assignee_email || 'unassigned'}`);
    if (new_status) changes.push(`status → ${new_status}`);
    if (new_priority) changes.push(`priority → ${new_priority}`);
    if (new_category) changes.push(`category → ${new_category}`);
    if (changes.length) {
      svc.entities.SupportTicketMessage.create({
        ticket_id, client_id: ticket.client_id || '',
        sender_type: 'system', sender_email: user.email, sender_name: user.full_name || '',
        body_text: `${user.full_name || user.email} updated: ${changes.join(', ')}`,
        channel: 'internal_note', is_internal_note: true, delivery_status: 'skipped'
      }).catch(() => {});
    }

    return c.json({ data: { success: true } });
  } catch (e) {
    return c.json({ data: { error: e.message } }, 500);
  }

};