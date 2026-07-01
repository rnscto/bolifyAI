import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Creates a Cashfree order for a trial top-up purchase.
// Plans: trial_topup_5d (₹1000 → +5 days unlimited) | trial_topup_15d (₹2000 → +15 days unlimited)
// Tracks plan in Payment.description as JSON {payment_type, plan, days, amount} so verifyPayment can credit correctly.



const PLANS = {
  trial_topup_5d: { amount: 1000, days: 5, label: '5-Day Trial Top-Up' },
  trial_topup_15d: { amount: 2000, days: 15, label: '15-Day Trial Top-Up' },
};

export default async function createTrialTopupOrder(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { plan } = await c.req.json();
    const planConfig = PLANS[plan];
    if (!planConfig) return c.json({ data: { error: 'Invalid plan' } }, 400);

    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) return c.json({ data: { error: 'Client not found' } }, 404);
    const client = clients[0];

    const env = Deno.env.get('CASHFREE_ENVIRONMENT') || 'sandbox';
    const baseUrl = env === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
    const orderId = `topup_${client.id}_${Date.now()}`;

    const cfRes = await fetch(`${baseUrl}/pg/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': Deno.env.get('CASHFREE_APP_ID'),
        'x-client-secret': Deno.env.get('CASHFREE_SECRET_KEY'),
        'x-api-version': '2023-08-01',
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: planConfig.amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: client.id,
          customer_name: user.full_name || client.company_name,
          customer_email: client.email,
          customer_phone: client.phone || '9999999999',
        },
        order_meta: {
          return_url: `${req.headers.get('origin') || 'https://app.base44.com'}/ClientSubscription?order_id=${orderId}&status={order_status}&topup=1`,
        },
        order_note: `VaaniAI - ${planConfig.label}`,
      }),
    });
    const cfData = await cfRes.json();
    if (!cfRes.ok) {
      console.error('Cashfree topup error:', cfData);
      return c.json({ data: { error: 'Failed to create payment order', details: cfData } }, 500);
    }

    const payment = await base44.entities.Payment.create({
      client_id: client.id,
      cashfree_order_id: orderId,
      amount: planConfig.amount,
      currency: 'INR',
      status: 'pending',
      payment_session_id: cfData.payment_session_id,
      description: JSON.stringify({
        payment_type: 'trial_topup',
        plan,
        days: planConfig.days,
        amount: planConfig.amount,
        label: planConfig.label,
      }),
    });

    return c.json({ data: {
      order_id: orderId,
      payment_session_id: cfData.payment_session_id,
      payment_id: payment.id,
      amount: planConfig.amount,
      environment: env,
    } });
  } catch (e) {
    console.error('createTrialTopupOrder error:', e);
    return c.json({ data: { error: e.message } }, 500);
  }

};