import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Enable/disable / rotate the public share token for a ticket.
// Only agents/admin can call.



export default async function toggleTicketShareLink(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    if (user.role !== 'admin') {
      const tm = await svc.entities.SupportTeamMember.filter({ user_email: user.email, is_active: true });
      if (!tm.length) return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    const { ticket_id, enable, rotate = false } = await c.req.json();
    if (!ticket_id) return c.json({ data: { error: 'ticket_id required' } }, 400);

    const ticket = await svc.entities.SupportTicket.get(ticket_id);
    if (!ticket) return c.json({ data: { error: 'Not found' } }, 404);

    const updates = { share_enabled: !!enable };
    if (enable && (!ticket.share_token || rotate)) {
      updates.share_token = crypto.randomUUID().replace(/-/g, '');
    }
    await svc.entities.SupportTicket.update(ticket_id, updates);

    return c.json({ data: {
      success: true,
      share_enabled: updates.share_enabled,
      share_token: updates.share_token || ticket.share_token || ''
    } });
  } catch (e) {
    return c.json({ data: { error: e.message } }, 500);
  }

};