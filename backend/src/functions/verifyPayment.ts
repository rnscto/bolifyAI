import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function verifyPayment(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { order_id, ref_code } = await c.req.json();

    if (!order_id) {
      return c.json({ data: { error: 'order_id is required' } }, 400);
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
      await base44.asServiceRole.entities.Payment.update(payment.id, {
        status: 'paid',
        cashfree_payment_id: cfData.cf_order_id?.toString(),
        paid_at: new Date().toISOString(),
      });

      // ── Trial top-up path: extend trial + grant unlimited calling ──
      let isTrialTopup = false;
      let topupPlan = null;
      try {
        const parsed = JSON.parse(payment.description);
        if (parsed?.payment_type === 'trial_topup') {
          isTrialTopup = true;
          topupPlan = parsed;
        }
      } catch (_) {}

      if (isTrialTopup) {
        const cur = await base44.asServiceRole.entities.Client.get(payment.client_id);
        const now = new Date();
        // Extend from the LATER of (current trial_end_date, now) so users don't lose unused time
        const baseEnd = cur?.trial_end_date && new Date(cur.trial_end_date) > now ? new Date(cur.trial_end_date) : now;
        const newEnd = new Date(baseEnd.getTime() + topupPlan.days * 86400000);
        const history = Array.isArray(cur?.trial_topup_history) ? cur.trial_topup_history : [];
        history.push({ plan: topupPlan.plan, amount: topupPlan.amount, days_added: topupPlan.days, purchased_at: now.toISOString(), payment_id: payment.id });
        await base44.asServiceRole.entities.Client.update(payment.client_id, {
          account_status: 'trial',
          trial_end_date: newEnd.toISOString(),
          trial_topup_unlimited_until: newEnd.toISOString(),
          trial_topup_history: history,
        });
        try { await base44.asServiceRole.functions.invoke('sendInvoiceEmail', { payment_id: payment.id }); } catch (_) {}
        return c.json({ data: { status: 'paid', topup: true, days_added: topupPlan.days, new_trial_end: newEnd.toISOString() } });
      }

      // Parse plan details from payment description
      let subscribedChannels = 1;
      let includeCRM = false;
      let billingCycle = 'quarterly';
      let ratePerChannel = 9999;
      let months = 3;
      try {
        const planDetails = JSON.parse(payment.description);
        subscribedChannels = planDetails.channels || 1;
        includeCRM = planDetails.include_crm || false;
        billingCycle = planDetails.billing_cycle || 'quarterly';
        ratePerChannel = planDetails.rate_per_channel || 9999;
        months = planDetails.months || 3;
      } catch (e) {
        const chMatch = payment.description?.match(/^(\d+)\s*channel/);
        if (chMatch) subscribedChannels = parseInt(chMatch[1]);
        includeCRM = payment.description?.includes('CRM') || false;
      }

      const now = new Date();
      const billingEnd = new Date(now);
      billingEnd.setMonth(billingEnd.getMonth() + months);

      // Capture pre-update status to detect first activation
      const clientBefore = await base44.asServiceRole.entities.Client.get(payment.client_id);
      const isFirstActivation = clientBefore?.account_status !== 'active';

      // Update client to active with correct channel count
      await base44.asServiceRole.entities.Client.update(payment.client_id, {
        account_status: 'active',
        status: 'active',
        total_channels: subscribedChannels,
        monthly_rate_per_channel: ratePerChannel,
        billing_cycle: billingCycle,
        has_custom_crm: includeCRM,
        next_billing_date: billingEnd.toISOString().split('T')[0],
      });

      // Auto-create a Product Training ticket on FIRST activation only (idempotent)
      if (isFirstActivation) {
        try {
          const existing = await base44.asServiceRole.entities.SupportTicket.filter({
            client_id: payment.client_id,
            category: 'onboarding'
          }).catch(() => []);
          const alreadyHasTraining = existing.some(t => /product training/i.test(t.subject || ''));
          if (!alreadyHasTraining) {
            const companyName = clientBefore?.company_name || 'Client';
            const description = `🎉 Welcome aboard! ${companyName} just activated their subscription and needs product training.

📦 Plan Details:
• Channels: ${subscribedChannels}
• Billing Cycle: ${billingCycle}
• Rate: ₹${ratePerChannel}/channel/month
• CRM Add-on: ${includeCRM ? 'Yes' : 'No'}

✅ Training Checklist:
1. Schedule onboarding/training call within 48 hours
2. Walk through agent setup & voice configuration
3. Demonstrate lead management & campaigns
4. Cover knowledge base setup
5. Review reporting & analytics
6. Share documentation links
7. Add to customer-success follow-up sequence

Contact: ${clientBefore?.email || ''} ${clientBefore?.phone ? '• ' + clientBefore.phone : ''}`;

            await base44.asServiceRole.functions.invoke('createSupportTicket', {
              subject: `Product Training — ${companyName}`,
              description,
              category: 'onboarding',
              priority: 'high',
              requester_email: clientBefore?.email || user.email,
              requester_name: companyName,
              requester_phone: clientBefore?.phone || '',
              client_id: payment.client_id,
              source: 'admin_manual'
            });
          }
        } catch (trainingErr) {
          console.error('Product training ticket auto-creation failed (non-blocking):', trainingErr?.message || trainingErr);
        }
      }

      // Create or update subscription
      const subs = await base44.asServiceRole.entities.Subscription.filter({ client_id: payment.client_id });
      const subData = {
        client_id: payment.client_id,
        channels: subscribedChannels,
        rate_per_channel: ratePerChannel,
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

      // Auto-send tax invoice email (fire-and-forget; don't fail verification if it errors)
      try {
        await base44.asServiceRole.functions.invoke('sendInvoiceEmail', { payment_id: payment.id });
      } catch (emailErr) {
        console.error('Invoice email failed (non-blocking):', emailErr?.message || emailErr);
      }

      // Report sale to Brainbucks Affiliate App if ref_code present (fire-and-forget)
      if (ref_code) {
        try {
          const client = await base44.asServiceRole.entities.Client.get(payment.client_id);
          await base44.asServiceRole.functions.invoke('reportAffiliateSale', {
            ref_code,
            amount: payment.amount,
            buyer_name: client?.company_name || user.full_name,
            buyer_email: client?.email || user.email,
            payment_ref: cfData.cf_order_id?.toString() || order_id,
            sale_type: 'fresh',
          });
        } catch (affErr) {
          console.error('Affiliate webhook failed (non-blocking):', affErr?.message || affErr);
        }
      }

      return c.json({ data: {
        status: 'paid',
        order_status: cfData.order_status,
        amount: payment.amount,
        invoice_sent: true,
      } });
    } else {
      // Update payment status
      const newStatus = cfData.order_status === 'EXPIRED' ? 'failed' : 'pending';
      await base44.asServiceRole.entities.Payment.update(payment.id, { status: newStatus });

      return c.json({ data: {
        status: newStatus,
        order_status: cfData.order_status,
      } });
    }
  } catch (error) {
    console.error('Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};