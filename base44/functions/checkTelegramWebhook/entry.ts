import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    
    // If set_url provided, set the webhook
    if (body.set_url) {
      const setRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: body.set_url, allowed_updates: ['message', 'callback_query'] })
      });
      const setResult = await setRes.json();
      console.log('[checkTelegramWebhook] Set webhook:', JSON.stringify(setResult));
      return Response.json(setResult);
    }

    // If auto_fix is set, use the telegramWebhook function URL from the SDK
    if (body.auto_fix) {
      // Call telegramWebhook via SDK to get its deployment host
      try {
        const res = await base44.functions.invoke('telegramWebhook', {});
        console.log('[checkTelegramWebhook] telegramWebhook test:', JSON.stringify(res.data));
      } catch (e) {
        console.log('[checkTelegramWebhook] telegramWebhook invoke result:', e.message);
      }
    }
    
    // Get current webhook info
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
    const info = await res.json();
    console.log('[checkTelegramWebhook] Info:', JSON.stringify(info));
    return Response.json(info);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});