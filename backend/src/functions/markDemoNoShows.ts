import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Cron-callable: marks scheduled demos as 'no_show' if their slot ended >30 min ago
// and the lead never joined. Designed to run every 15 minutes once automations are re-enabled.
// Admin-only via CRON_API_KEY header for now.



export default async function markDemoNoShows(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // Auth: allow admin user OR CRON_API_KEY header
    const cronKey = req.headers.get('x-cron-key');
    const expected = Deno.env.get('CRON_API_KEY');
    let authed = !!(cronKey && expected && cronKey === expected);
    if (!authed) {
      try {
        const user = c.get('jwtPayload');
        if (user?.role === 'admin') authed = true;
      } catch (_) {}
    }
    if (!authed) return c.json({ data: { error: 'Forbidden' } }, 403);

    const now = Date.now();
    const scheduled = await svc.entities.DemoBooking.filter({ status: 'scheduled' });

    let marked = 0;
    for (const b of scheduled) {
      const end = new Date(b.scheduled_at).getTime() + (b.duration_minutes || 30) * 60 * 1000;
      // Demo window closed >30 min ago AND nobody joined
      if (now > end + 30 * 60 * 1000 && !b.joined_at && !b.started_at) {
        await svc.entities.DemoBooking.update(b.id, { status: 'no_show' }).catch(() => {});
        marked++;
        // Notify sales rep so they can follow up
        if (b.cc_sales_emails?.length) {
          svc.functions.invoke('sendAcsSmtpEmail', {
            to: b.cc_sales_emails,
            subject: `[No-show] ${b.lead_name || b.lead_email} — ${b.booking_code}`,
            html: `<p>${b.lead_name || b.lead_email} did not join their demo scheduled for ${new Date(b.scheduled_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.</p><p>Suggest a manual follow-up.</p>`,
            from_name: 'Vaani AI'
          }).catch(() => {});
        }
      }
    }

    return c.json({ data: { success: true, marked, scanned: scheduled.length } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};