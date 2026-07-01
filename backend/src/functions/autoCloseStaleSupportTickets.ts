import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Closes tickets in 'waiting_customer' or 'resolved' that have had no activity for N days.
// Sends a warning email at day (N - 2) and closes on day N.
// Schedule: run once a day.



const WAITING_AUTO_CLOSE_DAYS = 7;
const RESOLVED_AUTO_CLOSE_DAYS = 3;
const WARN_BEFORE_DAYS = 2;

function daysSince(iso) {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

async function sendWarnEmail(svc, ticket, daysLeft) {
  const subject = `[${ticket.ticket_number}] We'll close this ticket in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#1e3a5f;color:#fff;padding:12px 16px;border-radius:6px 6px 0 0">
        <b>${ticket.ticket_number}</b> · ${ticket.subject}
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 6px 6px">
        <p>Hi ${ticket.requester_name || 'there'},</p>
        <p>We haven't heard from you on this ticket. If we don't hear back in <b>${daysLeft} day${daysLeft === 1 ? '' : 's'}</b>, we'll close it automatically.</p>
        <p>If your question is still unresolved, simply reply to this email and we'll continue helping you.</p>
        <p style="color:#6b7280;font-size:13px;margin-top:24px">— Vaani Support</p>
      </div>
    </div>`;
  await svc.functions.invoke('sendAcsSmtpEmail', {
    to: ticket.requester_email,
    subject,
    html,
    from_name: 'Vaani Support'
  }).catch(() => {});
}

export default async function autoCloseStaleSupportTickets(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // Allow CRON or admin
    const cronKey = Deno.env.get('CRON_API_KEY');
    const url = new URL(req.url);
    const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
                     req.headers.get('x-cron-key') ||
                     url.searchParams.get('api_key') || '';
    const isCron = cronKey && provided === cronKey;
    if (!isCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user || user.role !== 'admin') return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    const [waiting, resolved] = await Promise.all([
      svc.entities.SupportTicket.filter({ status: 'waiting_customer' }).catch(() => []),
      svc.entities.SupportTicket.filter({ status: 'resolved' }).catch(() => [])
    ]);

    let warned = 0, closed = 0;
    const now = new Date().toISOString();

    const process = async (ticket, threshold) => {
      const anchor = ticket.last_message_at || ticket.created_date;
      const days = daysSince(anchor);
      if (days >= threshold) {
        await svc.entities.SupportTicket.update(ticket.id, {
          status: 'closed',
          closed_at: now,
          last_message_at: now,
          last_message_by: 'system'
        }).catch(() => {});
        svc.entities.SupportTicketMessage.create({
          ticket_id: ticket.id,
          client_id: ticket.client_id || '',
          sender_type: 'system',
          sender_name: 'Auto-close',
          body_text: `Closed automatically after ${threshold} days of inactivity.`,
          channel: 'internal_note',
          is_internal_note: true,
          delivery_status: 'delivered'
        }).catch(() => {});
        closed++;
      } else if (days >= (threshold - WARN_BEFORE_DAYS) && !ticket.auto_close_warned_at) {
        await sendWarnEmail(svc, ticket, Math.ceil(threshold - days));
        await svc.entities.SupportTicket.update(ticket.id, { auto_close_warned_at: now }).catch(() => {});
        warned++;
      }
    };

    for (const t of waiting) await process(t, WAITING_AUTO_CLOSE_DAYS);
    for (const t of resolved) await process(t, RESOLVED_AUTO_CLOSE_DAYS);

    return c.json({ data: { success: true, warned, closed, scanned: waiting.length + resolved.length } });
  } catch (e) {
    console.error('autoCloseStaleSupportTickets error:', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }

};