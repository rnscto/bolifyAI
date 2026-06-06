import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Scheduled cron: handles subscription renewal lifecycle.
 *  - On/after billing_end_date → mark sub `pending` + flip Client to expired (handled by suspensionSweep).
 *
 * NOTE: Email notifications are disabled — Base44 backend functions cannot
 * open outbound SMTP sockets, and the SendEmail integration requires credits
 * which are currently exhausted. Status flips are the business-critical part.
 */
Deno.serve(async (req) => {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronSecret = url.searchParams.get('cron_secret');
      const cronApiKey = url.searchParams.get('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      const isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);
      if (!isValid) return Response.json({ error: 'Forbidden' }, { status: 403 });
      console.log('[renewSubscription] Triggered by external cron');
    }

    const base44 = createClientFromRequest(req).asServiceRole;
    const now = new Date();
    const results = { renewals_needed: [], reminders_logged: [], errors: [] };

    const activeSubscriptions = await base44.entities.Subscription.filter({ status: 'active' });

    for (const sub of activeSubscriptions) {
      if (!sub.billing_end_date) continue;
      const endDate = new Date(sub.billing_end_date);
      const daysUntilRenewal = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

      const clients = await base44.entities.Client.filter({ id: sub.client_id });
      const client = clients[0];
      if (!client) continue;

      // 3 days before → just log (no email)
      if (daysUntilRenewal === 3) {
        results.reminders_logged.push({ client_id: client.id, type: 'renewal_reminder_3d' });
      }

      // On/past renewal day → mark pending
      if (daysUntilRenewal <= 0) {
        if (sub.status === 'pending' || sub.status === 'overdue') continue;

        await base44.entities.Subscription.update(sub.id, {
          status: 'pending',
          payment_status: 'pending',
        });

        results.renewals_needed.push({
          subscription_id: sub.id,
          client_id: sub.client_id,
          company: client.company_name,
          amount: sub.total_amount,
        });

        try {
          await base44.entities.ClientLifecycleEvent.create({
            client_id: sub.client_id,
            client_name: client.company_name,
            event_type: 'renewed',
            from_value: 'active',
            to_value: 'pending_payment',
            amount: sub.total_amount || 0,
            effective_date: now.toISOString(),
            expiry_date: sub.billing_end_date ? new Date(sub.billing_end_date).toISOString() : null,
            billing_type: client.billing_type,
            subscription_plan: sub.billing_cycle,
            channels: sub.channels,
            source: 'renewal_cron',
            performed_by: 'system',
            notes: `Renewal due — subscription flipped to pending (₹${sub.total_amount?.toLocaleString('en-IN')})`,
          });
        } catch (logErr) {
          console.warn('Renewal lifecycle log failed:', logErr.message);
          results.errors.push({ client_id: client.id, stage: 'lifecycle_log', error: logErr.message });
        }
      }
    }

    return Response.json({ success: true, ...results });
  } catch (error) {
    console.error('Renewal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});