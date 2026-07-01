import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Entity automation: fires when a new DemoBooking is created.
// Sends a Telegram alert to the Vaani sales team so they can prepare or join the call.
// Uses TELEGRAM_BOT_TOKEN secret + the client owner's telegram_chat_id from the Vaani internal tenant.
// Silently skips if Telegram isn't configured.



const TENANT_NAME = 'Vaani Internal Sales';

function fmtIST(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric',
      month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
    }) + ' IST';
  } catch { return iso; }
}

export default async function notifyVaaniDemoBooked(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const body = await c.req.json().catch(() => ({}));

    const bookingId = body.event?.entity_id;
    if (!bookingId) return c.json({ data: { skipped: 'no_id' } });

    const booking = body.data || await svc.entities.DemoBooking.get(bookingId).catch(() => null);
    if (!booking) return c.json({ data: { skipped: 'not_found' } });

    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!token) return c.json({ data: { skipped: 'no_telegram_token' } });

    // Find Vaani tenant chat id
    const clients = await svc.entities.Client.filter({ company_name: TENANT_NAME });
    const chatId = clients[0]?.telegram_chat_id;
    if (!chatId) return c.json({ data: { skipped: 'no_chat_id' } });

    const text = [
      '🎤 *New Vaani Demo Booked*',
      '',
      `*Code:* ${booking.booking_code || bookingId}`,
      `*When:* ${fmtIST(booking.scheduled_at)}`,
      `*Lead:* ${booking.lead_name || '—'} (${booking.lead_email})`,
      booking.lead_phone ? `*Phone:* ${booking.lead_phone}` : '',
      booking.company_name ? `*Company:* ${booking.company_name}` : '',
      booking.focus_area ? `*Focus:* ${booking.focus_area}` : '',
      `*Source:* ${booking.source || 'website'}`,
    ].filter(Boolean).join('\n');

    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('Telegram alert failed:', errText.substring(0, 200));
    }

    // Fan out per-recipient email to Support Team (handles_categories: sales)
    svc.functions.invoke('notifySupportTeamDemo', {
      kind: 'new_booking',
      booking_id: bookingId,
      data: booking
    }).catch(e => console.error('support team email failed', e?.message));

    return c.json({ data: { success: true } });
  } catch (error) {
    console.error('notifyVaaniDemoBooked error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};