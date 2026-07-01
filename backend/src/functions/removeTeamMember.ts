import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Owner-only. Either revokes a pending invite (invite_id) or removes an
// existing team member (member_user_id) by unlinking them from the client.
export default async function removeTeamMember(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { invite_id, member_user_id } = await c.req.json();

    // Resolve caller's client + owner check
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
    if (!isOwner) {
      return c.json({ data: { error: 'Only the account owner can manage team members' } }, 403);
    }

    if (invite_id) {
      const invite = await base44.asServiceRole.entities.TeamInvite.get(invite_id).catch(() => null);
      if (!invite || invite.client_id !== client.id) {
        return c.json({ data: { error: 'Invite not found' } }, 404);
      }
      await base44.asServiceRole.entities.TeamInvite.update(invite_id, { status: 'revoked' });
      return c.json({ data: { success: true } });
    }

    if (member_user_id) {
      if (member_user_id === client.user_id) {
        return c.json({ data: { error: 'Cannot remove the account owner' } }, 400);
      }
      const member = await base44.asServiceRole.entities.User.get(member_user_id).catch(() => null);
      if (!member || member.client_id !== client.id) {
        return c.json({ data: { error: 'Member not found' } }, 404);
      }
      // Unlink from the client
      await base44.asServiceRole.entities.User.update(member_user_id, {
        client_id: null,
        team_role: 'owner',
      });
      return c.json({ data: { success: true } });
    }

    return c.json({ data: { error: 'invite_id or member_user_id required' } }, 400);
  } catch (error) {
    console.error('removeTeamMember error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};