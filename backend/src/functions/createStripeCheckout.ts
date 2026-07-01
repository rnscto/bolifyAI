import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import Stripe from 'npm:stripe@17.5.0';

// Hardcoded fallback pricing — used only if the PricingPlan entity has no
// rows for this region. Real prices are managed in Admin → Pricing Manager.
const FALLBACK_REGION_PRICING = {
  US: {
    currency: 'usd',
    monthly_per_channel: { monthly: 149, quarterly: 129, half_yearly: 109, yearly: 89 },
    tax_percent: 0,
    tax_label: 'Sales Tax',
  },
  UK: {
    currency: 'gbp',
    monthly_per_channel: { monthly: 119, quarterly: 99, half_yearly: 89, yearly: 79 },
    tax_percent: 20,
    tax_label: 'VAT',
  },
  global: {
    currency: 'usd',
    monthly_per_channel: { monthly: 199, quarterly: 169, half_yearly: 149, yearly: 119 },
    tax_percent: 0,
    tax_label: 'Tax',
  },
};
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

// Resolve regional pricing from PricingPlan (intl_minute_pack scope) with a
// hardcoded fallback. Reads all plans for the region and uses the matching
// billing_cycle row's price as the per-channel monthly rate.
async function resolveRegionPricing(base44, region) {
  const fallback = FALLBACK_REGION_PRICING[region] || FALLBACK_REGION_PRICING.global;
  try {
    const plans = await base44.asServiceRole.entities.PricingPlan.filter({
      scope: 'intl_minute_pack', region, is_active: true,
    });
    if (!plans?.length) return fallback;

    const byCycle = { ...fallback.monthly_per_channel };
    let currency = fallback.currency;
    let tax_percent = fallback.tax_percent;
    let tax_label = fallback.tax_label;

    for (const p of plans) {
      if (p.billing_cycle && p.price != null && byCycle[p.billing_cycle] !== undefined) {
        byCycle[p.billing_cycle] = p.price;
      }
      if (p.currency) currency = p.currency.toLowerCase();
      if (typeof p.tax_percent === 'number') tax_percent = p.tax_percent;
      if (p.tax_label) tax_label = p.tax_label;
    }
    return { currency, monthly_per_channel: byCycle, tax_percent, tax_label };
  } catch (e) {
    console.warn('[createStripeCheckout] PricingPlan lookup failed, using fallback:', e.message);
    return fallback;
  }
}

export default async function createStripeCheckout(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { channels, plan_type, include_crm } = await c.req.json();

    // Fetch client
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) {
      return c.json({ data: { error: 'Client not found' } }, 404);
    }
    const client = clients[0];

    // Stripe is for non-IN regions only (IN uses Cashfree)
    const region = client.region || 'IN';
    if (region === 'IN') {
      return c.json({ data: {
        error: 'India clients must use Cashfree (INR). Use createPaymentOrder instead.',
      } }, 400);
    }

    const regionCfg = await resolveRegionPricing(base44, region);
    const cycle = CYCLE_MONTHS[plan_type] ? plan_type : 'quarterly';
    const months = CYCLE_MONTHS[cycle];
    const ratePerChannel = client.custom_rate || regionCfg.monthly_per_channel[cycle];
    const crmRate = include_crm ? (client.crm_monthly_rate || 19) : 0;

    const channelAmount = (channels || 1) * ratePerChannel * months;
    const crmAmount = crmRate * months;
    const subtotal = channelAmount + crmAmount;
    const taxAmount = Math.round(subtotal * regionCfg.tax_percent / 100);
    const totalAmount = subtotal + taxAmount;

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'));

    // Build line items (subtotal as one line; tax as separate line for transparency)
    const lineItems = [
      {
        price_data: {
          currency: regionCfg.currency,
          product_data: {
            name: `VaaniAI — ${channels || 1} channel(s) ${cycle}${include_crm ? ' + CRM' : ''}`,
            description: `${months} month${months > 1 ? 's' : ''} prepaid`,
          },
          unit_amount: Math.round(subtotal * 100), // cents
        },
        quantity: 1,
      },
    ];

    if (taxAmount > 0) {
      lineItems.push({
        price_data: {
          currency: regionCfg.currency,
          product_data: { name: `${regionCfg.tax_label} (${regionCfg.tax_percent}%)` },
          unit_amount: Math.round(taxAmount * 100),
        },
        quantity: 1,
      });
    }

    const origin = req.headers.get('origin') || 'https://app.base44.com';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      customer_email: client.email,
      success_url: `${origin}/ClientSubscription?stripe_session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${origin}/ClientSubscription?status=cancelled`,
      metadata: {
        base44_app_id: Deno.env.get('BASE44_APP_ID'),
        client_id: client.id,
        channels: String(channels || 1),
        billing_cycle: cycle,
        include_crm: include_crm ? '1' : '0',
        region,
        months: String(months),
      },
    });

    // Create pending Payment record (mirrors Cashfree)
    const payment = await base44.entities.Payment.create({
      client_id: client.id,
      cashfree_order_id: session.id, // reuse field for Stripe session id
      amount: totalAmount,
      currency: regionCfg.currency.toUpperCase(),
      status: 'pending',
      payment_session_id: session.id,
      description: JSON.stringify({
        processor: 'stripe',
        channels: channels || 1,
        include_crm: !!include_crm,
        rate_per_channel: ratePerChannel,
        crm_rate: crmRate,
        months,
        billing_cycle: cycle,
        subtotal,
        gst_percent: regionCfg.tax_percent,
        gst_amount: taxAmount,
        tax_label: regionCfg.tax_label,
        total: totalAmount,
        region,
      }),
    });

    return c.json({ data: {
      checkout_url: session.url,
      session_id: session.id,
      payment_id: payment.id,
      amount: totalAmount,
      subtotal,
      gst_amount: taxAmount,
      tax_label: regionCfg.tax_label,
      currency: regionCfg.currency.toUpperCase(),
      billing_cycle: cycle,
      region,
    } });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};