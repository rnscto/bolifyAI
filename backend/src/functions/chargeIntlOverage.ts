import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// chargeIntlOverage — Charge a client for over-the-cap minute usage.
// Called by resetMonthlyMinutes at the end of each 30-day billing period.
//
// Creates a Stripe Invoice Item against the client's Stripe customer,
// which auto-bills with the next subscription invoice cycle.
// ═══════════════════════════════════════════════════════════════════════


import Stripe from 'npm:stripe@17.5.0';

export default async function chargeIntlOverage(c: any) {
  const req = c.req.raw || c.req;
  try {
    if (req.method !== 'POST') return c.json({ data: { error: 'POST only' } }, 405);

    const { client_id, over_minutes, period_start, period_end } = await c.req.json();
    if (!client_id || !over_minutes || over_minutes <= 0) {
      return c.json({ data: { error: 'client_id and over_minutes > 0 required' } }, 400);
    }

    /* const base44 = ... */;
    const client = await base44.asServiceRole.entities.Client.get(client_id);
    if (!client) return c.json({ data: { error: 'Client not found' } }, 404);

    if (!client.overage_rate) {
      return c.json({ data: { skipped: 'no overage_rate set' } });
    }
    if (!client.stripe_customer_id) {
      console.warn(`[chargeIntlOverage] Client ${client_id} has no stripe_customer_id — logging only`);
      // Still record the overage as a Payment for visibility
      await base44.asServiceRole.entities.Payment.create({
        client_id: client.id,
        amount: Math.round(over_minutes * client.overage_rate * 100) / 100,
        currency: client.currency || 'USD',
        status: 'pending',
        description: JSON.stringify({
          type: 'overage_uncharged',
          reason: 'no_stripe_customer',
          over_minutes,
          rate: client.overage_rate,
          period_start,
          period_end,
        }),
      });
      return c.json({ data: { logged: true, reason: 'no_stripe_customer' } });
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'));
    const amountCents = Math.round(over_minutes * client.overage_rate * 100);
    const currency = (client.currency || 'usd').toLowerCase();

    // Add invoice item — Stripe auto-collects on next subscription billing
    const invoiceItem = await stripe.invoiceItems.create({
      customer: client.stripe_customer_id,
      amount: amountCents,
      currency,
      description: `Overage: ${over_minutes} minutes × ${client.overage_rate}/min (period ${period_start?.slice(0,10)} → ${period_end?.slice(0,10)})`,
      metadata: {
        base44_app_id: Deno.env.get('BASE44_APP_ID'),
        client_id: client.id,
        type: 'overage',
        over_minutes: String(over_minutes),
      },
    });

    // Record in Payment ledger
    await base44.asServiceRole.entities.Payment.create({
      client_id: client.id,
      amount: amountCents / 100,
      currency: currency.toUpperCase(),
      status: 'pending',
      cashfree_order_id: invoiceItem.id,
      description: JSON.stringify({
        type: 'overage',
        processor: 'stripe',
        invoice_item_id: invoiceItem.id,
        over_minutes,
        rate: client.overage_rate,
        period_start,
        period_end,
      }),
    });

    console.log(`[chargeIntlOverage] Client ${client_id} billed ${amountCents/100} ${currency} for ${over_minutes} min`);
    return c.json({ data: {
      success: true,
      invoice_item_id: invoiceItem.id,
      amount: amountCents / 100,
      currency: currency.toUpperCase(),
    } });
  } catch (error) {
    console.error('[chargeIntlOverage] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};