import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const { webhook_url } = await req.json();
    if (!webhook_url) {
      return Response.json({ error: 'webhook_url is required' }, { status: 400 });
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

    return Response.json(result);
  } catch (error) {
    console.error('[setupTelegramWebhook] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});