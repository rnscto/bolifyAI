import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { amount } = await req.json();

    // Validate minimum top-up amount
    const minTopup = 500;
    if (!amount || amount < minTopup) {
      return Response.json({ error: `Minimum top-up amount is ₹${minTopup}` }, { status: 400 });
    }

    // Fetch client
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) {
      return Response.json({ error: 'Client not found' }, { status: 404 });
    }
    const client = clients[0];

    // Create Cashfree order
    const env = Deno.env.get('CASHFREE_ENVIRONMENT') || 'sandbox';
    const baseUrl = env === 'production'
      ? 'https://api.cashfree.com'
      : 'https://sandbox.cashfree.com';

    const orderId = `topup_${client.id.slice(-8)}_${Date.now()}`;

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
        order_amount: amount,
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
        order_note: `Getway AI Wallet Top-up ₹${amount}`,
      }),
    });

    const cfData = await cfResponse.json();

    if (!cfResponse.ok) {
      console.error('Cashfree error:', cfData);
      return Response.json({ error: 'Failed to create payment order', details: cfData }, { status: 500 });
    }

    // Create Payment record with topup metadata
    const payment = await base44.entities.Payment.create({
      client_id: client.id,
      cashfree_order_id: orderId,
      amount: amount,
      currency: 'INR',
      status: 'pending',
      payment_session_id: cfData.payment_session_id,
      description: JSON.stringify({ type: 'wallet_topup', amount }),
    });

    return Response.json({
      order_id: orderId,
      payment_session_id: cfData.payment_session_id,
      payment_id: payment.id,
      amount: amount,
      environment: env,
    });
  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});