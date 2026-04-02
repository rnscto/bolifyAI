import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
import { EmailClient } from 'npm:@azure/communication-email@1.0.0';

const connStr = `endpoint=${Deno.env.get('AZURE_COMM_ENDPOINT')};accesskey=${Deno.env.get('AZURE_COMM_KEY')}`;
const emailClient = new EmailClient(connStr);

async function sendEmail({ to, subject, html, displayName }) {
  const message = {
    senderAddress: 'DoNotReply@vaaniai.io',
    displayName: displayName || 'Getway AI',
    content: { subject, html },
    recipients: { to: [{ address: to }] }
  };
  const poller = await emailClient.beginSend(message);
  const result = await poller.pollUntilDone();
  if (result.status !== 'Succeeded') throw new Error(`ACS Email error: ${result.error?.message || result.status}`);
  return result;
}

// Scheduled automation — runs daily. Uses service role directly (no user session).

Deno.serve(async (req) => {
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
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      console.log('[trialExpiryCheck] Triggered by external cron');
    }

    const base44_client = createClientFromRequest(req);
    const base44 = base44_client.asServiceRole;

    const now = new Date();
    const results = { emails_sent: [], agents_triggered: [], expired_updated: [] };

    // Get all trial clients
    const trialClients = await base44.entities.Client.filter({ account_status: 'trial' });

    for (const client of trialClients) {
      if (!client.trial_end_date) continue;

      const trialEnd = new Date(client.trial_end_date);
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));

      // EXPIRED: Update status
      if (daysLeft <= 0) {
        await base44.entities.Client.update(client.id, {
          account_status: 'expired',
        });
        results.expired_updated.push({ client_id: client.id, company: client.company_name });

        // Send expiry email
        await sendEmail({
          to: client.email,
          subject: 'Your Getway AI trial has expired — special offer inside!',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">Getway AI</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">Your 7-day free trial has ended, but your AI agent and all your data are still safe with us.</p>
                <p style="color: #4a5568; line-height: 1.6;">Subscribe now to keep your AI voice agent running and never miss another lead.</p>
                <div style="background: #f7fafc; border-radius: 8px; padding: 20px; margin: 20px 0;">
                  <p style="margin: 0; color: #2d3748; font-weight: bold;">🎯 What you'll lose without subscribing:</p>
                  <ul style="color: #4a5568; line-height: 1.8;">
                    <li>AI agent stops taking calls</li>
                    <li>No new leads captured</li>
                    <li>CRM access paused</li>
                  </ul>
                </div>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="https://getway.ai" style="background: linear-gradient(135deg, #e67e22, #f39c12); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Subscribe Now — ₹6,500/mo</a>
                </div>
                <p style="color: #718096; font-size: 13px; text-align: center;">Questions? Reply to this email or call us.</p>
              </div>
            </div>
          `
        });
        results.emails_sent.push({ client_id: client.id, type: 'expired', email: client.email });
        continue;
      }

      // 3 DAYS LEFT: Send warning email
      if (daysLeft === 3) {
        await sendEmail({
          to: client.email,
          subject: `Only 3 days left on your Getway AI trial!`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">Getway AI</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">Your free trial ends in <strong>3 days</strong>. We hope you've been enjoying your AI voice agent!</p>
                <p style="color: #4a5568; line-height: 1.6;">Subscribe before your trial ends to ensure uninterrupted service.</p>
                <div style="background: #ebf8ff; border-left: 4px solid #3182ce; padding: 16px; margin: 20px 0; border-radius: 4px;">
                  <p style="margin: 0; color: #2c5282;"><strong>Pro tip:</strong> Upload more training documents to make your agent even smarter before going live!</p>
                </div>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="https://getway.ai" style="background: linear-gradient(135deg, #e67e22, #f39c12); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">View Subscription Plans</a>
                </div>
              </div>
            </div>
          `
        });
        results.emails_sent.push({ client_id: client.id, type: '3_day_warning', email: client.email });
      }

      // 1 DAY LEFT: Send urgent email + trigger retention agent call
      if (daysLeft === 1) {
        await sendEmail({
          to: client.email,
          subject: `⚠️ Last day of your Getway AI trial!`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #c53030, #e53e3e); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">⚠️ Trial Ending Today</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #c53030;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">This is your <strong>last day</strong> of the free trial. After today, your AI agent will stop handling calls.</p>
                <p style="color: #4a5568; line-height: 1.6;">Don't lose your setup — subscribe now to keep everything running.</p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="https://getway.ai" style="background: #c53030; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Subscribe Now</a>
                </div>
                <p style="color: #718096; font-size: 13px; text-align: center;">Our team may also reach out to help you get started.</p>
              </div>
            </div>
          `
        });
        results.emails_sent.push({ client_id: client.id, type: '1_day_urgent', email: client.email });

        // Create a retention activity for follow-up
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
        results.agents_triggered.push({ client_id: client.id, company: client.company_name });
      }
    }

    return Response.json({
      success: true,
      total_trial_clients: trialClients.length,
      ...results,
    });
  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});