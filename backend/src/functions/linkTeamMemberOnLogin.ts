import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Called early in the client app (Layout/Onboarding) for the current user.
// If the user has a pending TeamInvite, link them to that client account by
// setting user.client_id + team_role='member' and marking the invite accepted.
// Returns { linked, client_id, team_role } so the frontend knows to skip
// onboarding for invited members.
export default async function linkTeamMemberOnLogin(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    // Already linked
    if (user.client_id) {
      return c.json({ data: { linked: true, client_id: user.client_id, team_role: user.team_role || 'member' } });
    }

    // Owners (have their own client) are not team members
    const owned = await base44.asServiceRole.entities.Client.filter({ user_id: user.id });
    if (owned.length > 0) {
      return c.json({ data: { linked: false, is_owner: true } });
    }

    // Look for a pending invite matching this email
    const email = (user.email || '').toLowerCase();
    const invites = await base44.asServiceRole.entities.TeamInvite.filter({
      email,
      status: 'pending',
    });
    if (invites.length === 0) {
      return c.json({ data: { linked: false } });
    }

    const invite = invites[0];
    // Link the user to the client account
    await base44.asServiceRole.entities.User.update(user.id, {
      client_id: invite.client_id,
      team_role: 'member',
    });
    await base44.asServiceRole.entities.TeamInvite.update(invite.id, {
      status: 'accepted',
      accepted_at: new Date().toISOString(),
    });

    return c.json({ data: { linked: true, client_id: invite.client_id, team_role: 'member' } });
  } catch (error) {
    console.error('linkTeamMemberOnLogin error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};