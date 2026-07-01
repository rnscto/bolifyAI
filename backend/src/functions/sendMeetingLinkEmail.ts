import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Sends the Google Meet / calendar invite link for an already-scheduled demo
// activity to the lead (and cc's the client owner). Triggered by
// postCallActionExtractor when the AI detects "send/resend meeting link" intent.
//
// Payload options:
//   { activity_id }     — send link for this specific demo/meeting activity
//   { lead_id }         — find the most recent upcoming demo/meeting activity for this lead
//
// Returns { success, sent_to, meet_link, activity_id } or { skipped, reason }.


import { EmailClient } from 'npm:@azure/communication-email@1.0.0';

const connStr = `endpoint=${Deno.env.get('AZURE_COMM_ENDPOINT')};accesskey=${Deno.env.get('AZURE_COMM_KEY')}`;
const emailClient = new EmailClient(connStr);

function formatISTDateTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric',
      month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    }) + ' IST';
  } catch { return isoStr; }
}

function buildHtml({ leadName, companyName, activityTitle, scheduledDateIST, meetLink, calendarLink, companyPhone }) {
  const color = '#2563eb';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:linear-gradient(135deg,${color},${color}dd);border-radius:16px 16px 0 0;padding:28px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:24px;">📅 Meeting Link</h1>
    <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">${companyName}</p>
  </div>
  <div style="background:#fff;padding:32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
    <p style="color:#1f2937;font-size:16px;line-height:1.6;margin:0 0 16px;">Dear ${leadName || 'Sir/Madam'},</p>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 20px;">As requested, here is the meeting link for <strong>${activityTitle}</strong>.</p>

    <div style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border-radius:12px;padding:20px;margin:20px 0;border:2px dashed #10b981;">
      <p style="color:#065f46;font-size:14px;margin:0 0 6px;"><strong>🕒 Scheduled:</strong></p>
      <p style="color:#047857;font-size:16px;margin:0 0 16px;font-weight:600;">${scheduledDateIST || 'To be confirmed'}</p>
      ${meetLink ? `<a href="${meetLink}" style="display:inline-block;background:#10b981;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">🎥 Join Google Meet</a>` : ''}
      ${meetLink ? `<p style="color:#065f46;font-size:12px;margin:12px 0 0;word-break:break-all;">${meetLink}</p>` : ''}
    </div>

    ${calendarLink ? `<p style="color:#6b7280;font-size:14px;margin:16px 0;">📅 <a href="${calendarLink}" style="color:${color};">Add to your Google Calendar</a></p>` : ''}

    <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:24px 0 0;">If you have any questions, please reply to this email or call us at ${companyPhone || 'the number below'}.</p>
    <p style="color:#374151;font-size:14px;margin:12px 0 0;">Looking forward to meeting you!</p>
  </div>
  <div style="background:#1f2937;border-radius:0 0 16px 16px;padding:20px;text-align:center;">
    <p style="color:#9ca3af;font-size:12px;margin:0;">${companyName} ${companyPhone ? '• 📞 ' + companyPhone : ''}</p>
    <p style="color:#6b7280;font-size:11px;margin:6px 0 0;">Powered by VaaniAI</p>
  </div>
</div></body></html>`;
}

async function sendLeadEmail({ to, cc, fromName, subject, html }) {
  const message = {
    senderAddress: 'DoNotReply@vaaniai.io',
    displayName: fromName || 'VaaniAI',
    content: { subject, html },
    recipients: {
      to: [{ address: to }],
      ...(cc && cc !== to ? { cc: [{ address: cc }] } : {})
    }
  };
  const poller = await emailClient.beginSend(message);
  const result = await poller.pollUntilDone();
  if (result.status !== 'Succeeded') throw new Error(`ACS Email error: ${result.error?.message || result.status}`);
  return result;
}

export default async function sendMeetingLinkEmail(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json();
    const { activity_id, lead_id, email_activity_id } = body;

    // 1. Resolve the demo activity (the one with the Meet link).
    // The Meet link is generated asynchronously by createCalendarEvent, so it may
    // not be saved on the activity for a second or two after this is invoked.
    // Retry a few times (re-fetching) before giving up — fixes the race where the
    // link existed but wasn't readable yet on the first lookup.
    const resolveDemoActivity = async () => {
      if (activity_id) {
        return await base44.entities.Activity.get(activity_id).catch(() => null);
      }
      if (lead_id) {
        const activities = await base44.entities.Activity.filter({ lead_id });
        const candidates = activities
          .filter(a => ['demo', 'meeting', 'appointment'].includes(a.type) && a.meet_link)
          .sort((a, b) => new Date(b.scheduled_date) - new Date(a.scheduled_date));
        return candidates[0] || null;
      }
      return null;
    };

    let demoActivity = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      demoActivity = await resolveDemoActivity();
      if (demoActivity?.meet_link) break;
      // Wait for createCalendarEvent to finish saving the meet_link, then retry.
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!demoActivity) {
      return c.json({ data: { skipped: true, reason: 'no_demo_activity_with_meet_link' } });
    }
    if (!demoActivity.meet_link) {
      return c.json({ data: { skipped: true, reason: 'demo_activity_has_no_meet_link', activity_id: demoActivity.id } });
    }

    // 2. Load lead + client
    const lead = demoActivity.lead_id ? await base44.entities.Lead.get(demoActivity.lead_id).catch(() => null) : null;
    if (!lead?.email) {
      return c.json({ data: { skipped: true, reason: 'lead_has_no_email', lead_name: lead?.name } });
    }
    const client = await base44.entities.Client.get(demoActivity.client_id).catch(() => null);

    // 3. Send email
    const scheduledIST = formatISTDateTime(demoActivity.scheduled_date);
    const subject = `Meeting Link: ${demoActivity.title || 'Your scheduled demo'} — ${scheduledIST}`;
    const html = buildHtml({
      leadName: lead.name,
      companyName: client?.company_name || 'VaaniAI',
      activityTitle: demoActivity.title || 'your scheduled meeting',
      scheduledDateIST: scheduledIST,
      meetLink: demoActivity.meet_link,
      calendarLink: demoActivity.google_calendar_link,
      companyPhone: client?.phone || ''
    });

    await sendLeadEmail({
      to: lead.email,
      cc: client?.email,
      fromName: client?.company_name || 'VaaniAI',
      subject,
      html
    });

    // 4. Log outreach
    await base44.entities.OutreachLog.create({
      client_id: demoActivity.client_id,
      lead_id: demoActivity.lead_id,
      call_log_id: demoActivity.call_log_id || null,
      channel: 'email',
      recipient_email: lead.email,
      subject,
      body: `Meeting link sent: ${demoActivity.meet_link} for ${demoActivity.title}`,
      outreach_type: 'meeting_link',
      status: 'sent'
    }).catch(e => console.warn(`[sendMeetingLinkEmail] OutreachLog create failed: ${e.message}`));

    // 5. Mark the email activity as completed (so it doesn't stay "scheduled/overdue")
    if (email_activity_id) {
      await base44.entities.Activity.update(email_activity_id, {
        status: 'completed',
        completed_date: new Date().toISOString(),
        outcome: `Meeting link emailed to ${lead.email}`
      }).catch(() => {});
    }

    console.log(`[sendMeetingLinkEmail] ✅ Sent meet link ${demoActivity.meet_link} to ${lead.email} (lead ${lead.name})`);
    return c.json({ data: {
      success: true,
      sent_to: lead.email,
      cc: client?.email || null,
      meet_link: demoActivity.meet_link,
      activity_id: demoActivity.id,
      scheduled: scheduledIST
    } });
  } catch (error) {
    console.error('[sendMeetingLinkEmail] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};