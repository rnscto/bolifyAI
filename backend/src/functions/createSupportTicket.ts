import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Create a support ticket from portal or admin.
// Auto-assigns based on category → team member round-robin.
// Sends acknowledgement email to the requester.



function genThreadToken() {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

// Generate a guaranteed-unique ticket number by checking the DB.
// Tries 5 times with 8-digit random; falls back to timestamp suffix.
async function genTicketNumber(svc) {
  for (let i = 0; i < 5; i++) {
    const n = Math.floor(Math.random() * 90000000) + 10000000; // 8 digits
    const candidate = `TKT-${n}`;
    const existing = await svc.entities.SupportTicket.filter({ ticket_number: candidate }).catch(() => []);
    if (existing.length === 0) return candidate;
  }
  // Fallback: timestamp-based, virtually impossible to collide
  return `TKT-${Date.now().toString(36).toUpperCase()}`;
}

function genMessageId() {
  return `<msg-${crypto.randomUUID()}@vaaniai.in>`;
}

async function autoAssign(svc, category) {
  // Pick least-loaded active team member who handles this category.
  const members = await svc.entities.SupportTeamMember.filter({ is_active: true });
  const candidates = members.filter(m => {
    if (!m.handles_categories || m.handles_categories.length === 0) return true; // generalist
    return m.handles_categories.includes(category);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.current_open_count || 0) - (b.current_open_count || 0));
  return candidates[0];
}

async function sendAckEmail(svc, ticket) {
  try {
    const subject = `[${ticket.ticket_number}] ${ticket.subject}`;
    const threadHeader = `<ticket-${ticket.email_thread_id}@vaaniai.in>`;
    const messageId = genMessageId();
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fff">
        <div style="background:#1e3a5f;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;font-size:18px">Ticket Received: ${ticket.ticket_number}</h2>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 8px 8px">
          <p>Hi ${ticket.requester_name || 'there'},</p>
          <p>Thanks for reaching out. We've received your ticket and our team will respond soon.</p>
          <p><b>Subject:</b> ${ticket.subject}<br/>
          <b>Category:</b> ${ticket.category}<br/>
          <b>Priority:</b> ${ticket.priority}</p>
          <p style="background:#f3f4f6;padding:12px;border-radius:6px;white-space:pre-wrap">${(ticket.description || '').substring(0, 1500)}</p>
          <p style="font-size:13px;color:#6b7280">Reply to this email to add more details to your ticket.</p>
        </div>
      </div>`;
    await svc.functions.invoke('sendAcsSmtpEmail', {
      to: ticket.requester_email,
      subject,
      html,
      from_name: 'Vaani Support',
      headers: { 'Message-ID': messageId, 'References': threadHeader }
    });
    // Persist outbound Message-ID for future threading
    svc.entities.SupportTicket.update(ticket.id, {
      email_message_ids: [...(ticket.email_message_ids || []), messageId].slice(-20)
    }).catch(() => {});
  } catch (e) { console.error('Ack email failed:', e.message); }
}

// Notify the support team (admins + active members) that a NEW ticket arrived,
// so they can open and respond quickly. Sends to the assigned member first,
// then every other active team member.
async function sendTeamNewTicketEmail(svc, ticket) {
  try {
    const team = await svc.entities.SupportTeamMember.filter({ is_active: true }).catch(() => []);
    const recipients = [...new Set(
      team.map(m => m.user_email).filter(Boolean)
    )];
    if (recipients.length === 0) {
      console.warn('sendTeamNewTicketEmail: no active team members to notify');
      return;
    }
    const priorityColor = ticket.priority === 'urgent' ? '#dc2626'
      : ticket.priority === 'high' ? '#ea580c' : '#1e3a5f';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="background:${priorityColor};color:#fff;padding:14px 20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;font-size:18px">🎫 New Ticket — ${ticket.ticket_number}</h2>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 8px 8px">
          <p><b>Subject:</b> ${ticket.subject}</p>
          <p><b>From:</b> ${ticket.requester_name || ''} &lt;${ticket.requester_email}&gt;</p>
          <p><b>Category:</b> ${ticket.category} &nbsp;|&nbsp; <b>Priority:</b> ${ticket.priority}</p>
          <p><b>Assigned:</b> ${ticket.assigned_to_name || 'Unassigned'}</p>
          <p style="background:#f9fafb;padding:12px;border-radius:6px;white-space:pre-wrap">${(ticket.description || '').substring(0, 1000)}</p>
          <p style="font-size:13px;color:#6b7280">Open the ticket in the Support dashboard to respond.</p>
        </div>
      </div>`;
    await Promise.all(recipients.map(email =>
      svc.functions.invoke('sendAcsSmtpEmail', {
        to: email,
        subject: `🎫 New Ticket: ${ticket.ticket_number} — ${ticket.subject}`,
        html,
        from_name: 'Vaani Support Alerts'
      }).catch(e => console.error(`Team notify failed for ${email}:`, e.message))
    ));
    console.log(`sendTeamNewTicketEmail: notified ${recipients.length} team member(s)`);
  } catch (e) { console.error('sendTeamNewTicketEmail failed:', e.message); }
}

export default async function createSupportTicket(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload').catch(() => null);

    const body = await c.req.json();
    const {
      subject, description, category = 'general', subcategory = '',
      priority = 'medium', requester_email, requester_name, requester_phone,
      client_id, attachments = [], source = 'portal'
    } = body;

    if (!subject || !(requester_email || user?.email)) {
      return c.json({ data: { error: 'subject and requester_email required' } }, 400);
    }

    const svc = base44.asServiceRole;

    // Resolve client_id from user if not supplied
    let resolvedClientId = client_id || '';
    let resolvedEmail = requester_email || user?.email;
    let resolvedName = requester_name || user?.full_name || '';
    if (!resolvedClientId && user?.email) {
      const clients = await svc.entities.Client.filter({ user_id: user.id }).catch(() => []);
      if (clients.length > 0) {
        resolvedClientId = clients[0].id;
        if (!requester_phone) body.requester_phone = clients[0].phone;
      }
    }

    const ticketNumber = await genTicketNumber(svc);
    const threadToken = genThreadToken();

    // Auto-assign
    const assignee = await autoAssign(svc, category);

    const ticket = await svc.entities.SupportTicket.create({
      ticket_number: ticketNumber,
      client_id: resolvedClientId,
      requester_email: resolvedEmail,
      requester_name: resolvedName,
      requester_phone: requester_phone || body.requester_phone || '',
      subject,
      description: description || '',
      category, subcategory, priority,
      status: 'open', source,
      assigned_to_email: assignee?.user_email || '',
      assigned_to_name: assignee?.full_name || '',
      assigned_at: assignee ? new Date().toISOString() : null,
      email_thread_id: threadToken,
      email_message_ids: [],
      attachments,
      sla_hours: 4,
      first_response_sla_hours: 1,
      first_response_due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      last_message_at: new Date().toISOString(),
      last_message_by: 'customer'
    });

    // First message record
    await svc.entities.SupportTicketMessage.create({
      ticket_id: ticket.id,
      client_id: resolvedClientId,
      sender_type: 'customer',
      sender_email: resolvedEmail,
      sender_name: resolvedName,
      body_text: description || '',
      channel: source === 'email' ? 'email' : 'portal',
      attachments,
      delivery_status: 'delivered'
    });

    // Bump assignee load counter
    if (assignee) {
      svc.entities.SupportTeamMember.update(assignee.id, {
        current_open_count: (assignee.current_open_count || 0) + 1
      }).catch(() => {});
    }

    // ── Auto-extend KYC deadline by 7 days (one-time, self-service) ──
    // When a client raises a 'kyc_extension' ticket, grant a single 7-day
    // extension automatically so they have more time to submit documents.
    let kycExtension = null;
    if (category === 'kyc_extension' && resolvedClientId) {
      try {
        const cl = await svc.entities.Client.get(resolvedClientId).catch(() => null);
        if (cl && cl.account_type !== 'personal') {
          const kycDone = cl.kyc_status === 'approved' || cl.kyc_status === 'not_required';
          if (kycDone) {
            kycExtension = { applied: false, reason: 'KYC already complete' };
          } else if (cl.kyc_extension_used) {
            kycExtension = { applied: false, reason: 'Extension already used' };
          } else {
            // Base extension off the later of today or the existing deadline.
            const today = new Date();
            const base = cl.kyc_deadline && new Date(cl.kyc_deadline) > today
              ? new Date(cl.kyc_deadline)
              : today;
            base.setDate(base.getDate() + 7);
            const newDeadline = base.toISOString().split('T')[0];
            await svc.entities.Client.update(cl.id, {
              kyc_deadline: newDeadline,
              kyc_extension_used: true,
              kyc_suspended: false,
              ...(cl.account_status === 'suspended' && cl.kyc_suspended ? { account_status: 'active' } : {}),
            });
            kycExtension = { applied: true, new_deadline: newDeadline };
          }
        }
      } catch (e) { console.error('KYC auto-extend failed:', e.message); }
    }

    // Acknowledgement email (only if source is portal/admin — email source already has the email)
    if (source !== 'email') {
      sendAckEmail(svc, ticket);
    }

    // Notify the support team/admins so they can open and respond quickly.
    sendTeamNewTicketEmail(svc, ticket);

    return c.json({ data: { success: true, ticket, kycExtension } });
  } catch (error) {
    console.error('createSupportTicket error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};