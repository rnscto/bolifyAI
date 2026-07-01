import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Stripe from 'npm:stripe@17.5.0';

// Stripe webhook — verifies signature, then activates subscription on
// checkout.session.completed. Mirrors verifyPayment's activation logic.

export default async function stripe_webhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    const signature = req.headers.get('stripe-signature');
    const rawBody = await req.text();

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'));
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');

    let event;
    try {
      // Deno crypto is async — must use the async variant
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
    } catch (err) {
      console.error('Stripe signature verification failed:', err.message);
      return c.json({ data: { error: 'Invalid signature' } }, 400);
    }

    // Service-role client (webhook has no app user context)
    /* const base44 = ... */;

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const sessionId = session.id;
      const flow = session.metadata?.flow;

      // ─── International subscription flow ───
      if (flow === 'intl_subscription') {
        const planKey = session.metadata?.plan_key;
        const setupFeeKey = session.metadata?.setup_fee_key || null;
        const supportTierKey = session.metadata?.support_tier_key || null;
        const region = session.metadata?.region;
        const minutesIncluded = parseInt(session.metadata?.minutes_included || '0', 10);
        const overageRate = parseFloat(session.metadata?.overage_rate || '0');
        const currency = session.metadata?.currency;
        let clientIdIntl = session.metadata?.client_id;

        // Match by client_id (most reliable), then by either email field
        // (customer_details.email = what payer typed at checkout, customer_email =
        // what we pre-filled). A client.email mismatch is common when the payer
        // uses a billing email different from their app login email.
        let client = null;
        if (clientIdIntl) {
          client = await base44.asServiceRole.entities.Client.get(clientIdIntl).catch(() => null);
        }
        const payerEmail = (session.customer_details?.email || '').toLowerCase();
        const prefilledEmail = (session.customer_email || '').toLowerCase();
        if (!client && payerEmail) {
          const matches = await base44.asServiceRole.entities.Client.filter({ email: payerEmail });
          if (matches.length) client = matches[0];
        }
        if (!client && prefilledEmail && prefilledEmail !== payerEmail) {
          const matches = await base44.asServiceRole.entities.Client.filter({ email: prefilledEmail });
          if (matches.length) client = matches[0];
        }
        if (!client) {
          console.warn(`[stripe-webhook] Intl subscription paid but NO client match — session=${sessionId} clientId=${clientIdIntl} payerEmail=${payerEmail} prefilled=${prefilledEmail}. Use Admin → linkStripeSubscriptionToClient to recover manually.`);
        }

        const update = {
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
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

        if (client) {
          // Idempotency guard — skip if this exact subscription is already active
          if (client.stripe_subscription_id === session.subscription && client.account_status === 'active') {
            console.log(`[stripe-webhook] Client ${client.id} already activated for sub=${session.subscription} — skipping duplicate event ${event.id}`);
            return c.json({ data: { received: true, flow: 'intl_subscription', duplicate: true } });
          }
          await base44.asServiceRole.entities.Client.update(client.id, update);
          console.log(`[stripe-webhook] Intl subscription activated for client=${client.id} plan=${planKey}`);
        } else {
          console.warn(`[stripe-webhook] Intl subscription paid but no Client matched — session=${sessionId} email=${session.customer_details?.email}`);
        }

        return c.json({ data: { received: true, flow: 'intl_subscription' } });
      }

      // ─── Legacy one-time payment flow (India / regional channels) ───
      const clientId = session.metadata?.client_id;
      const channels = parseInt(session.metadata?.channels || '1', 10);
      const cycle = session.metadata?.billing_cycle || 'quarterly';
      const months = parseInt(session.metadata?.months || '3', 10);
      const includeCrm = session.metadata?.include_crm === '1';

      if (!clientId) {
        console.error('Missing client_id in session metadata:', sessionId);
        return c.json({ data: { received: true, warning: 'no client_id' } });
      }

      // Find pending Payment
      const payments = await base44.asServiceRole.entities.Payment.filter({
        payment_session_id: sessionId,
      });
      if (payments.length === 0) {
        console.error('Payment record not found for session:', sessionId);
        return c.json({ data: { received: true, warning: 'no payment record' } });
      }
      const payment = payments[0];

      // Idempotency guard — Stripe retries webhooks on 5xx, this prevents
      // double-activation if the same checkout.session.completed arrives twice.
      if (payment.status === 'paid') {
        console.log(`[stripe-webhook] Payment ${payment.id} already paid — skipping duplicate event ${event.id}`);
        return c.json({ data: { received: true, duplicate: true } });
      }

      // Mark payment as paid
      await base44.asServiceRole.entities.Payment.update(payment.id, {
        status: 'paid',
        cashfree_payment_id: session.payment_intent || sessionId,
      });

      // Activate client subscription
      const nextBilling = new Date();
      nextBilling.setMonth(nextBilling.getMonth() + months);

      await base44.asServiceRole.entities.Client.update(clientId, {
        account_status: 'active',
        status: 'active',
        total_channels: channels,
        billing_cycle: cycle,
        next_billing_date: nextBilling.toISOString().split('T')[0],
        ...(includeCrm ? { has_custom_crm: true, crm_subscription_status: 'active' } : {}),
      });

      console.log(`Stripe checkout completed: client=${clientId} session=${sessionId} amount=${session.amount_total}`);
    } else {
      console.log(`Stripe event ignored: ${event.type}`);
    }

    return c.json({ data: { received: true } });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};