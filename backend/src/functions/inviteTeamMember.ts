import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Lets a client account OWNER invite a team member to their portal.
// - Verifies the caller owns a Client account (or is its owner team member).
// - Sends a platform invite (role "user").
// - Records a pending TeamInvite so the member is auto-linked to this client
//   on their first login (see linkTeamMemberOnLogin).
export default async function inviteTeamMember(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { email } = await c.req.json();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return c.json({ data: { error: 'A valid email is required' } }, 400);
    }
    const cleanEmail = email.trim().toLowerCase();

    // Resolve the caller's client account.
    // Owner = client.user_id === user.id; team members carry user.client_id.
    let client = null;
    const owned = await base44.asServiceRole.entities.Client.filter({ user_id: user.id });
    if (owned.length > 0) {
      client = owned[0];
    } else if (user.client_id) {
      client = await base44.asServiceRole.entities.Client.get(user.client_id).catch(() => null);
    }
    if (!client) {
      return c.json({ data: { error: 'No client account found for this user' } }, 403);
    }

    // Only owners may invite (team members can't invite others).
    const isOwner = client.user_id === user.id || user.team_role === 'owner';
    if (!isOwner) {
      return c.json({ data: { error: 'Only the account owner can invite team members' } }, 403);
    }

    if (cleanEmail === (user.email || '').toLowerCase()) {
      return c.json({ data: { error: 'You cannot invite yourself' } }, 400);
    }

    // Avoid duplicate pending invites
    const existing = await base44.asServiceRole.entities.TeamInvite.filter({
      client_id: client.id,
      email: cleanEmail,
      status: 'pending',
    });
    if (existing.length > 0) {
      return c.json({ data: { error: 'An invite is already pending for this email' } }, 409);
    }

    // NOTE: We intentionally do NOT call base44.users.inviteUser() here — that
    // sends a generic Base44-branded email from notifications.base44.com.
    // Instead we send our own VaaniAI-branded email below, and the invitee
    // self-registers at /register. linkTeamMemberOnLogin then auto-links them
    // to this client account by matching their email to the pending TeamInvite.

    // Record the pending invite for auto-linking on first login
    const invite = await base44.asServiceRole.entities.TeamInvite.create({
      client_id: client.id,
      email: cleanEmail,
      invited_by_email: user.email,
      status: 'pending',
    });

    // Send our OWN VaaniAI-branded invite email (from the platform's
    // Resend identity — noreply@vaaniai.io — not a generic Base44 email).
    const appOrigin = req.headers.get('origin') || 'https://app.vaaniai.io';
    const loginUrl = `${appOrigin.replace(/\/$/, '')}/register`;
    const inviterName = user.full_name || user.email;
    const companyName = client.company_name || 'their team';
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;">
        <div style="background:#1e3a5f;padding:28px;text-align:center;border-radius:12px 12px 0 0;">
          <img src="https://media.base44.com/images/public/698823c19043e168a5daaa86/00fe0d8ce_vaani-removebg-preview.png" alt="VaaniAI" style="height:54px;object-fit:contain;" />
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:32px;">
          <h1 style="font-size:20px;margin:0 0 12px;">You've been invited to VaaniAI</h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            <strong>${inviterName}</strong> has invited you to join <strong>${companyName}</strong> on VaaniAI —
            the AI voice agent platform that automates calls, qualifies leads and follows up on autopilot.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">
            Click below to set up your account and start collaborating.
          </p>
          <a href="${loginUrl}" style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
            Accept invite & sign up
          </a>
          <p style="font-size:12px;color:#9ca3af;margin:28px 0 0;">
            If you weren't expecting this invitation, you can safely ignore this email.
          </p>
        </div>
        <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:16px;">© ${new Date().getFullYear()} TBB VaaniAI. All rights reserved.</p>
      </div>`;

    await base44.asServiceRole.functions.invoke('sendAcsSmtpEmail', {
      to: cleanEmail,
      subject: `${inviterName} invited you to join VaaniAI`,
      html,
      from_name: 'VaaniAI',
    }).catch((e) => console.error('Branded invite email failed:', e?.message));

    return c.json({ data: { success: true, invite_id: invite.id } });
  } catch (error) {
    console.error('inviteTeamMember error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};