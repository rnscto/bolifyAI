import { createClient } from 'npm:@base44/sdk@0.8.20';
import { Resend } from 'npm:resend@4.0.0';

const resend = new Resend(Deno.env.get('RESEND_API_KEY'));

async function sendEmail({ to, subject, html }) {
  const { data, error } = await resend.emails.send({ from: 'VaaniAI <noreply@vaaniai.io>', to, subject, html });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  return data;
}

Deno.serve(async (req) => {
  try {
    // Scheduled automation — no user session, use service role directly
    const base44 = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

    const now = new Date();
    const results = { renewals_needed: [], emails_sent: [] };

    // Find active subscriptions where billing_end_date is approaching (within 3 days)
    const activeSubscriptions = await base44.entities.Subscription.filter({ status: 'active' });

    for (const sub of activeSubscriptions) {
      if (!sub.billing_end_date) continue;

      const endDate = new Date(sub.billing_end_date);
      const daysUntilRenewal = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

      // 3 days before renewal: Send reminder
      if (daysUntilRenewal === 3) {
        const clients = await base44.asServiceRole.entities.Client.filter({ id: sub.client_id });
        const client = clients.length > 0 ? clients[0] : null;
        if (!client) continue;

        await base44.asServiceRole.integrations.Core.SendEmail({
          to: client.email,
          subject: 'Your VaaniAI subscription renews in 3 days',
          body: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">VaaniAI</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">Your quarterly subscription will renew on <strong>${endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>.</p>
                <div style="background: #f7fafc; border-radius: 8px; padding: 20px; margin: 20px 0;">
                  <p style="margin: 0 0 8px; color: #2d3748;"><strong>Renewal Summary:</strong></p>
                  <p style="margin: 4px 0; color: #4a5568;">${sub.channels || 1} channel(s) × ₹6,500 × 3 months = ₹${sub.total_amount?.toLocaleString('en-IN')}</p>
                </div>
                <p style="color: #4a5568; line-height: 1.6;">You'll receive a payment link on the renewal date. No action needed right now.</p>
                <p style="color: #718096; font-size: 13px; text-align: center; margin-top: 20px;">Questions? Reply to this email.</p>
              </div>
            </div>
          `,
        });
        results.emails_sent.push({ client_id: client.id, type: 'renewal_reminder', email: client.email });
      }

      // On the renewal day: Mark subscription as pending renewal
      if (daysUntilRenewal <= 0) {
        const clients = await base44.asServiceRole.entities.Client.filter({ id: sub.client_id });
        const client = clients.length > 0 ? clients[0] : null;
        if (!client) continue;

        // Update subscription status to pending
        await base44.asServiceRole.entities.Subscription.update(sub.id, {
          status: 'pending',
          payment_status: 'pending',
        });

        // Send renewal payment email
        await base44.asServiceRole.integrations.Core.SendEmail({
          to: client.email,
          subject: 'Your VaaniAI subscription is due for renewal',
          body: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">VaaniAI</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">Your quarterly subscription has reached its renewal date. Please complete the payment to continue uninterrupted service.</p>
                <div style="background: #fff5f5; border-left: 4px solid #e53e3e; padding: 16px; margin: 20px 0; border-radius: 4px;">
                  <p style="margin: 0; color: #c53030;"><strong>Amount Due: ₹${sub.total_amount?.toLocaleString('en-IN')}</strong></p>
                </div>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="https://vaaniai.in" style="background: linear-gradient(135deg, #e67e22, #f39c12); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Pay & Renew</a>
                </div>
                <p style="color: #718096; font-size: 13px; text-align: center;">Your service will be paused if payment is not received within 7 days.</p>
              </div>
            </div>
          `,
        });

        results.renewals_needed.push({
          subscription_id: sub.id,
          client_id: sub.client_id,
          company: client.company_name,
          amount: sub.total_amount,
        });
      }
    }

    return Response.json({ success: true, ...results });
  } catch (error) {
    console.error('Renewal error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});