import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Public endpoint: fetch a demo booking by room_token (used by DemoRoom page).
// Enforces expiry and tracks first-join timestamp.



export default async function getDemoBooking(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Public endpoint: lead is not authenticated. Use the user-scoped client
    // directly (no asServiceRole) — DemoBooking is accessed by room_token which
    // is itself the authorization mechanism for this public lead-facing flow.
    /* const base44 = ... */;
    const svc = base44;

    const url = new URL(req.url);
    const token = url.searchParams.get('token') || (await c.req.json().catch(() => ({}))).token;
    if (!token) return c.json({ data: { error: 'token required' } }, 400);

    const matches = await svc.entities.DemoBooking.filter({ room_token: token });
    if (!matches.length) return c.json({ data: { error: 'Booking not found' } }, 404);
    const booking = matches[0];

    const now = Date.now();
    const start = new Date(booking.scheduled_at).getTime();
    const end = start + (booking.duration_minutes || 30) * 60 * 1000;

    // Hard expiry check
    if (booking.expires_at && new Date(booking.expires_at).getTime() < now) {
      if (booking.status === 'scheduled') {
        svc.entities.DemoBooking.update(booking.id, { status: 'expired' }).catch(() => {});
      }
      return c.json({ data: { error: 'This demo link has expired. Please book a new slot.', expired: true } });
    }
    if (booking.status === 'cancelled') return c.json({ data: { error: 'This demo was cancelled.', cancelled: true } });
    if (booking.status === 'expired') return c.json({ data: { error: 'This demo link has expired.', expired: true } });
    if (booking.status === 'completed') return c.json({ data: { error: 'This demo has already ended.', completed: true } });

    const joinable = now >= start - 10 * 60 * 1000 && now <= end + 30 * 60 * 1000;
    const tooEarly = now < start - 10 * 60 * 1000;

    // Track first-join (lead opened the room page)
    if (!booking.joined_at && now >= start - 30 * 60 * 1000) {
      svc.entities.DemoBooking.update(booking.id, { joined_at: new Date().toISOString() }).catch(() => {});
    }

    const safe = {
      id: booking.id, booking_code: booking.booking_code,
      lead_name: booking.lead_name, lead_email: booking.lead_email,
      company_name: booking.company_name, focus_area: booking.focus_area,
      language: booking.language, scheduled_at: booking.scheduled_at,
      duration_minutes: booking.duration_minutes, status: booking.status,
      started_at: booking.started_at, ended_at: booking.ended_at,
      recording_consent: booking.recording_consent
    };

    let relayUrl = Deno.env.get('DEMO_RELAY_WS_URL') || '';
    if (!relayUrl) {
      try {
        const res = await svc.functions.invoke('streamGeminiDemo', {});
        relayUrl = res?.data?.ws_url || '';
      } catch (e) {
        console.error('[getDemoBooking] relay discovery failed', e);
      }
    }

    return c.json({ data: {
      success: true,
      booking: { ...safe, room_token: booking.room_token },
      joinable, too_early: tooEarly,
      seconds_until_start: Math.max(0, Math.floor((start - now) / 1000)),
      relay_url: relayUrl
    } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};