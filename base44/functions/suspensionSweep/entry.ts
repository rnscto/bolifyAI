import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Daily sweep that enforces account suspension when payment dues are not met.
 *
 * Rules applied:
 *  1. Trial ended (trial_end_date in past) + status still 'trial' → 'expired'.
 *  2. Subscription pending payment (any duration) → Client.account_status = 'suspended'
 *     and Subscription.status = 'overdue'.
 *  3. Active subscription whose billing_end_date has passed without a new
 *     active subscription → Client.account_status = 'suspended'.
 *
 * Idempotent — safe to run multiple times per day.
 */
Deno.serve(async (req) => {
  try {
    // External cron auth — same pattern as trialExpiryCheck
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronSecret = url.searchParams.get('cron_secret');
      const cronApiKey = url.searchParams.get('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      const isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);
      if (!isValid) return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const base44 = createClientFromRequest(req).asServiceRole;
    const now = new Date();

    const results = { trial_expired: [], suspended_pending: [], suspended_overdue: [] };

    // 1. Trial → Expired
    const trials = await base44.entities.Client.filter({ account_status: 'trial' });
    for (const c of trials) {
      if (!c.trial_end_date) continue;
      const end = new Date(c.trial_end_date);
      if (end < now) {
        await base44.entities.Client.update(c.id, { account_status: 'expired' });
        results.trial_expired.push({ id: c.id, company: c.company_name });
        try {
          await base44.entities.ClientLifecycleEvent.create({
            client_id: c.id,
            client_name: c.company_name,
            event_type: 'trial_expired',
            from_value: 'trial',
            to_value: 'expired',
            effective_date: now.toISOString(),
            source: 'system_auto',
            performed_by: 'suspensionSweep',
            notes: 'Trial period ended without subscription.'
          });
        } catch (_) {}
      }
    }

    // 2. Subscription pending payment → suspend client immediately (no grace)
    const pendingSubs = await base44.entities.Subscription.filter({ status: 'pending' });
    for (const sub of pendingSubs) {
      // Mark sub overdue
      await base44.entities.Subscription.update(sub.id, { status: 'overdue', payment_status: 'failed' });

      // Suspend client (only if not already suspended/cancelled)
      const clients = await base44.entities.Client.filter({ id: sub.client_id });
      const c = clients[0];
      if (!c) continue;
      if (['suspended', 'cancelled'].includes(c.account_status)) continue;

      await base44.entities.Client.update(c.id, { account_status: 'suspended' });
      results.suspended_pending.push({ id: c.id, company: c.company_name, subscription_id: sub.id });

      try {
        await base44.entities.ClientLifecycleEvent.create({
          client_id: c.id,
          client_name: c.company_name,
          event_type: 'suspended',
          from_value: c.account_status,
          to_value: 'suspended',
          amount: sub.total_amount || 0,
          effective_date: now.toISOString(),
          source: 'system_auto',
          performed_by: 'suspensionSweep',
          notes: `Renewal payment not received. Subscription ${sub.id} marked overdue.`
        });
      } catch (_) {}
    }

    // 3. Active subscription whose billing_end_date has passed with no follow-up
    const activeSubs = await base44.entities.Subscription.filter({ status: 'active' });
    for (const sub of activeSubs) {
      if (!sub.billing_end_date) continue;
      const end = new Date(sub.billing_end_date);
      if (end >= now) continue;

      // Look for a newer active subscription for the same client
      const allClientSubs = await base44.entities.Subscription.filter({ client_id: sub.client_id });
      const hasNewerActive = allClientSubs.some(s =>
        s.id !== sub.id &&
        s.status === 'active' &&
        s.billing_end_date &&
        new Date(s.billing_end_date) > now
      );
      if (hasNewerActive) continue;

      // Mark this sub overdue + suspend client
      await base44.entities.Subscription.update(sub.id, { status: 'overdue' });
      const clients = await base44.entities.Client.filter({ id: sub.client_id });
      const c = clients[0];
      if (!c || ['suspended', 'cancelled'].includes(c.account_status)) continue;

      await base44.entities.Client.update(c.id, { account_status: 'suspended' });
      results.suspended_overdue.push({ id: c.id, company: c.company_name, subscription_id: sub.id });

      try {
        await base44.entities.ClientLifecycleEvent.create({
          client_id: c.id,
          client_name: c.company_name,
          event_type: 'suspended',
          from_value: c.account_status,
          to_value: 'suspended',
          effective_date: now.toISOString(),
          source: 'system_auto',
          performed_by: 'suspensionSweep',
          notes: `Subscription ${sub.id} billing_end_date passed without renewal.`
        });
      } catch (_) {}
    }

    return Response.json({ success: true, ...results });
  } catch (error) {
    console.error('suspensionSweep error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});