import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Scheduled SLA checker.
// Finds tickets in 'open' or 'in_progress' for > sla_hours (default 4h), marks them
// as breached, and alerts the assigned agent + all active support team members by email.
// Idempotent: re-alerts at most once every 4 hours per ticket.
//
// Entity automations can't trigger on "no change for X hours", so a scheduled poll
// is the correct mechanism for SLA monitoring.



const ALERT_STATUSES = ['open', 'in_progress'];
const RE_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

function ageHours(iso) {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

function buildAlertHtml(ticket, ageHrs, slaHrs) {
  const overdueBy = Math.max(0, ageHrs - slaHrs).toFixed(1);
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fff">
      <div style="background:#dc2626;color:#fff;padding:14px 20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:18px">⚠ SLA Breach — ${ticket.ticket_number}</h2>
      </div>
      <div style="border:1px solid #fecaca;border-top:0;padding:24px;border-radius:0 0 8px 8px">
        <p style="margin:0 0 12px"><b>Subject:</b> ${ticket.subject}</p>
        <p style="margin:0 0 12px"><b>Status:</b> ${ticket.status} &nbsp; <b>Priority:</b> ${ticket.priority || 'medium'}</p>
        <p style="margin:0 0 12px"><b>Requester:</b> ${ticket.requester_name || ''} &lt;${ticket.requester_email}&gt;</p>
        <p style="margin:0 0 12px"><b>Age:</b> ${ageHrs.toFixed(1)}h &nbsp; <b>SLA:</b> ${slaHrs}h &nbsp; <b style="color:#dc2626">Overdue by ${overdueBy}h</b></p>
        <p style="margin:16px 0 0;color:#6b7280;font-size:13px">Please pick this ticket up immediately.</p>
      </div>
    </div>`;
}

export default async function checkSupportTicketSLA(c: any) {
  const req = c.req.raw || c.req;
  try {
    // External cron auth — accept CRON_API_KEY via Authorization: Bearer, X-Cron-Key header, or ?key= query param.
    // Falls through to base44 auth (internal scheduler) if no cron key present.
    const cronKey = Deno.env.get('CRON_API_KEY');
    const url = new URL(req.url);
    const provided =
      (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
      req.headers.get('x-cron-key') ||
      req.headers.get('x-api-key') ||
      url.searchParams.get('api_key') ||
      url.searchParams.get('secret') ||
      url.searchParams.get('key') ||
      '';
    const isExternalCron = cronKey && provided && provided === cronKey;

    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // If not external cron, require an authenticated user (internal scheduler invocations pass auth)
    if (!isExternalCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    // Pull all non-terminal tickets in batches
    const candidates = [];
    for (const status of ALERT_STATUSES) {
      const list = await svc.entities.SupportTicket.filter({ status }).catch(() => []);
      candidates.push(...list);
    }

    if (candidates.length === 0) {
      return c.json({ data: { success: true, scanned: 0, breached: 0, alerted: 0 } });
    }

    // Pre-fetch active support team for fallback alert recipients
    const teamMembers = await svc.entities.SupportTeamMember.filter({ is_active: true }).catch(() => []);
    const teamEmails = teamMembers.map(m => m.user_email).filter(Boolean);

    const now = Date.now();
    let breachedCount = 0;
    let alertedCount = 0;

    for (const t of candidates) {
      const slaHrs = Number(t.sla_hours || 4);

      // First-response SLA — independent of resolution SLA.
      // Fires once per ticket if first_response_at is still null after the deadline.
      if (!t.first_response_at && !t.first_response_breached) {
        const frDue = t.first_response_due_at
          ? new Date(t.first_response_due_at).getTime()
          : new Date(t.created_date).getTime() + (Number(t.first_response_sla_hours || 1) * 3600000);
        if (Date.now() > frDue) {
          await svc.entities.SupportTicket.update(t.id, {
            first_response_breached: true
          }).catch(() => {});
          svc.entities.SupportTicketMessage.create({
            ticket_id: t.id,
            client_id: t.client_id || '',
            sender_type: 'system',
            sender_name: 'SLA Monitor',
            body_text: `First-response SLA breached — no agent reply within ${t.first_response_sla_hours || 1}h.`,
            channel: 'internal_note',
            is_internal_note: true,
            delivery_status: 'delivered'
          }).catch(() => {});
        }
      }

      // Anchor: the most recent of created_date / last_message_at (so a customer reply
      // restarts the clock when status goes back to in_progress / reopened).
      const anchorIso = t.last_message_at && new Date(t.last_message_at).getTime() > new Date(t.created_date).getTime()
        ? t.last_message_at
        : t.created_date;
      const ageHrs = ageHours(anchorIso);
      const isBreached = ageHrs > slaHrs;

      // Compute sla_deadline if missing
      const updates = {};
      if (!t.sla_deadline) {
        updates.sla_deadline = new Date(new Date(anchorIso).getTime() + slaHrs * 3600000).toISOString();
      }

      if (!isBreached) {
        if (Object.keys(updates).length) await svc.entities.SupportTicket.update(t.id, updates).catch(() => {});
        continue;
      }

      // Mark breach
      if (!t.sla_breached) {
        updates.sla_breached = true;
        updates.sla_breached_at = new Date().toISOString();
        breachedCount++;
      }

      // Throttled re-alert
      const lastAlert = t.sla_alert_sent_at ? new Date(t.sla_alert_sent_at).getTime() : 0;
      const shouldAlert = (now - lastAlert) >= RE_ALERT_COOLDOWN_MS;

      if (shouldAlert) {
        const recipients = new Set();
        if (t.assigned_to_email) recipients.add(t.assigned_to_email);
        // Always loop in active support team (managers/admins)
        teamEmails.forEach(e => recipients.add(e));

        const html = buildAlertHtml(t, ageHrs, slaHrs);
        await Promise.all([...recipients].map(to =>
          svc.functions.invoke('sendAcsSmtpEmail', {
            to,
            subject: `⚠ SLA Breach: ${t.ticket_number} — ${t.subject}`,
            html,
            from_name: 'Vaani Support Alerts'
          }).catch(e => console.error(`SLA alert to ${to} failed:`, e.message))
        ));

        // Internal note on the ticket
        svc.entities.SupportTicketMessage.create({
          ticket_id: t.id,
          client_id: t.client_id || '',
          sender_type: 'system',
          sender_email: 'system@vaaniai.in',
          sender_name: 'SLA Monitor',
          body_text: `SLA breached — ticket has been ${ageHrs.toFixed(1)}h in '${t.status}' (limit ${slaHrs}h). Alert sent to ${recipients.size} recipient(s).`,
          channel: 'internal_note',
          is_internal_note: true,
          delivery_status: 'delivered'
        }).catch(() => {});

        updates.sla_alert_sent_at = new Date().toISOString();
        alertedCount++;
      }

      if (Object.keys(updates).length) {
        await svc.entities.SupportTicket.update(t.id, updates).catch(e =>
          console.error(`SLA update ${t.id} failed:`, e.message)
        );
      }
    }

    return c.json({ data: {
      success: true,
      scanned: candidates.length,
      breached: breachedCount,
      alerted: alertedCount
    } });
  } catch (error) {
    console.error('checkSupportTicketSLA error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};