import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { channels, plan_type, include_crm } = await req.json();

    // Fetch client
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) {
      return Response.json({ error: 'Client not found' }, { status: 404 });
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
        order_currency: 'INR',
        customer_details: {
          customer_id: client.id,
          customer_name: user.full_name || client.company_name,
          customer_email: client.email,
          customer_phone: client.phone || '9999999999',
        },
        order_meta: {
          return_url: `${req.headers.get('origin') || 'https://app.base44.com'}/ClientSubscription?order_id=${orderId}&status={order_status}`,
        },
        order_note: `VaaniAI - ${channels} channel(s) ${plan_type}${include_crm ? ' + CRM' : ''}`,
      }),
    });

    const cfData = await cfResponse.json();

    if (!cfResponse.ok) {
      console.error('Cashfree error:', cfData);
      return Response.json({ error: 'Failed to create payment order', details: cfData }, { status: 500 });
    }

    // Save selected channels on client so verifyPayment can read it
    await base44.asServiceRole.entities.Client.update(client.id, {
      total_channels: channels || 1,
      monthly_rate_per_channel: ratePerChannel,
      has_custom_crm: include_crm || false,
    });

    // Create Payment record
    const payment = await base44.entities.Payment.create({
      client_id: client.id,
      cashfree_order_id: orderId,
      amount: totalAmount,
      currency: 'INR',
      status: 'pending',
      payment_session_id: cfData.payment_session_id,
      description: `${channels} channel(s) × ₹${ratePerChannel}/mo × ${months} months${include_crm ? ' + CRM ₹' + crmRate + '/mo × ' + months + ' months' : ''}`,
    });

    return Response.json({
      order_id: orderId,
      payment_session_id: cfData.payment_session_id,
      payment_id: payment.id,
      amount: totalAmount,
      environment: env,
    });
  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});