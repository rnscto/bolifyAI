import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// linkStripeSubscriptionToClient — admin-only manual recovery tool.
//
// When a client pays through Stripe Checkout with an email that does NOT
// match their VaaniAI client.email (e.g. signed up with email A but paid
// from billing email B), the stripe-webhook can't link the subscription
// to the client and the account stays on trial/expired.
//
// This function lets an admin look up a Stripe Checkout Session OR
// Subscription by ID (or by payer email), then attach it to the chosen
// client and activate them — mirroring the activation logic in
// stripe-webhook so the outcome is identical to a normal flow.
// ═══════════════════════════════════════════════════════════════════════


import Stripe from 'npm:stripe@17.5.0';

export default async function linkStripeSubscriptionToClient(c: any) {
  const req = c.req.raw || c.req;
  try {
    if (req.method !== 'POST') {
      return c.json({ data: { error: 'POST only' } }, 405);
    }

    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: admin only' } }, 403);
    }

    const { client_id, session_id, subscription_id, payer_email, dry_run } = await c.req.json();
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);
    if (!session_id && !subscription_id && !payer_email) {
      return c.json({ data: { error: 'Provide session_id, subscription_id, or payer_email' } }, 400);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'));

    // ─── Resolve Stripe session + subscription ────────────────────────
    let session = null;
    let subscription = null;

    if (session_id) {
      session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.subscription) {
        subscription = await stripe.subscriptions.retrieve(session.subscription);
      }
    } else if (subscription_id) {
      subscription = await stripe.subscriptions.retrieve(subscription_id);
      // try to find the originating checkout session for metadata
      const sessions = await stripe.checkout.sessions.list({ subscription: subscription_id, limit: 1 });
      session = sessions.data?.[0] || null;
    } else if (payer_email) {
      const sessions = await stripe.checkout.sessions.list({ limit: 20 });
      session = sessions.data.find(s =>
        s.customer_details?.email?.toLowerCase() === payer_email.toLowerCase() ||
        s.customer_email?.toLowerCase() === payer_email.toLowerCase()
      );
      if (!session) {
        return c.json({ data: { error: `No Stripe Checkout Session found for payer ${payer_email}` } }, 404);
      }
      if (session.subscription) {
        subscription = await stripe.subscriptions.retrieve(session.subscription);
      }
    }

    if (!session && !subscription) {
      return c.json({ data: { error: 'Could not resolve Stripe session or subscription' } }, 404);
    }

    // ─── Resolve client ───────────────────────────────────────────────
    const client = await base44.asServiceRole.entities.Client.get(client_id).catch(() => null);
    if (!client) return c.json({ data: { error: `Client ${client_id} not found` } }, 404);

    // ─── Build the update payload mirroring stripe-webhook ───────────
    const meta = session?.metadata || {};
    const planKey = meta.plan_key || null;
    const setupFeeKey = meta.setup_fee_key || null;
    const supportTierKey = meta.support_tier_key || null;
    const region = meta.region || client.region || 'US';
    const currency = meta.currency || client.currency || 'USD';
    const minutesIncluded = parseInt(meta.minutes_included || '0', 10);
    const overageRate = parseFloat(meta.overage_rate || '0');

    const update = {
      stripe_customer_id: session?.customer || subscription?.customer || null,
      stripe_subscription_id: subscription?.id || session?.subscription || null,
      intl_plan_key: planKey,
      minutes_included: minutesIncluded,
      minutes_used_this_period: 0,
      minutes_period_start: new Date().toISOString(),
      overage_rate: overageRate,
      currency,
      region,
      account_status: 'active',
      status: 'active',
    };
    if (setupFeeKey) {
      update.setup_fee_key = setupFeeKey;
      update.setup_fee_paid = true;
      update.setup_fee_paid_at = new Date().toISOString();
    }
    if (supportTierKey) update.support_tier = supportTierKey;

    if (dry_run) {
      return c.json({ data: {
        preview: true,
        client: { id: client.id, email: client.email, company_name: client.company_name, region: client.region, account_status: client.account_status },
        stripe: {
          session_id: session?.id,
          subscription_id: subscription?.id || session?.subscription,
          payer_email: session?.customer_details?.email,
          payment_status: session?.payment_status,
          subscription_status: subscription?.status,
          amount_total: session?.amount_total,
          currency: session?.currency,
          plan_key: planKey,
        },
        would_apply: update,
      } });
    }

    await base44.asServiceRole.entities.Client.update(client.id, update);

    console.log(`[linkStripeSubscriptionToClient] client=${client.id} subscription=${update.stripe_subscription_id} payer=${session?.customer_details?.email} adminEmail=${user.email}`);

    return c.json({ data: {
      success: true,
      client_id: client.id,
      linked_subscription: update.stripe_subscription_id,
      account_status: 'active',
    } });
  } catch (error) {
    console.error('[linkStripeSubscriptionToClient] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};