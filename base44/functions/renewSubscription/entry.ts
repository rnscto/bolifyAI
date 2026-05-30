import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

async function sendEmail({ to, subject, html }) {
  const { SMTPClient } = await import('npm:emailjs@4.0.3');
  const smtpHost = Deno.env.get('PLATFORM_SMTP_HOST');
  const smtpUser = Deno.env.get('PLATFORM_SMTP_USER');
  const smtpPass = Deno.env.get('PLATFORM_SMTP_PASS');
  const smtpFrom = Deno.env.get('PLATFORM_SMTP_FROM') || smtpUser;
  const smtpPort = parseInt(Deno.env.get('PLATFORM_SMTP_PORT') || '587');
  if (!smtpHost || !smtpUser || !smtpPass) throw new Error('Platform SMTP not configured');
  const client = new SMTPClient({ user: smtpUser, password: smtpPass, host: smtpHost, port: smtpPort, tls: true, timeout: 15000 });
  await client.sendAsync({ from: `Bolify AI <${smtpFrom}>`, to, subject, attachment: [{ data: html, alternative: true }] });
  return { status: 'sent' };
}

/**
 * Scheduled cron: handles subscription renewal lifecycle.
 *  - 3 days before billing_end_date → reminder email.
 *  - On/after billing_end_date → mark sub `pending`, email payment link.
 *
 * Final suspension (after 7 days non-payment) is handled by `suspensionSweep`.
 */
Deno.serve(async (req) => {
  try {
    // External cron auth
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
    const results = { renewals_needed: [], emails_sent: [], errors: [] };

    const activeSubscriptions = await base44.entities.Subscription.filter({ status: 'active' });

    for (const sub of activeSubscriptions) {
      if (!sub.billing_end_date) continue;
      const endDate = new Date(sub.billing_end_date);
      const daysUntilRenewal = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

      const clients = await base44.entities.Client.filter({ id: sub.client_id });
      const client = clients[0];
      if (!client) continue;

      // ─── 3 days before renewal: reminder ───
      if (daysUntilRenewal === 3) {
        try {
          await sendEmail({
            to: client.email,
            subject: 'Your Bolify AI subscription renews in 3 days',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                  <h1 style="color: white; margin: 0;">Bolify AI</h1>
                </div>
                <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                  <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                  <p style="color: #4a5568; line-height: 1.6;">Your ${sub.billing_cycle || 'subscription'} will renew on <strong>${endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>.</p>
                  <div style="background: #f7fafc; border-radius: 8px; padding: 20px; margin: 20px 0;">
                    <p style="margin: 0 0 8px; color: #2d3748;"><strong>Renewal Summary:</strong></p>
                    <p style="margin: 4px 0; color: #4a5568;">${sub.channels || 1} channel(s) × ₹${(sub.rate_per_channel || 14999).toLocaleString('en-IN')} = ₹${sub.total_amount?.toLocaleString('en-IN')}</p>
                  </div>
                  <p style="color: #4a5568; line-height: 1.6;">You'll receive a payment link on the renewal date. No action needed right now.</p>
                </div>
              </div>
            `,
          });
          results.emails_sent.push({ client_id: client.id, type: 'renewal_reminder' });
        } catch (e) {
          results.errors.push({ client_id: client.id, stage: '3day_reminder', error: e.message });
        }
      }

      // ─── On/past renewal day: mark pending + send payment email ───
      if (daysUntilRenewal <= 0) {
        // Idempotency — skip if already flipped to pending recently
        if (sub.status === 'pending' || sub.status === 'overdue') continue;

        await base44.entities.Subscription.update(sub.id, {
          status: 'pending',
          payment_status: 'pending',
        });

        try {
          await sendEmail({
            to: client.email,
            subject: '⚠️ Your Bolify AI subscription is due for renewal',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                  <h1 style="color: white; margin: 0;">Bolify AI</h1>
                </div>
                <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                  <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                  <p style="color: #4a5568; line-height: 1.6;">Your subscription has reached its renewal date. Please complete the payment to continue uninterrupted service.</p>
                  <div style="background: #fff5f5; border-left: 4px solid #e53e3e; padding: 16px; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 0; color: #c53030;"><strong>Amount Due: ₹${sub.total_amount?.toLocaleString('en-IN')}</strong></p>
                  </div>
                  <div style="text-align: center; margin: 30px 0;">
                    <a href="https://bolify.ai/ClientSubscription" style="background: linear-gradient(135deg, #e67e22, #f39c12); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Pay & Renew</a>
                  </div>
                  <p style="color: #718096; font-size: 13px; text-align: center;">Your account will be suspended if payment is not received within 7 days.</p>
                </div>
              </div>
            `,
          });
          results.emails_sent.push({ client_id: client.id, type: 'renewal_due' });
        } catch (e) {
          results.errors.push({ client_id: client.id, stage: 'renewal_due_email', error: e.message });
        }

        results.renewals_needed.push({
          subscription_id: sub.id,
          client_id: sub.client_id,
          company: client.company_name,
          amount: sub.total_amount,
        });

        // Lifecycle event
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
            notes: `Renewal due — payment email sent for ₹${sub.total_amount?.toLocaleString('en-IN')}`,
          });
        } catch (logErr) {
          console.warn('Renewal lifecycle log failed:', logErr.message);
        }
      }
    }

    return Response.json({ success: true, ...results });
  } catch (error) {
    console.error('Renewal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});