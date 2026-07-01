import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Hardcoded fallback pricing — used only if PricingPlan has no rows for the
// region. India runs through Cashfree; other regions use Stripe (different fn).
const FALLBACK_REGION_PRICING = {
  IN: {
    currency: 'INR',
    monthly_per_channel: { monthly: 9999, quarterly: 7999, half_yearly: 6499, yearly: 4999 },
    tax_percent: 18,
    tax_label: 'GST',
    cashfree_supported: true,
  },
  US: {
    currency: 'USD',
    monthly_per_channel: { monthly: 149, quarterly: 129, half_yearly: 109, yearly: 89 },
    tax_percent: 0,
    tax_label: 'Sales Tax',
    cashfree_supported: false,
  },
  UK: {
    currency: 'GBP',
    monthly_per_channel: { monthly: 119, quarterly: 99, half_yearly: 89, yearly: 79 },
    tax_percent: 20,
    tax_label: 'VAT',
    cashfree_supported: false,
  },
  global: {
    currency: 'USD',
    monthly_per_channel: { monthly: 199, quarterly: 169, half_yearly: 149, yearly: 119 },
    tax_percent: 0,
    tax_label: 'Tax',
    cashfree_supported: false,
  },
};
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

// Resolve regional pricing from PricingPlan. For India reads national_subscription
// scope (per-channel monthly rate by cycle); for others reads intl_minute_pack.
async function resolveRegionPricing(base44, region) {
  const fallback = FALLBACK_REGION_PRICING[region] || FALLBACK_REGION_PRICING.IN;
  const scope = region === 'IN' ? 'national_subscription' : 'intl_minute_pack';
  try {
    const plans = await base44.asServiceRole.entities.PricingPlan.filter({
      scope, region, is_active: true,
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
      if (p.currency) currency = p.currency;
      if (typeof p.tax_percent === 'number') tax_percent = p.tax_percent;
      if (p.tax_label) tax_label = p.tax_label;
    }
    return { ...fallback, currency, monthly_per_channel: byCycle, tax_percent, tax_label };
  } catch (e) {
    console.warn('[createPaymentOrder] PricingPlan lookup failed, using fallback:', e.message);
    return fallback;
  }
}

export default async function createPaymentOrder(c: any) {
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

    // ─── Region-aware pricing (DB-driven via PricingPlan) ───
    const region = client.region || 'IN';
    const regionCfg = await resolveRegionPricing(base44, region);

    // Cashfree only supports INR — non-IN regions need a different processor.
    if (!regionCfg.cashfree_supported) {
      return c.json({ data: {
        error: `Payments for ${region} region are not yet available. Cashfree supports INR only. Contact support@vaaniai.com to set up ${regionCfg.currency} billing.`,
        region,
        currency: regionCfg.currency,
      } }, 400);
    }

    // Resolve cycle + per-channel rate (region-aware)
    const cycle = CYCLE_MONTHS[plan_type] ? plan_type : 'quarterly';
    const months = CYCLE_MONTHS[cycle];
    const ratePerChannel = client.custom_rate || regionCfg.monthly_per_channel[cycle];
    const crmRate = include_crm ? (client.crm_monthly_rate || 1999) : 0;

    const channelAmount = (channels || 1) * ratePerChannel * months;
    const crmAmount = crmRate * months;
    const subtotal = channelAmount + crmAmount;
    const taxAmount = Math.round(subtotal * regionCfg.tax_percent / 100);
    const totalAmount = subtotal + taxAmount;

    // Create Cashfree order
    const env = Deno.env.get('CASHFREE_ENVIRONMENT') || 'sandbox';
    const baseUrl = env === 'production'
      ? 'https://api.cashfree.com'
      : 'https://sandbox.cashfree.com';

    const orderId = `order_${client.id}_${Date.now()}`;

    const cfResponse = await fetch(`${baseUrl}/pg/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': Deno.env.get('CASHFREE_APP_ID'),
        'x-client-secret': Deno.env.get('CASHFREE_SECRET_KEY'),
        'x-api-version': '2023-08-01',
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: totalAmount,
        order_currency: regionCfg.currency,
        customer_details: {
          customer_id: client.id,
          customer_name: user.full_name || client.company_name,
          customer_email: client.email,
          customer_phone: client.phone || '9999999999',
        },
        order_meta: {
          return_url: `${req.headers.get('origin') || 'https://app.base44.com'}/ClientSubscription?order_id=${orderId}&status={order_status}`,
        },
        order_note: `VaaniAI - ${channels} channel(s) ${cycle}${include_crm ? ' + CRM' : ''} (incl. ${regionCfg.tax_percent}% ${regionCfg.tax_label})`,
      }),
    });

    const cfData = await cfResponse.json();

    if (!cfResponse.ok) {
      console.error('Cashfree error:', cfData);
      return c.json({ data: { error: 'Failed to create payment order', details: cfData } }, 500);
    }

    // Create Payment record with breakdown for verifyPayment
    const payment = await base44.entities.Payment.create({
      client_id: client.id,
      cashfree_order_id: orderId,
      amount: totalAmount,
      currency: regionCfg.currency,
      status: 'pending',
      payment_session_id: cfData.payment_session_id,
      description: JSON.stringify({
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
      order_id: orderId,
      payment_session_id: cfData.payment_session_id,
      payment_id: payment.id,
      amount: totalAmount,
      subtotal,
      gst_amount: taxAmount,
      tax_label: regionCfg.tax_label,
      currency: regionCfg.currency,
      billing_cycle: cycle,
      region,
      environment: env,
    } });
  } catch (error) {
    console.error('Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};