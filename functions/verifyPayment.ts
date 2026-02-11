import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { order_id } = await req.json();

    if (!order_id) {
      return Response.json({ error: 'order_id is required' }, { status: 400 });
    }

    // Verify with Cashfree
    const env = Deno.env.get('CASHFREE_ENVIRONMENT') || 'sandbox';
    const baseUrl = env === 'production'
      ? 'https://api.cashfree.com'
      : 'https://sandbox.cashfree.com';

    const cfResponse = await fetch(`${baseUrl}/pg/orders/${order_id}`, {
      headers: {
        'x-client-id': Deno.env.get('CASHFREE_APP_ID'),
        'x-client-secret': Deno.env.get('CASHFREE_SECRET_KEY'),
        'x-api-version': '2023-08-01',
      },
    });

    const cfData = await cfResponse.json();

    if (!cfResponse.ok) {
      return Response.json({ error: 'Failed to verify order', details: cfData }, { status: 500 });
    }

    // Find the payment record
    const payments = await base44.entities.Payment.filter({ cashfree_order_id: order_id });
    if (payments.length === 0) {
      return Response.json({ error: 'Payment record not found' }, { status: 404 });
    }
    const payment = payments[0];

    const isPaid = cfData.order_status === 'PAID';

    if (isPaid) {
      // Update payment record
      await base44.asServiceRole.entities.Payment.update(payment.id, {
        status: 'paid',
        cashfree_payment_id: cfData.cf_order_id?.toString(),
        paid_at: new Date().toISOString(),
      });

      // Fetch client
      const client = await base44.asServiceRole.entities.Client.get(payment.client_id);

      // Parse order note to extract details
      const now = new Date();
      const billingEnd = new Date(now);
      billingEnd.setMonth(billingEnd.getMonth() + 3); // quarterly

      // Update client to active
      await base44.asServiceRole.entities.Client.update(payment.client_id, {
        account_status: 'active',
        status: 'active',
        next_billing_date: billingEnd.toISOString().split('T')[0],
      });

      // Create or update subscription
      const subs = await base44.asServiceRole.entities.Subscription.filter({ client_id: payment.client_id });
      const subData = {
        client_id: payment.client_id,
        channels: client.total_channels || 1,
        rate_per_channel: 6500,
        total_amount: payment.amount,
        billing_start_date: now.toISOString().split('T')[0],
        billing_end_date: billingEnd.toISOString().split('T')[0],
        next_billing_date: billingEnd.toISOString().split('T')[0],
        status: 'active',
        payment_status: 'paid',
        payment_id: payment.id,
      };

      if (subs.length > 0) {
        await base44.asServiceRole.entities.Subscription.update(subs[0].id, subData);
      } else {
        await base44.asServiceRole.entities.Subscription.create(subData);
      }

      return Response.json({
        status: 'paid',
        order_status: cfData.order_status,
        amount: payment.amount,
      });
    } else {
      // Update payment status
      const newStatus = cfData.order_status === 'EXPIRED' ? 'failed' : 'pending';
      await base44.asServiceRole.entities.Payment.update(payment.id, { status: newStatus });

      return Response.json({
        status: newStatus,
        order_status: cfData.order_status,
      });
    }
  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});