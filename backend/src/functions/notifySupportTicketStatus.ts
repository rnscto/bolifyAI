import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Notify the ticket requester whenever ticket status changes.
// Sends:
//   1. Status-update email (always)
//   2. Outbound voice call from platform AI agent (for resolved / in_progress)
//
// Triggered by entity automation on SupportTicket "update" events.
// Also callable manually with { ticket_id } payload.



const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In Progress',
  waiting_customer: 'Awaiting Your Response',
  resolved: 'Resolved',
  closed: 'Closed',
  reopened: 'Reopened'
};

const STATUS_COLOR = {
  open: '#3b82f6',
  in_progress: '#f59e0b',
  waiting_customer: '#a855f7',
  resolved: '#10b981',
  closed: '#6b7280',
  reopened: '#ef4444'
};

// Statuses where we proactively call the requester
const CALL_ON_STATUS = new Set(['in_progress', 'resolved']);

function buildStatusEmail(ticket, oldStatus, newStatus) {
  const color = STATUS_COLOR[newStatus] || '#1e3a5f';
  const label = STATUS_LABELS[newStatus] || newStatus;
  const oldLabel = STATUS_LABELS[oldStatus] || oldStatus || '—';

  let bodyHtml = '';
  if (newStatus === 'in_progress') {
    bodyHtml = `<p>Good news — our team has started working on your ticket. We'll keep you updated and call you shortly to discuss.</p>`;
  } else if (newStatus === 'resolved') {
    const portal = `https://vaaniai.in/SupportCSAT?ticket=${ticket.id}`;
    const ratingButtons = [1, 2, 3, 4, 5].map(n => {
      const colors = { 1: '#dc2626', 2: '#ea580c', 3: '#f59e0b', 4: '#84cc16', 5: '#10b981' };
      return `<a href="${portal}&rating=${n}" style="display:inline-block;margin:0 4px;padding:10px 16px;background:${colors[n]};color:#fff;text-decoration:none;border-radius:6px;font-weight:600">${n} ⭐</a>`;
    }).join('');
    bodyHtml = `
      <p>Your ticket has been marked as <b>resolved</b>. We'll give you a quick call to confirm everything is working as expected. If you still need help, just reply to this email and the ticket will be re-opened automatically.</p>
      <div style="margin:24px 0;padding:18px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;text-align:center">
        <p style="margin:0 0 12px;font-weight:600;color:#065f46">How was your support experience?</p>
        <div>${ratingButtons}</div>
        <p style="margin:12px 0 0;font-size:12px;color:#6b7280">Click a rating to share feedback (1 = poor, 5 = excellent)</p>
      </div>`;
  } else if (newStatus === 'closed') {
    bodyHtml = `<p>This ticket has been closed. Thank you for working with us! If a new issue comes up, please raise a fresh ticket.</p>`;
  } else if (newStatus === 'waiting_customer') {
    bodyHtml = `<p>We need a little more information from you to proceed. Please reply to this email with the requested details.</p>`;
  } else if (newStatus === 'reopened') {
    bodyHtml = `<p>Your ticket has been re-opened and is back in our queue. We'll get back to you shortly.</p>`;
  } else {
    bodyHtml = `<p>Your ticket status has been updated.</p>`;
  }

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fff">
      <div style="background:#1e3a5f;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:18px">${ticket.ticket_number} — Status Update</h2>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:24px;border-radius:0 0 8px 8px">
        <p style="margin:0 0 8px">Hi ${ticket.requester_name || 'there'},</p>
        <div style="margin:16px 0;padding:14px 16px;background:#f9fafb;border-left:4px solid ${color};border-radius:4px">
          <div style="font-size:13px;color:#6b7280;margin-bottom:4px">Status changed</div>
          <div style="font-size:15px"><span style="color:#9ca3af;text-decoration:line-through">${oldLabel}</span> &nbsp;→&nbsp; <b style="color:${color}">${label}</b></div>
        </div>
        <div style="margin:12px 0">
          <b>Subject:</b> ${ticket.subject}
        </div>
        ${bodyHtml}
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280">
          — Vaani Support<br/>
          <i>Reply to this email to add a message to your ticket.</i>
        </div>
      </div>
    </div>`;
}

function genMessageId() {
  return `<msg-${crypto.randomUUID()}@vaaniai.in>`;
}

async function sendStatusEmail(svc, ticket, oldStatus, newStatus) {
  const threadHeader = `<ticket-${ticket.email_thread_id}@vaaniai.in>`;
  const lastMsgId = (ticket.email_message_ids || []).slice(-1)[0];
  const refs = [threadHeader, ...(ticket.email_message_ids || [])].join(' ');
  const messageId = genMessageId();
  const subject = ticket.subject.startsWith('[' + ticket.ticket_number + ']')
    ? ticket.subject
    : `[${ticket.ticket_number}] ${ticket.subject}`;

  const html = buildStatusEmail(ticket, oldStatus, newStatus);

  const res = await svc.functions.invoke('sendAcsSmtpEmail', {
    to: ticket.requester_email,
    subject: `${subject} — ${STATUS_LABELS[newStatus] || newStatus}`,
    html,
    from_name: 'Vaani Support',
    headers: {
      'Message-ID': messageId,
      ...(lastMsgId ? { 'In-Reply-To': lastMsgId } : {}),
      'References': refs
    }
  });
  // Persist outbound Message-ID
  if (res?.data?.success) {
    svc.entities.SupportTicket.update(ticket.id, {
      email_message_ids: [...(ticket.email_message_ids || []), messageId].slice(-20)
    }).catch(() => {});
  }
  return res?.data || {};
}

async function placeStatusCall(svc, ticket, newStatus) {
  // Need a phone number to call
  const phone = (ticket.requester_phone || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 10) {
    return { skipped: true, reason: 'no_phone' };
  }

  // Find a platform support agent + lead — we reuse the existing voice agent infra.
  // SAFETY: only use an agent on the ticket's own client_id to avoid cross-tenant
  // lead pollution. If ticket has no client_id (email-only sender), skip the call.
  if (!ticket.client_id) {
    return { skipped: true, reason: 'no_client_id' };
  }
  const agents = await svc.entities.Agent.filter({ status: 'active', client_id: ticket.client_id }).catch(() => []);
  // Prefer an agent flagged as support, then any active agent on this client
  let agent = agents.find(a => /support|service|help|ticket/i.test(a.name || ''));
  if (!agent) agent = agents[0];
  if (!agent) {
    return { skipped: true, reason: 'no_agent_configured' };
  }

  // We need a Lead record to satisfy initiateCall — create a lightweight one
  // tied to this ticket if it doesn't exist.
  const leadName = ticket.requester_name || ticket.requester_email || 'Support Caller';
  const existing = await svc.entities.Lead.filter({
    client_id: agent.client_id,
    phone: phone
  }).catch(() => []);
  let lead = existing[0];
  if (!lead) {
    lead = await svc.entities.Lead.create({
      client_id: agent.client_id,
      name: leadName,
      phone: phone,
      email: ticket.requester_email || '',
      source: 'support_ticket',
      status: 'contacted',
      notes: `Auto-created for ticket ${ticket.ticket_number}`
    });
  }

  // Tailor the AI's opening instructions based on status
  const statusContext = newStatus === 'resolved'
    ? `You are calling ${leadName} to confirm that their support ticket ${ticket.ticket_number} ("${ticket.subject}") has been resolved. Politely confirm everything is working as expected. If not, gather details and let them know the ticket will be re-opened.`
    : `You are calling ${leadName} to update them that our team has started working on their support ticket ${ticket.ticket_number} ("${ticket.subject}"). Reassure them and ask if they have any additional details to share.`;

  const res = await svc.functions.invoke('initiateCall', {
    service_call: true,
    lead_id: lead.id,
    agent_id: agent.id,
    phone_number: phone,
    context_override: statusContext
  });
  return res?.data || { ok: false };
}

export default async function notifySupportTicketStatus(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    const payload = await c.req.json().catch(() => ({}));

    // Resolve ticket + old/new status from either an entity automation event or a manual call
    let ticket = null;
    let oldStatus = null;
    let newStatus = null;

    if (payload.event && payload.event.entity_name === 'SupportTicket') {
      // Entity automation trigger
      const id = payload.event.entity_id;
      ticket = payload.payload_too_large
        ? await svc.entities.SupportTicket.get(id)
        : payload.data;
      oldStatus = payload.old_data?.status || null;
      newStatus = ticket?.status || null;

      // Only act if status actually changed
      const changed = Array.isArray(payload.changed_fields) && payload.changed_fields.includes('status');
      if (!changed || oldStatus === newStatus) {
        return c.json({ data: { success: true, skipped: 'status_unchanged' } });
      }
    } else if (payload.ticket_id) {
      // Manual invoke (for testing or forced re-notify)
      ticket = await svc.entities.SupportTicket.get(payload.ticket_id);
      oldStatus = payload.old_status || null;
      newStatus = payload.new_status || ticket?.status || null;
    } else {
      return c.json({ data: { error: 'ticket_id or entity event required' } }, 400);
    }

    if (!ticket) return c.json({ data: { error: 'Ticket not found' } }, 404);
    if (!ticket.requester_email) return c.json({ data: { success: true, skipped: 'no_email' } });

    // 1. Send status email to requester
    const emailRes = await sendStatusEmail(svc, ticket, oldStatus, newStatus)
      .catch(e => ({ success: false, error: e.message }));

    // 1b. Email the assigned support agent (if any) about the status change
    if (ticket.assigned_to_email) {
      const ticketUrl = `https://vaaniai.in/SupportTicketDetail?id=${ticket.id}`;
      const agentHtml = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <div style="background:#1e3a5f;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0;font-size:18px">🔄 Your Ticket Status Updated</h2>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:0;padding:24px;border-radius:0 0 8px 8px">
            <p>Ticket <b>${ticket.ticket_number}</b> assigned to you has a new status:</p>
            <div style="margin:16px 0;padding:14px;background:#f9fafb;border-left:4px solid #f59e0b;border-radius:4px">
              <div style="font-size:15px"><span style="color:#9ca3af;text-decoration:line-through">${oldStatus || '—'}</span> &nbsp;→&nbsp; <b style="color:#1e3a5f">${newStatus}</b></div>
              <div style="margin-top:8px"><b>Subject:</b> ${ticket.subject}</div>
              <div style="margin-top:4px"><b>Requester:</b> ${ticket.requester_name || ticket.requester_email}</div>
            </div>
            <p><a href="${ticketUrl}" style="display:inline-block;padding:10px 20px;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Open Ticket →</a></p>
          </div>
        </div>`;
      svc.functions.invoke('sendAcsSmtpEmail', {
        to: ticket.assigned_to_email,
        subject: `[${ticket.ticket_number}] Status → ${newStatus}`,
        html: agentHtml,
        from_name: 'Vaani Support'
      }).catch(() => {});
    }

    // 2. Place call for selected statuses
    let callRes = { skipped: true, reason: 'status_not_callable' };
    if (CALL_ON_STATUS.has(newStatus)) {
      callRes = await placeStatusCall(svc, ticket, newStatus)
        .catch(e => ({ success: false, error: e.message }));
    }

    // 3. Log a system message on the ticket thread
    svc.entities.SupportTicketMessage.create({
      ticket_id: ticket.id,
      client_id: ticket.client_id || '',
      sender_type: 'system',
      sender_email: 'system@vaaniai.in',
      sender_name: 'System',
      body_text: `Status changed: ${oldStatus || '—'} → ${newStatus}. Email ${emailRes.success ? 'sent' : 'failed'}.${callRes.skipped ? '' : ` Call ${callRes.success ? 'initiated' : 'failed'}.`}`,
      channel: 'internal_note',
      is_internal_note: true,
      delivery_status: 'delivered'
    }).catch(() => {});

    return c.json({ data: { success: true, email: emailRes, call: callRes } });
  } catch (error) {
    console.error('notifySupportTicketStatus error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};