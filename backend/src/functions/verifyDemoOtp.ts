import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Verify the OTP sent by sendDemoOtp. On success, returns a short-lived verification_token
// that the BookDemo form passes to createDemoBooking as proof the email was verified.
//
// Payload: { lead_email, otp }
// Returns: { success: true, verification_token } OR { error }



const MAX_ATTEMPTS = 5;
const VERIFICATION_TOKEN_TTL_MINUTES = 30; // token valid for 30 min after OTP verify

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function verifyDemoOtp(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const { lead_email, otp } = await c.req.json();

    if (!lead_email || !otp) {
      return c.json({ data: { error: 'Email and OTP required' } }, 400);
    }
    const email = String(lead_email).trim().toLowerCase();
    const otpStr = String(otp).trim();
    if (!/^\d{6}$/.test(otpStr)) {
      return c.json({ data: { error: 'OTP must be 6 digits' } }, 400);
    }

    // Find the most recent un-invalidated OTP for this email
    const records = await svc.entities.DemoOtpVerification.filter({ email }).catch(() => []);
    const active = records
      .filter(r => !r.invalidated && !r.verified)
      .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0];

    if (!active) {
      return c.json({ data: { error: 'No active code. Please request a new one.' } }, 400);
    }
    if (new Date(active.expires_at) < new Date()) {
      await svc.entities.DemoOtpVerification.update(active.id, { invalidated: true }).catch(() => {});
      return c.json({ data: { error: 'Code expired. Please request a new one.' } }, 400);
    }
    if ((active.attempts || 0) >= MAX_ATTEMPTS) {
      await svc.entities.DemoOtpVerification.update(active.id, { invalidated: true }).catch(() => {});
      return c.json({ data: { error: 'Too many incorrect attempts. Please request a new code.' } }, 429);
    }

    const otpHash = await sha256(otpStr);
    if (otpHash !== active.otp_hash) {
      await svc.entities.DemoOtpVerification.update(active.id, {
        attempts: (active.attempts || 0) + 1
      }).catch(() => {});
      const remaining = MAX_ATTEMPTS - ((active.attempts || 0) + 1);
      return c.json({ data: {
        error: `Incorrect code.${remaining > 0 ? ` ${remaining} attempt${remaining > 1 ? 's' : ''} left.` : ''}`
      } }, 400);
    }

    // ✅ Correct — mint a verification token
    const verificationToken = crypto.randomUUID().replace(/-/g, '');
    const tokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();

    await svc.entities.DemoOtpVerification.update(active.id, {
      verified: true,
      verified_at: new Date().toISOString(),
      verification_token: verificationToken,
      token_expires_at: tokenExpiresAt
    });

    return c.json({ data: {
      success: true,
      verification_token: verificationToken,
      expires_in: VERIFICATION_TOKEN_TTL_MINUTES * 60
    } });
  } catch (error) {
    console.error('verifyDemoOtp error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};