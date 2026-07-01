import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

export default async function setupTelegramWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const { webhook_url } = await c.req.json();
    if (!webhook_url) {
      return c.json({ data: { error: 'webhook_url is required' } }, 400);
    }

    // Set the Telegram webhook
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhook_url,
        allowed_updates: ['message', 'callback_query']
      })
    });

    const result = await res.json();
    console.log('[setupTelegramWebhook] Result:', JSON.stringify(result));

    return c.json({ data: result });
  } catch (error) {
    console.error('[setupTelegramWebhook] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};