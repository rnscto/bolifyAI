import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Entity-triggered notification — fires when a ticket is created or its priority becomes 'urgent'.
// Posts to Telegram (if TELEGRAM_BOT_TOKEN + admin chat_id) and emails all active support team members.



async function notifyTelegram(text) {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatIds = (Deno.env.get('SUPPORT_URGENT_TELEGRAM_CHAT_IDS') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || chatIds.length === 0) return;
  await Promise.all(chatIds.map(chat_id =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' })
    }).catch(() => {})
  ));
}

export default async function notifyUrgentTicket(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const payload = await c.req.json().catch(() => ({}));

    const event = payload.event || {};
    const data = payload.data;
    const oldData = payload.old_data;

    // Resolve ticket
    let ticket = data;
    if (!ticket && event.entity_id) {
      ticket = await svc.entities.SupportTicket.get(event.entity_id).catch(() => null);
    }
    if (!ticket) return c.json({ data: { skipped: 'no ticket' } });

    // Only act on urgent — either newly created urgent OR upgraded to urgent
    const becameUrgent =
      (event.type === 'create' && ticket.priority === 'urgent') ||
      (event.type === 'update' && ticket.priority === 'urgent' && oldData?.priority !== 'urgent');
    if (!becameUrgent) return c.json({ data: { skipped: 'not urgent' } });

    const text = `🚨 <b>URGENT TICKET</b>\n` +
      `<b>${ticket.ticket_number}</b> — ${ticket.subject}\n` +
      `From: ${ticket.requester_name || ''} &lt;${ticket.requester_email}&gt;\n` +
      `Category: ${ticket.category}\n` +
      (ticket.assigned_to_name ? `Assigned: ${ticket.assigned_to_name}\n` : 'Unassigned\n');
    notifyTelegram(text).catch(() => {});

    // Email blast to active team
    const team = await svc.entities.SupportTeamMember.filter({ is_active: true }).catch(() => []);
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="background:#dc2626;color:#fff;padding:14px 20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;font-size:18px">🚨 Urgent Ticket — ${ticket.ticket_number}</h2>
        </div>
        <div style="border:1px solid #fecaca;border-top:0;padding:20px;border-radius:0 0 8px 8px">
          <p><b>Subject:</b> ${ticket.subject}</p>
          <p><b>From:</b> ${ticket.requester_name || ''} &lt;${ticket.requester_email}&gt;</p>
          <p><b>Category:</b> ${ticket.category}</p>
          <p style="background:#f9fafb;padding:12px;border-radius:6px;white-space:pre-wrap">${(ticket.description || '').substring(0, 800)}</p>
        </div>
      </div>`;

    await Promise.all(team.map(m =>
      svc.functions.invoke('sendAcsSmtpEmail', {
        to: m.user_email,
        subject: `🚨 URGENT: ${ticket.ticket_number} — ${ticket.subject}`,
        html,
        from_name: 'Vaani Support Alerts'
      }).catch(() => {})
    ));

    return c.json({ data: { success: true, notified: team.length } });
  } catch (e) {
    console.error('notifyUrgentTicket error:', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }

};