import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const GST_PERCENT = 18;

// Mirror of lib/addonCatalog.js — server-trusted prices (never trust client-sent amount)
const CATALOG = {
  call_transfer: { label: 'Call Transfer', base_price: 1250, type: 'service' },
  email_campaigns: { label: 'Bulk Email Campaigns', base_price: 500, type: 'module' },
  whatsapp_bulk: { label: 'WhatsApp Bulk + Re-engagement', base_price: 500, type: 'module' },
  screening: { label: 'AI Bulk Candidate Screening', base_price: 2000, type: 'module' },
  google_sheets_sync: { label: 'Google Sheets Sync', base_price: 500, type: 'module' },
  social_media: { label: 'Social Media', base_price: 2000, type: 'module' },
  additional_did: { label: 'Additional DID', base_price: 200, type: 'service', is_quantifiable: true, max_per_agent: 3 },
  incoming_calls: { label: 'Incoming Calls', base_price: 2000, type: 'service', requires_backend_activation: true },
  extra_agent: { label: 'Additional AI Agent', base_price: 4999, type: 'service', is_quantifiable: true, max_per_agent: 10, requires_backend_activation: true },
};

// Add-ons that support multiple billing cycles. Maps cycle → plan_key in PricingPlan.
const BILLING_CYCLE_PLANS = {
  extra_agent: {
    monthly:   { plan_key: 'extra_agent',           months: 1 },
    quarterly: { plan_key: 'extra_agent_quarterly', months: 3 },
    yearly:    { plan_key: 'extra_agent_yearly',    months: 12 },
  },
};

export default async function createAddonOrder(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { addon_key, quantity = 1, billing_cycle } = await c.req.json();
    const addon = CATALOG[addon_key];
    if (!addon) return c.json({ data: { error: 'Unknown add-on' } }, 400);

    // Resolve plan_key + period months from billing_cycle (if add-on supports cycles).
    const cycleMap = BILLING_CYCLE_PLANS[addon_key];
    let lookupKey = addon_key;
    let periodMonths = 1;
    let cycleLabel = 'monthly';
    if (cycleMap) {
      const chosen = cycleMap[billing_cycle] || cycleMap.monthly;
      lookupKey = chosen.plan_key;
      periodMonths = chosen.months;
      cycleLabel = billing_cycle || 'monthly';
    }

    // Resolve live price from PricingPlan (admin-edited) — fall back to hardcoded.
    let livePrice = addon.base_price;
    try {
      const plans = await base44.asServiceRole.entities.PricingPlan.filter({
        scope: 'addon', plan_key: lookupKey, is_active: true
      });
      if (plans.length > 0 && typeof plans[0].price === 'number') {
        livePrice = plans[0].price;
      }
    } catch (e) {
      console.warn('PricingPlan lookup failed, using hardcoded:', e.message);
    }

    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) return c.json({ data: { error: 'Client not found' } }, 404);
    const client = clients[0];

    // For quantifiable add-ons validate caps
    let qty = 1;
    if (addon.is_quantifiable) {
      qty = Math.max(1, parseInt(quantity) || 1);
      if (addon_key === 'additional_did') {
        const agents = await base44.asServiceRole.entities.Agent.filter({ client_id: client.id });
        const maxAllowed = (agents.length || 1) * (addon.max_per_agent || 3);
        const currentQty = client.addon_subscriptions?.additional_did?.quantity || 0;
        if (currentQty + qty > maxAllowed) {
          return c.json({ data: { error: `Maximum ${maxAllowed} additional DIDs allowed (${addon.max_per_agent} per agent). You already have ${currentQty}.` } }, 400);
        }
      }
      // extra_agent has a generous cap of 10 per account; no additional validation needed
    }

    const baseAmount = livePrice * qty;
    const gstAmount = Math.round((baseAmount * GST_PERCENT) / 100);
    const totalAmount = baseAmount + gstAmount;

    const env = Deno.env.get('CASHFREE_ENVIRONMENT') || 'sandbox';
    const baseUrl = env === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';

    const orderId = `addon_${addon_key}_${client.id}_${Date.now()}`;

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
        order_currency: 'INR',
        customer_details: {
          customer_id: client.id,
          customer_name: user.full_name || client.company_name,
          customer_email: client.email,
          customer_phone: client.phone || '9999999999',
        },
        order_meta: {
          return_url: `${req.headers.get('origin') || 'https://app.base44.com'}/ClientMarketplace?addon_order_id=${orderId}&status={order_status}`,
        },
        order_note: `VaaniAI Add-on: ${addon.label}${qty > 1 ? ` x ${qty}` : ''} (incl. 18% GST)`,
      }),
    });

    const cfData = await cfResponse.json();
    if (!cfResponse.ok) {
      console.error('Cashfree error:', cfData);
      return c.json({ data: { error: 'Failed to create payment order', details: cfData } }, 500);
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + periodMonths);

    const purchase = await base44.asServiceRole.entities.AddonPurchase.create({
      client_id: client.id,
      addon_key,
      addon_label: cycleMap ? `${addon.label} (${cycleLabel})` : addon.label,
      quantity: qty,
      base_amount: baseAmount,
      gst_amount: gstAmount,
      total_amount: totalAmount,
      cashfree_order_id: orderId,
      payment_session_id: cfData.payment_session_id,
      status: 'pending',
      period_start: now.toISOString(),
      period_end: periodEnd.toISOString(),
      activation_status: addon.requires_backend_activation ? 'pending_backend' : 'activated',
    });

    return c.json({ data: {
      order_id: orderId,
      payment_session_id: cfData.payment_session_id,
      purchase_id: purchase.id,
      total_amount: totalAmount,
      base_amount: baseAmount,
      gst_amount: gstAmount,
      environment: env,
    } });
  } catch (error) {
    console.error('createAddonOrder error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};