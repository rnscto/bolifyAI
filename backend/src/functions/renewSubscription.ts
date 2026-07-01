import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { EmailClient } from 'npm:@azure/communication-email@1.0.0';

let _emailClient: any;
function getEmailClient() {
  if (!_emailClient) {
    const ep = Deno.env.get('AZURE_COMM_ENDPOINT');
    const key = Deno.env.get('AZURE_COMM_KEY');
    if (!ep || !key) throw new Error("Missing AZURE_COMM_ENDPOINT or AZURE_COMM_KEY");
    _emailClient = new EmailClient(`endpoint=${ep};accesskey=${key}`);
  }
  return _emailClient;
}

async function sendEmail({ to, subject, html }) {
  const message = {
    senderAddress: 'DoNotReply@vaaniai.io',
    displayName: 'VaaniAI',
    content: { subject, html },
    recipients: { to: [{ address: to }] }
  };
  const poller = await getEmailClient().beginSend(message);
  const result = await poller.pollUntilDone();
  if (result.status !== 'Succeeded') throw new Error(`ACS Email error: ${result.error?.message || result.status}`);
  return result;
}

export default async function renewSubscription(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Support external cron: allow GET requests with shared secret or CRON_API_KEY
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const cronSecret = url.searchParams.get('cron_secret');
      const cronApiKey = url.searchParams.get('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      const isValid = (expectedSecret && cronSecret === expectedSecret) || (expectedCronKey && cronApiKey === expectedCronKey);
      if (!isValid) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
      console.log('[renewSubscription] Triggered by external cron');
    }

    // Scheduled automation — no user session, use service role directly
    /* const base44 = ... */;

    const now = new Date();
    const results = { renewals_needed: [], emails_sent: [] };

    // Drive renewals off Client.next_billing_date + Client.billing_cycle
    // so monthly / quarterly / half_yearly / yearly clients are all handled.
    // (The Subscription entity schema only supports 'quarterly' and isn't
    //  populated for admin-activated or non-quarterly clients.)
    const activeClients = await base44.entities.Client.filter({ account_status: 'active' });

    for (const client of activeClients) {
      if (!client.next_billing_date) continue;

      const endDate = new Date(client.next_billing_date);
      const daysUntilRenewal = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
      const cycle = client.billing_cycle || 'quarterly';
      const cycleLabel = cycle.replace('_', '-');

      // Try to find a matching Subscription for amount details (optional)
      const subs = await base44.entities.Subscription.filter({ client_id: client.id, status: 'active' });
      const sub = subs.length > 0 ? subs[0] : null;
      const rate = client.custom_rate || client.monthly_rate_per_channel || 0;
      const channels = client.total_channels || 1;
      const monthsInCycle = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 }[cycle] || 3;
      const totalAmount = sub?.total_amount || (rate * channels * monthsInCycle);

      // 3 days before renewal: Send reminder
      if (daysUntilRenewal === 3) {
        await sendEmail({
          to: client.email,
          subject: `Your VaaniAI subscription renews in 3 days`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">VaaniAI</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">Your <strong>${cycleLabel}</strong> subscription will renew on <strong>${endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>.</p>
                <div style="background: #f7fafc; border-radius: 8px; padding: 20px; margin: 20px 0;">
                  <p style="margin: 0 0 8px; color: #2d3748;"><strong>Renewal Summary:</strong></p>
                  <p style="margin: 4px 0; color: #4a5568;">${channels} channel(s) × ₹${rate?.toLocaleString('en-IN')} × ${monthsInCycle} month(s) = ₹${totalAmount?.toLocaleString('en-IN')}</p>
                </div>
                <p style="color: #4a5568; line-height: 1.6;">You'll receive a payment link on the renewal date. No action needed right now.</p>
                <p style="color: #718096; font-size: 13px; text-align: center; margin-top: 20px;">Questions? Reply to this email.</p>
              </div>
            </div>
          `,
        });
        results.emails_sent.push({ client_id: client.id, type: 'renewal_reminder', email: client.email, cycle });
      }

      // On the renewal day: Mark subscription as pending renewal
      if (daysUntilRenewal <= 0) {
        if (sub) {
          await base44.entities.Subscription.update(sub.id, {
            status: 'pending',
            payment_status: 'pending',
          });
        }

        await sendEmail({
          to: client.email,
          subject: 'Your VaaniAI subscription is due for renewal',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">VaaniAI</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">Your <strong>${cycleLabel}</strong> subscription has reached its renewal date. Please complete the payment to continue uninterrupted service.</p>
                <div style="background: #fff5f5; border-left: 4px solid #e53e3e; padding: 16px; margin: 20px 0; border-radius: 4px;">
                  <p style="margin: 0; color: #c53030;"><strong>Amount Due: ₹${totalAmount?.toLocaleString('en-IN')}</strong></p>
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
          client_id: client.id,
          subscription_id: sub?.id || null,
          company: client.company_name,
          amount: totalAmount,
          cycle,
        });
      }
    }

    return c.json({ data: { success: true, ...results } });
  } catch (error) {
    console.error('Renewal error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};