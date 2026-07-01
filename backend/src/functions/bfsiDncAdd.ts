import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Add a borrower phone to the client-scoped BFSI DNC list.
 *
 * Called when:
 *  - AI extracts a "do_not_call" outcome from a collections call
 *  - Borrower complains via WhatsApp / email
 *  - Admin manually flags via the Compliance page
 *
 * Idempotent: if the number is already on the list it just refreshes
 * is_active=true and updates the reason.
 */

function normalizePhone(phone) {
  let n = String(phone || '').replace(/\D/g, '');
  if (/^0\d{10}$/.test(n)) n = n.substring(1);
  if (/^91\d{10}$/.test(n)) n = n.substring(2);
  return n;
}

export default async function bfsiDncAdd(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const {
      client_id,
      phone,
      source = 'borrower_request',
      reason = '',
      loan_account_id = null,
      expires_in_days = null,
    } = body;

    if (!client_id || !phone) {
      return c.json({ data: { error: 'client_id and phone required' } }, 400);
    }

    // Ownership check: non-admins can only add to their own client
    if (user.role !== 'admin') {
      const owned = await base44.entities.Client.filter({ user_id: user.id, id: client_id });
      if (owned.length === 0) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const phoneNorm = normalizePhone(phone);
    const phoneE164 = phone.startsWith('+') ? phone : `+91${phoneNorm}`;
    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
      : null;

    // Check existing
    const existing = await base44.asServiceRole.entities.BfsiDncList.filter({
      client_id, phone_normalized: phoneNorm,
    });

    let record;
    if (existing.length > 0) {
      record = await base44.asServiceRole.entities.BfsiDncList.update(existing[0].id, {
        is_active: true,
        source,
        reason: reason || existing[0].reason,
        expires_at: expiresAt,
        added_by: user.email,
        loan_account_id: loan_account_id || existing[0].loan_account_id,
      });
    } else {
      record = await base44.asServiceRole.entities.BfsiDncList.create({
        client_id,
        phone_e164: phoneE164,
        phone_normalized: phoneNorm,
        source,
        reason,
        loan_account_id,
        expires_at: expiresAt,
        added_by: user.email,
        is_active: true,
      });
    }

    console.log(`[bfsiDncAdd] client=${client_id} phone_last4=${phoneNorm.slice(-4)} source=${source}`);
    return c.json({ data: { success: true, id: record.id } });
  } catch (error) {
    console.error('[bfsiDncAdd] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};