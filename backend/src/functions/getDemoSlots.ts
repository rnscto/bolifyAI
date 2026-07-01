import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Returns available 30-min demo slots for the next N days.
// Business rules: 7 days/week (AI never sleeps), 09:00-21:00 IST, excludes already-booked slots.
// Public endpoint — no auth required (used by website "Book a Demo" page).



const SLOT_MINUTES = 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30
const START_HOUR_IST = 9;
const END_HOUR_IST = 21; // last slot starts at 20:30

function istParts(dateUtc) {
  const ist = new Date(dateUtc.getTime() + IST_OFFSET_MS);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth(),
    day: ist.getUTCDate(),
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    dow: ist.getUTCDay() // 0=Sun
  };
}

function buildSlotsForDay(istY, istM, istD) {
  // Build UTC Date objects representing slot starts on this IST calendar day
  const slots = [];
  for (let h = START_HOUR_IST; h < END_HOUR_IST; h++) {
    for (const m of [0, 30]) {
      // Construct UTC time = IST time - 5:30
      const utcMs = Date.UTC(istY, istM, istD, h, m, 0) - IST_OFFSET_MS;
      slots.push(new Date(utcMs));
    }
  }
  return slots;
}

export default async function getDemoSlots(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Public endpoint — no auth. Access is read-only on scheduled bookings (no secrets exposed).
    const svc = base44;;

    const url = new URL(req.url);
    const daysAhead = Math.min(parseInt(url.searchParams.get('days') || '14', 10), 30);

    const now = new Date();
    const earliest = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour buffer

    // Collect candidate days (IST)
    const candidateDays = [];
    for (let i = 0; i < daysAhead; i++) {
      const ref = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const p = istParts(ref);
      // AI demo agent runs 7 days/week — no weekend skip
      candidateDays.push({ y: p.year, m: p.month, d: p.day });
    }

    // Fetch already-booked slots in this window
    const existing = await svc.entities.DemoBooking.filter({
      status: 'scheduled'
    }).catch(() => []);
    const bookedTimes = new Set(
      existing
        .filter(b => b.scheduled_at)
        .map(b => new Date(b.scheduled_at).getTime())
    );

    const grouped = [];
    for (const day of candidateDays) {
      const slots = buildSlotsForDay(day.y, day.m, day.d)
        .filter(s => s > earliest)
        .filter(s => !bookedTimes.has(s.getTime()))
        .map(s => ({
          iso: s.toISOString(),
          label_ist: new Date(s.getTime() + IST_OFFSET_MS).toISOString().substring(11, 16) + ' IST'
        }));
      if (slots.length === 0) continue;
      const istDay = new Date(Date.UTC(day.y, day.m, day.d));
      grouped.push({
        date_iso: istDay.toISOString().substring(0, 10),
        date_label: istDay.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
        slots
      });
    }

    return c.json({ data: { success: true, slot_minutes: SLOT_MINUTES, days: grouped } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};