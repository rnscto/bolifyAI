import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');

Deno.serve(async (req) => {
  try {
    // Telegram sends webhook updates as POST
    if (req.method !== 'POST') {
      return Response.json({ ok: true, message: 'Telegram webhook endpoint' });
    }

    const body = await req.json();
    console.log('[telegramWebhook] Received:', JSON.stringify(body).slice(0, 500));

    const message = body.message;
    if (!message || !message.text) {
      return Response.json({ ok: true });
    }

    const chatId = String(message.chat.id);
    const text = message.text.trim();
    const username = message.from?.username || '';
    const firstName = message.from?.first_name || 'User';

    // Handle /start command with client_id deep link
    // Format: /start <client_id>
    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const clientId = parts[1]; // client_id passed as deep link parameter

      if (!clientId) {
        // No client ID — send instructions
        await sendTelegramMessage(chatId,
          `👋 Hello ${firstName}!\n\nTo connect your VaaniAI account, please use the connect link from your VaaniAI dashboard.\n\nThis will link your Telegram to receive live call notifications.`
        );
        return Response.json({ ok: true });
      }

      // Use service role to update client with telegram chat ID
      const base44 = createClientFromRequest(req);
      
      try {
        const client = await base44.asServiceRole.entities.Client.get(clientId);
        if (!client) {
          await sendTelegramMessage(chatId, '❌ Invalid link. Please try again from your VaaniAI dashboard.');
          return Response.json({ ok: true });
        }

        // Update client with telegram info
        await base44.asServiceRole.entities.Client.update(clientId, {
          telegram_chat_id: chatId,
          telegram_connected: true,
          telegram_username: username,
          owner_notification_channel: 'telegram'
        });

        await sendTelegramMessage(chatId,
          `✅ Connected successfully!\n\n🔔 You will now receive live call notifications here.\n\nAccount: ${client.company_name}\n\nYou can disconnect anytime from your VaaniAI dashboard.`
        );

        console.log(`[telegramWebhook] ✅ Client ${clientId} connected Telegram chat ${chatId}`);
      } catch (err) {
        console.error('[telegramWebhook] Error linking client:', err.message);
        await sendTelegramMessage(chatId, '❌ Something went wrong. Please try again from your dashboard.');
      }

      return Response.json({ ok: true });
    }

    // Handle /disconnect command
    if (text === '/disconnect') {
      const base44 = createClientFromRequest(req);
      
      try {
        const clients = await base44.asServiceRole.entities.Client.filter({ telegram_chat_id: chatId });
        if (clients.length > 0) {
          await base44.asServiceRole.entities.Client.update(clients[0].id, {
            telegram_chat_id: '',
            telegram_connected: false,
            telegram_username: '',
            owner_notification_channel: 'whatsapp'
          });
          await sendTelegramMessage(chatId, '🔕 Disconnected. You will no longer receive call notifications here.');
          console.log(`[telegramWebhook] Client ${clients[0].id} disconnected Telegram`);
        } else {
          await sendTelegramMessage(chatId, 'No VaaniAI account is linked to this chat.');
        }
      } catch (err) {
        console.error('[telegramWebhook] Disconnect error:', err.message);
      }

      return Response.json({ ok: true });
    }

    // Default response for any other message
    await sendTelegramMessage(chatId,
      `Hi ${firstName}! I'm the VaaniAI notification bot. I'll send you live call notifications here.\n\nCommands:\n/disconnect — Stop receiving notifications`
    );

    return Response.json({ ok: true });
  } catch (error) {
    console.error('[telegramWebhook] Error:', error.message);
    return Response.json({ ok: true }); // Always return 200 to Telegram
  }
});

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[telegramWebhook] Send failed:', err);
  }
}