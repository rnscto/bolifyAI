import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

export default async function checkTelegramWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    
    // If set_url provided, set the webhook
    if (body.set_url) {
      const setRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: body.set_url, allowed_updates: ['message', 'callback_query'] })
      });
      const setResult = await setRes.json();
      console.log('[checkTelegramWebhook] Set webhook:', JSON.stringify(setResult));
      return c.json({ data: setResult });
    }
    
    // Otherwise, get current info
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
    const info = await res.json();
    console.log('[checkTelegramWebhook] Info:', JSON.stringify(info));
    return c.json({ data: info });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};