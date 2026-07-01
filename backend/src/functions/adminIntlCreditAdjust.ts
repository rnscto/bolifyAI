import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// adminIntlCreditAdjust — Admin-only manual management of a US/UK client's
// minute credits + per-minute rate settings.
//
// Actions (body.action):
//   • "topup"        → add free/paid minutes to the client's allowance.
//                      Increases minutes_included (the monthly pool) by `minutes`.
//                      Logs a Payment ledger row (status 'paid' for paid, 'refunded'
//                      label is not used — we use description.type='minute_topup').
//   • "deduct"       → manually subtract minutes from minutes_used_this_period
//                      (e.g. to reverse a mischarge). Floors at 0.
//   • "set_rates"    → update overage_rate and/or minutes_included to new values.
//   • "reset_period" → reset minutes_used_this_period to 0 and advance period start.
//
// Every action writes an audit row into the Payment entity (description JSON)
// so the dialog can render a full credit/top-up history. No Stripe call here —
// these are admin grants/corrections, not card charges.
//
// Auth: caller MUST be an admin (user.role === 'admin'); else 403.
// ═══════════════════════════════════════════════════════════════════════



export default async function adminIntlCreditAdjust(c: any) {
  const req = c.req.raw || c.req;
  try {
    if (req.method !== 'POST') return c.json({ data: { error: 'POST only' } }, 405);

    /* const base44 = ... */;
    const user = c.get('jwtPayload').catch(() => null);
    if (!user || user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }
    const svc = base44.asServiceRole;

    const body = await c.req.json().catch(() => ({}));
    const { client_id, action } = body;
    if (!client_id || !action) {
      return c.json({ data: { error: 'client_id and action required' } }, 400);
    }

    const client = await svc.entities.Client.get(client_id).catch(() => null);
    if (!client) return c.json({ data: { error: 'Client not found' } }, 404);
    if (client.region !== 'US' && client.region !== 'UK') {
      return c.json({ data: { error: 'Only US/UK clients have minute-based billing' } }, 400);
    }

    const now = new Date().toISOString();
    const currency = client.currency || 'USD';
    let update = {};
    let ledger = null;

    if (action === 'topup') {
      const minutes = Number(body.minutes || 0);
      if (minutes <= 0) return c.json({ data: { error: 'minutes must be > 0' } }, 400);
      const amount = Number(body.amount || 0); // optional charge amount (0 = free grant)
      update.minutes_included = Number(client.minutes_included || 0) + minutes;
      ledger = {
        client_id,
        amount,
        currency,
        status: 'paid',
        paid_at: now,
        description: JSON.stringify({
          type: 'minute_topup',
          minutes,
          paid: amount > 0,
          by: user.email,
          note: body.note || '',
          new_minutes_included: update.minutes_included,
        }),
      };
    } else if (action === 'deduct') {
      const minutes = Number(body.minutes || 0);
      if (minutes <= 0) return c.json({ data: { error: 'minutes must be > 0' } }, 400);
      update.minutes_used_this_period = Math.max(0, Number(client.minutes_used_this_period || 0) - minutes);
      ledger = {
        client_id,
        amount: 0,
        currency,
        status: 'paid',
        paid_at: now,
        description: JSON.stringify({
          type: 'minute_deduct',
          minutes,
          by: user.email,
          note: body.note || '',
          new_minutes_used: update.minutes_used_this_period,
        }),
      };
    } else if (action === 'set_rates') {
      if (body.overage_rate !== undefined && body.overage_rate !== null && body.overage_rate !== '') {
        update.overage_rate = Number(body.overage_rate);
      }
      if (body.minutes_included !== undefined && body.minutes_included !== null && body.minutes_included !== '') {
        update.minutes_included = Number(body.minutes_included);
      }
      if (Object.keys(update).length === 0) {
        return c.json({ data: { error: 'Nothing to update' } }, 400);
      }
      ledger = {
        client_id,
        amount: 0,
        currency,
        status: 'paid',
        paid_at: now,
        description: JSON.stringify({
          type: 'rate_change',
          by: user.email,
          note: body.note || '',
          overage_rate: update.overage_rate ?? client.overage_rate,
          minutes_included: update.minutes_included ?? client.minutes_included,
        }),
      };
    } else if (action === 'reset_period') {
      update.minutes_used_this_period = 0;
      update.minutes_period_start = now;
      ledger = {
        client_id,
        amount: 0,
        currency,
        status: 'paid',
        paid_at: now,
        description: JSON.stringify({
          type: 'period_reset',
          by: user.email,
          note: body.note || '',
        }),
      };
    } else {
      return c.json({ data: { error: `Unknown action: ${action}` } }, 400);
    }

    await svc.entities.Client.update(client_id, update);
    if (ledger) await svc.entities.Payment.create(ledger).catch((e) =>
      console.error('[adminIntlCreditAdjust] ledger write failed:', e.message));

    console.log(`[adminIntlCreditAdjust] ${action} for ${client.company_name} by ${user.email}`);
    return c.json({ data: { success: true, action, update } });
  } catch (error) {
    console.error('[adminIntlCreditAdjust] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};