import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Add a reply or internal note to a ticket.
// If sender is agent and not an internal note, send email to requester.



function genMessageId() {
  return `<msg-${crypto.randomUUID()}@vaaniai.in>`;
}

async function sendReplyEmail(svc, ticket, body_html, body_text, agentName) {
  const threadHeader = `<ticket-${ticket.email_thread_id}@vaaniai.in>`;
  const lastMsgId = (ticket.email_message_ids || []).slice(-1)[0];
  const refs = [threadHeader, ...(ticket.email_message_ids || [])].join(' ');
  const messageId = genMessageId();
  const subject = ticket.subject.startsWith('[' + ticket.ticket_number + ']')
    ? ticket.subject
    : `[${ticket.ticket_number}] ${ticket.subject}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fff">
      <div style="background:#1e3a5f;color:#fff;padding:12px 16px;border-radius:6px 6px 0 0">
        <b>${ticket.ticket_number}</b> &middot; ${ticket.subject}
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 6px 6px">
        ${body_html || `<div style="white-space:pre-wrap">${(body_text || '').replace(/</g, '&lt;')}</div>`}
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280">
          — ${agentName || 'Vaani Support'}<br/>
          <i>Reply to this email to continue the conversation.</i>
        </div>
      </div>
    </div>`;

  const res = await svc.functions.invoke('sendAcsSmtpEmail', {
    to: ticket.requester_email,
    subject,
    html,
    from_name: agentName ? `${agentName} (Vaani Support)` : 'Vaani Support',
    headers: {
      'Message-ID': messageId,
      ...(lastMsgId ? { 'In-Reply-To': lastMsgId } : {}),
      'References': refs
    }
  });
  const data = res?.data || {};
  return { ok: !!data.success, id: messageId, error: data.error };
}

async function adjustAssigneeLoad(svc, ticket, oldStatus, newStatus) {
  if (!ticket.assigned_to_email) return;
  const TERMINAL = ['resolved', 'closed'];
  const wasTerminal = TERMINAL.includes(oldStatus);
  const isTerminal = TERMINAL.includes(newStatus);
  if (wasTerminal === isTerminal) return; // no change
  const members = await svc.entities.SupportTeamMember.filter({ user_email: ticket.assigned_to_email }).catch(() => []);
  const m = members[0];
  if (!m) return;
  const cur = m.current_open_count || 0;
  const next = isTerminal ? Math.max(0, cur - 1) : cur + 1;
  svc.entities.SupportTeamMember.update(m.id, { current_open_count: next }).catch(() => {});
}

export default async function replySupportTicket(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { ticket_id, body_text, body_html, is_internal_note = false, attachments = [], new_status = null } = await c.req.json();
    // Attachments are already uploaded to public Azure blob storage by the frontend uploader
    // and stored as { name, url, size_kb } objects on the message.
    if (!ticket_id || !body_text) return c.json({ data: { error: 'ticket_id and body_text required' } }, 400);

    const svc = base44.asServiceRole;
    const ticket = await svc.entities.SupportTicket.get(ticket_id);
    if (!ticket) return c.json({ data: { error: 'Ticket not found' } }, 404);

    // Permission: admins/support team members OR the ticket requester
    const isAdmin = user.role === 'admin';
    const isRequester = user.email?.toLowerCase() === (ticket.requester_email || '').toLowerCase();
    let teamMember = null;
    if (!isAdmin && !isRequester) {
      const members = await svc.entities.SupportTeamMember.filter({ user_email: user.email });
      teamMember = members[0];
      if (!teamMember || !teamMember.is_active) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const senderType = (isAdmin || teamMember) ? 'agent' : 'customer';

    const msg = await svc.entities.SupportTicketMessage.create({
      ticket_id: ticket.id,
      client_id: ticket.client_id || '',
      sender_type: senderType,
      sender_email: user.email,
      sender_name: user.full_name || '',
      body_text,
      body_html: body_html || '',
      channel: is_internal_note ? 'internal_note' : 'portal',
      is_internal_note,
      attachments,
      delivery_status: is_internal_note ? 'skipped' : 'pending'
    });

    // Update ticket
    const updates = {
      last_message_at: new Date().toISOString(),
      last_message_by: senderType
    };
    if (new_status) updates.status = new_status;
    else if (senderType === 'agent' && ticket.status === 'open') updates.status = 'in_progress';
    else if (senderType === 'customer' && ['resolved', 'closed'].includes(ticket.status)) updates.status = 'reopened';
    // Only count NON-internal agent replies as first response
    if (senderType === 'agent' && !is_internal_note && !ticket.first_response_at) {
      updates.first_response_at = new Date().toISOString();
    }
    // Customer reply clears auto-close warning flag
    if (senderType === 'customer' && ticket.auto_close_warned_at) {
      updates.auto_close_warned_at = null;
    }
    if (new_status === 'resolved') updates.resolved_at = new Date().toISOString();
    if (new_status === 'closed') updates.closed_at = new Date().toISOString();
    const finalStatus = updates.status || ticket.status;
    await svc.entities.SupportTicket.update(ticket.id, updates);

    // Adjust assignee load counter when status crosses terminal boundary
    adjustAssigneeLoad(svc, ticket, ticket.status, finalStatus).catch(() => {});

    // Send email if agent reply (not internal note)
    if (senderType === 'agent' && !is_internal_note) {
      const sendRes = await sendReplyEmail(svc, ticket, body_html, body_text, user.full_name).catch(e => ({ ok: false, error: e.message }));
      svc.entities.SupportTicketMessage.update(msg.id, {
        delivery_status: sendRes.ok ? 'sent' : 'failed',
        delivery_error: sendRes.error || ''
      }).catch(() => {});
      // Persist outbound Message-ID for future threading
      if (sendRes.ok && sendRes.id) {
        svc.entities.SupportTicket.update(ticket.id, {
          email_message_ids: [...(ticket.email_message_ids || []), sendRes.id].slice(-20)
        }).catch(() => {});
      }
    }

    return c.json({ data: { success: true, message: msg } });
  } catch (error) {
    console.error('replySupportTicket error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};