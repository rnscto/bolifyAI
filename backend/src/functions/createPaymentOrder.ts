import { base44ORM as base44 } from "../db/orm.ts";

export default async function createPaymentOrder(c: any) {
  try {
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { channels, plan_type, include_crm } = await c.req.json().catch(() => ({}));

    // Fetch client
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) {
      return c.json({ data: { error: 'Client not found' } }, 404);
    }
    const client = clients[0];

    // Calculate amount
    const ratePerChannel = 6500; // INR/month
    const crmRate = include_crm ? 1999 : 0; // INR/month
    const months = plan_type === 'quarterly' ? 3 : 1;
    const channelAmount = (channels || 1) * ratePerChannel * months;
    const crmAmount = crmRate * months;
    const totalAmount = channelAmount + crmAmount;

    // Create Cashfree order
    const env = Deno.env.get('CASHFREE_ENVIRONMENT') || 'sandbox';
    const baseUrl = env === 'production'
      ? 'https://api.cashfree.com'
      : 'https://sandbox.cashfree.com';

    const orderId = `order_\${client.id}_\${Date.now()}`;

    const cfResponse = await fetch(`\${baseUrl}/pg/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': Deno.env.get('CASHFREE_APP_ID') || '',
        'x-client-secret': Deno.env.get('CASHFREE_SECRET_KEY') || '',
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
          return_url: `\${c.req.header('origin') || 'https://app.base44.com'}/ClientSubscription?order_id=\${orderId}&status={order_status}`,
        },
        order_note: `VaaniAI - \${channels} channel(s) \${plan_type}\${include_crm ? ' + CRM' : ''}`,
      }),
    });

    const cfData = await cfResponse.json();

    if (!cfResponse.ok) {
      console.error('Cashfree error:', cfData);
      return c.json({ data: { error: 'Failed to create payment order', details: cfData } }, 500);
    }

    // Create Payment record with channel/CRM info embedded for verifyPayment
    const payment = await base44.entities.Payment.create({
      client_id: client.id,
      cashfree_order_id: orderId,
      amount: totalAmount,
      currency: 'INR',
      status: 'pending',
      payment_session_id: cfData.payment_session_id,
      description: JSON.stringify({ channels: channels || 1, include_crm: !!include_crm, rate_per_channel: ratePerChannel, crm_rate: crmRate, months }),
    });

    return c.json({
      data: {
        order_id: orderId,
        payment_session_id: cfData.payment_session_id,
        payment_id: payment.id,
        amount: totalAmount,
        environment: env,
      }
    });
  } catch (error: any) {
    console.error('Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
