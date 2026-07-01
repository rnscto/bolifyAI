import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Returns the team for the caller's client account:
// - members: User records linked to this client (plus the owner)
// - pendingInvites: TeamInvite rows still pending
export default async function listTeamMembers(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    // Resolve caller's client
    let client = null;
    const owned = await base44.asServiceRole.entities.Client.filter({ user_id: user.id });
    if (owned.length > 0) {
      client = owned[0];
    } else if (user.client_id) {
      client = await base44.asServiceRole.entities.Client.get(user.client_id).catch(() => null);
    }
    if (!client) {
      return c.json({ data: { error: 'No client account found' } }, 403);
    }

    const isOwner = client.user_id === user.id || user.team_role === 'owner';

    // Members: the owner + any users with client_id = client.id
    const linkedUsers = await base44.asServiceRole.entities.User.filter({ client_id: client.id });
    const ownerUser = client.user_id
      ? await base44.asServiceRole.entities.User.get(client.user_id).catch(() => null)
      : null;

    const members = [];
    if (ownerUser) {
      members.push({
        id: ownerUser.id,
        full_name: ownerUser.full_name,
        email: ownerUser.email,
        team_role: 'owner',
      });
    }
    for (const u of linkedUsers) {
      if (ownerUser && u.id === ownerUser.id) continue;
      members.push({
        id: u.id,
        full_name: u.full_name,
        email: u.email,
        team_role: u.team_role || 'member',
      });
    }

    const pending = await base44.asServiceRole.entities.TeamInvite.filter({
      client_id: client.id,
      status: 'pending',
    });

    return c.json({ data: {
      is_owner: isOwner,
      members,
      pendingInvites: pending.map(p => ({
        id: p.id,
        email: p.email,
        invited_by_email: p.invited_by_email,
        created_date: p.created_date,
      })),
    } });
  } catch (error) {
    console.error('listTeamMembers error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};