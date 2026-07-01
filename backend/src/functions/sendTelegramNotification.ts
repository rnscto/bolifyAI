import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.31';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

export default async function sendTelegramNotification(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Use service role directly — this function is always called internally
    // from smartfloWebhook (service-role) or other backend functions
    let base44;
    try {
      base44 = createClientFromRequest(req);
    } catch (_) {
      base44 = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    }

    const { client_id, caller_number, caller_name, category, urgency, summary, type } = await c.req.json();

    if (!client_id) {
      return c.json({ data: { error: 'client_id is required' } }, 400);
    }

    // Get client to check Telegram connection
    const client = await base44.asServiceRole.entities.Client.get(client_id);
    if (!client || !client.telegram_connected || !client.telegram_chat_id) {
      return c.json({ data: { sent: false, reason: 'Telegram not connected' } });
    }

    // Build notification message
    const notifType = type || 'call';
    let emoji = '📞';
    if (category === 'spam') emoji = '🚫';
    else if (category === 'family') emoji = '👨‍👩‍👧';
    else if (category === 'business') emoji = '💼';
    else if (category === 'promotional') emoji = '📢';
    else if (urgency === 'urgent') emoji = '🚨';

    let message = `${emoji} <b>Incoming Call</b>\n\n`;
    message += `📱 From: <b>${caller_name || caller_number || 'Unknown'}</b>\n`;
    if (caller_name && caller_number) message += `📞 Number: ${caller_number}\n`;
    if (category) message += `🏷️ Category: ${category}\n`;
    if (urgency && urgency !== 'medium') message += `⚡ Urgency: ${urgency.toUpperCase()}\n`;
    if (summary) message += `\n💬 ${summary}`;

    // Send via Telegram Bot API
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: client.telegram_chat_id,
        text: message,
        parse_mode: 'HTML'
      })
    });

    const result = await res.json();
    console.log(`[sendTelegramNotification] Sent to client ${client_id}: ok=${result.ok}`);

    return c.json({ data: { sent: result.ok } });
  } catch (error) {
    console.error('[sendTelegramNotification] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};