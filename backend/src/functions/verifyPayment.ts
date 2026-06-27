import { base44ORM as base44 } from "../db/orm.ts";

export default async function verifyPayment(c: any) {
  try {
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { order_id } = await c.req.json().catch(() => ({}));

    if (!order_id) {
      return c.json({ data: { error: 'order_id is required' } }, 400);
    }

    // Verify with Cashfree
    const env = Deno.env.get('CASHFREE_ENVIRONMENT') || 'sandbox';
    const baseUrl = env === 'production'
      ? 'https://api.cashfree.com'
      : 'https://sandbox.cashfree.com';

    const cfResponse = await fetch(`\${baseUrl}/pg/orders/\${order_id}`, {
      headers: {
        'x-client-id': Deno.env.get('CASHFREE_APP_ID') || '',
        'x-client-secret': Deno.env.get('CASHFREE_SECRET_KEY') || '',
        'x-api-version': '2023-08-01',
      },
    });

    const cfData = await cfResponse.json();

    if (!cfResponse.ok) {
      return c.json({ data: { error: 'Failed to verify order', details: cfData } }, 500);
    }

    // Find the payment record
    const payments = await base44.entities.Payment.filter({ cashfree_order_id: order_id });
    if (payments.length === 0) {
      return c.json({ data: { error: 'Payment record not found' } }, 404);
    }
    const payment = payments[0];

    const isPaid = cfData.order_status === 'PAID';

    if (isPaid) {
      // Update payment record
      await base44.entities.Payment.update(payment.id, {
        status: 'paid',
        cashfree_payment_id: cfData.cf_order_id?.toString(),
        paid_at: new Date().toISOString(),
      });

      // Parse plan details from payment description
      let planDetails: any = {};
      try {
        planDetails = JSON.parse(payment.description);
      } catch (e) {
        planDetails = {};
      }

      // ── WALLET TOP-UP ──
      if (planDetails.type === 'wallet_topup') {
        const topupAmount = planDetails.amount || payment.amount;
        const client = await base44.entities.Client.get(payment.client_id);
        const currentBalance = Number(client?.wallet_balance) || 0;
        const newBalance = currentBalance + Number(topupAmount);

        await base44.entities.Client.update(payment.client_id, {
          wallet_balance: newBalance,
        });

        // Create usage log for the top-up
        await base44.entities.UsageLog.create({
          client_id: payment.client_id,
          type: 'topup',
          direction: 'credit',
          amount: topupAmount,
          balance_before: currentBalance,
          balance_after: newBalance,
          description: `Wallet top-up ₹\${topupAmount}`,
          payment_id: payment.id,
        });

        console.log(`[verifyPayment] Wallet top-up: ₹\${topupAmount}, balance ₹\${currentBalance} → ₹\${newBalance}`);

        return c.json({
          data: {
            status: 'paid',
            type: 'wallet_topup',
            order_status: cfData.order_status,
            amount: topupAmount,
            new_balance: newBalance,
          }
        });
      }

      // ── SUBSCRIPTION PAYMENT (existing logic) ──
      let subscribedChannels = planDetails.channels || 1;
      let includeCRM = planDetails.include_crm || false;
      if (!planDetails.channels) {
        // Legacy format fallback
        const chMatch = payment.description?.match(/^(\\d+)\\s*channel/);
        if (chMatch) subscribedChannels = parseInt(chMatch[1]);
        includeCRM = payment.description?.includes('CRM') || false;
      }

      const now = new Date();
      const billingEnd = new Date(now);
      billingEnd.setMonth(billingEnd.getMonth() + 3); // quarterly

      // Update client to active with correct channel count
      await base44.entities.Client.update(payment.client_id, {
        account_status: 'active',
        status: 'active',
        billing_type: 'unlimited',
        total_channels: subscribedChannels,
        monthly_rate_per_channel: 6500,
        has_custom_crm: includeCRM,
        next_billing_date: billingEnd.toISOString().split('T')[0],
      });

      // Create or update subscription
      const subs = await base44.entities.Subscription.filter({ client_id: payment.client_id });
      const subData = {
        client_id: payment.client_id,
        channels: subscribedChannels,
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
        await base44.entities.Subscription.update(subs[0].id, subData);
      } else {
        await base44.entities.Subscription.create(subData);
      }

      return c.json({
        data: {
          status: 'paid',
          order_status: cfData.order_status,
          amount: payment.amount,
        }
      });
    } else {
      // Update payment status
      const newStatus = cfData.order_status === 'EXPIRED' ? 'failed' : 'pending';
      await base44.entities.Payment.update(payment.id, { status: newStatus });

      return c.json({
        data: {
          status: newStatus,
          order_status: cfData.order_status,
        }
      });
    }
  } catch (error: any) {
    console.error('Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
