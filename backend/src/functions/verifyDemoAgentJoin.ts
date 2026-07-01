import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Verifies that the current user is allowed to join a demo room as a HUMAN agent.
// Only active Support Team members (or admins) may join. Looks up the booking by
// room_token and returns a sanitized booking + agent identity for the live UI.


export default async function verifyDemoAgentJoin(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload').catch(() => null);
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const url = new URL(req.url);
    const body = req.method === 'POST' ? await c.req.json().catch(() => ({})) : {};
    const token = body.token || url.searchParams.get('token');
    if (!token) return c.json({ data: { error: 'Missing token' } }, 400);

    // Authorization: platform admin OR active SupportTeamMember
    let authorized = user.role === 'admin';
    let supportRole = null;
    if (!authorized) {
      const members = await base44.entities.SupportTeamMember.filter({ user_email: user.email, is_active: true });
      if (members.length > 0) {
        authorized = true;
        supportRole = members[0].support_role;
      }
    }
    if (!authorized) {
      return c.json({ data: { error: 'Only Vaani admins or Support Team members can join demos as a human agent.' } }, 403);
    }

    const matches = await base44.entities.DemoBooking.filter({ room_token: token });
    if (!matches.length) return c.json({ data: { error: 'Invalid token' } }, 404);
    const b = matches[0];

    if (['cancelled', 'expired', 'completed'].includes(b.status)) {
      return c.json({ data: { error: `Demo is ${b.status}` } }, 410);
    }

    // Mark human handoff requested so analytics + audit trail reflect agent presence
    if (!b.human_handoff_requested) {
      await base44.entities.DemoBooking.update(b.id, {
        human_handoff_requested: true,
        human_handoff_at: new Date().toISOString()
      }).catch(() => {});
    }

    const relayUrl = Deno.env.get('GEMINI_RELAY_WS_URL') || '';

    const safe = {
      id: b.id, booking_code: b.booking_code, lead_name: b.lead_name, lead_email: b.lead_email,
      lead_phone: b.lead_phone, company_name: b.company_name, focus_area: b.focus_area,
      language: b.language, scheduled_at: b.scheduled_at, duration_minutes: b.duration_minutes,
      status: b.status, room_token: b.room_token
    };

    return c.json({ data: {
      success: true,
      booking: safe,
      relay_url: relayUrl,
      agent: { email: user.email, name: user.full_name, role: user.role === 'admin' ? 'admin' : supportRole }
    } });
  } catch (e) {
    return c.json({ data: { error: e.message } }, 500);
  }

};