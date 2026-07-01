import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { EmailClient } from 'npm:@azure/communication-email@1.0.0';

const connStr = `endpoint=${Deno.env.get('AZURE_COMM_ENDPOINT')};accesskey=${Deno.env.get('AZURE_COMM_KEY')}`;
const emailClient = new EmailClient(connStr);

async function sendEmail({ to, subject, html, displayName }) {
  const message = {
    senderAddress: 'DoNotReply@vaaniai.io',
    displayName: displayName || 'VaaniAI',
    content: { subject, html },
    recipients: { to: [{ address: to }] }
  };
  const poller = await emailClient.beginSend(message);
  const result = await poller.pollUntilDone();
  if (result.status !== 'Succeeded') throw new Error(`ACS Email error: ${result.error?.message || result.status}`);
  return result;
}

export default async function retentionFollowup(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');

    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const results = { followups_sent: [] };

    // Get expired clients who haven't subscribed yet
    const expiredClients = await base44.asServiceRole.entities.Client.filter({ account_status: 'expired' });

    for (const client of expiredClients) {
      if (!client.trial_end_date) continue;

      const trialEnd = new Date(client.trial_end_date);
      const now = new Date();
      const daysSinceExpiry = Math.floor((now - trialEnd) / (1000 * 60 * 60 * 24));

      // Day 3 after expiry: Follow-up email
      if (daysSinceExpiry === 3) {
        await sendEmail({
          to: client.email,
          subject: `We miss you at VaaniAI — your agent is waiting`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">VaaniAI</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">It's been 3 days since your trial ended. Your AI agent and all your training data are still saved.</p>
                <p style="color: #4a5568; line-height: 1.6;">Reactivate now and pick up right where you left off — no setup needed.</p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="https://vaaniai.in" style="background: linear-gradient(135deg, #e67e22, #f39c12); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Reactivate My Account</a>
                </div>
                <p style="color: #718096; font-size: 13px; text-align: center;">Need help? Just reply to this email.</p>
              </div>
            </div>
          `
        });
        results.followups_sent.push({ client_id: client.id, type: 'day_3_followup', email: client.email });
      }

      // Day 7 after expiry: Last chance email
      if (daysSinceExpiry === 7) {
        await sendEmail({
          to: client.email,
          subject: `Last chance: Your VaaniAI data will be archived soon`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #1a365d, #2d3748); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">VaaniAI</h1>
              </div>
              <div style="padding: 30px; background: white; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1a365d;">Hi ${client.company_name},</h2>
                <p style="color: #4a5568; line-height: 1.6;">It's been a week since your trial ended. We'll be archiving your agent configuration and training data soon.</p>
                <p style="color: #4a5568; line-height: 1.6;">If you'd like to keep your setup, please subscribe before it's too late.</p>
                <div style="background: #fff5f5; border-left: 4px solid #e53e3e; padding: 16px; margin: 20px 0; border-radius: 4px;">
                  <p style="margin: 0; color: #c53030;"><strong>Your data will be archived after 14 days.</strong> Subscribe to keep everything.</p>
                </div>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="https://vaaniai.in" style="background: #c53030; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Subscribe & Keep My Data</a>
                </div>
              </div>
            </div>
          `
        });
        results.followups_sent.push({ client_id: client.id, type: 'day_7_last_chance', email: client.email });
      }
    }

    return c.json({ data: {
      success: true,
      total_expired_clients: expiredClients.length,
      ...results,
    } });
  } catch (error) {
    console.error('Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};