import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Scheduled cron: monitors trial lifecycle.
 *  - daysLeft <= 0 → flip Client.account_status to 'expired'.
 *  - daysLeft === 1 → create retention follow-up Activity.
 *
 * NOTE: Email notifications are disabled — Base44 backend functions cannot
 * open outbound SMTP sockets, and the SendEmail integration requires credits
 * which are currently exhausted. Status flips are the business-critical part.
 */
Deno.serve(async (req) => {
  try {
    // External cron auth (GET)
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronSecret = url.searchParams.get('cron_secret');
      const cronApiKey = url.searchParams.get('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      const isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);
      if (!isValid) return Response.json({ error: 'Forbidden' }, { status: 403 });
      console.log('[trialExpiryCheck] Triggered by external cron');
    }

    const base44 = createClientFromRequest(req).asServiceRole;
    const now = new Date();
    const results = { expired_updated: [], retention_activities: [], reminders_logged: [] };

    const trialClients = await base44.entities.Client.filter({ account_status: 'trial' });

    for (const client of trialClients) {
      if (!client.trial_end_date) continue;
      const trialEnd = new Date(client.trial_end_date);
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));

      // EXPIRED → flip status
      if (daysLeft <= 0) {
        await base44.entities.Client.update(client.id, { account_status: 'expired' });
        results.expired_updated.push({ client_id: client.id, company: client.company_name });

        try {
          await base44.entities.ClientLifecycleEvent.create({
            client_id: client.id,
            client_name: client.company_name,
            event_type: 'trial_expired',
            from_value: 'trial',
            to_value: 'expired',
            effective_date: now.toISOString(),
            source: 'system_auto',
            performed_by: 'system',
            notes: 'Trial period ended.',
          });
        } catch (e) {
          console.warn('Lifecycle log failed:', e.message);
        }
        continue;
      }

      // 3 / 1 days left → just log (no email)
      if (daysLeft === 3 || daysLeft === 1) {
        results.reminders_logged.push({ client_id: client.id, days_left: daysLeft });
      }

      // 1 day left → retention activity for human follow-up
      if (daysLeft === 1) {
        await base44.entities.Activity.create({
          client_id: client.id,
          type: 'call',
          title: `Retention call - Trial expiring for ${client.company_name}`,
          description: `Trial expires tomorrow. Call ${client.phone || client.email} to discuss subscription.`,
          scheduled_date: new Date().toISOString(),
          status: 'scheduled',
          priority: 'high',
          auto_created: true,
        });
        results.retention_activities.push({ client_id: client.id, company: client.company_name });
      }
    }

    return Response.json({
      success: true,
      total_trial_clients: trialClients.length,
      ...results,
    });
  } catch (error) {
    console.error('trialExpiryCheck error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});