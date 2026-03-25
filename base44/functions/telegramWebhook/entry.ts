import { createClient } from 'npm:@base44/sdk@0.8.23';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
const APP_ID = Deno.env.get('BASE44_APP_ID');

function getServiceClient() {
  return createClient({ appId: APP_ID, asServiceRole: true });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return Response.json({ ok: true, message: 'Telegram webhook endpoint' });
    }

    const body = await req.json();
    console.log('[telegramWebhook] Received:', JSON.stringify(body).slice(0, 500));

    // ═══ HANDLE INLINE BUTTON CALLBACK (call decision buttons) ═══
    if (body.callback_query) {
      const cq = body.callback_query;
      const chatId = String(cq.message?.chat?.id || cq.from?.id);
      const data = cq.data || '';
      const callbackId = cq.id;
      console.log(`[telegramWebhook] Callback query: data="${data}", chat=${chatId}`);

      // Answer the callback to remove loading state on button
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackId })
      });

      // Parse: "decision:callLogId:action" e.g. "decision:abc123:transfer"
      if (data.startsWith('decision:')) {
        const parts = data.split(':');
        const callLogId = parts[1];
        const action = parts[2]; // transfer, callback, take_message, block
        console.log(`[telegramWebhook] Processing decision: action=${action}, callLogId=${callLogId}, chatId=${chatId}`);

        let svc;
        try {
          svc = getServiceClient();
        } catch (initErr) {
          console.error(`[telegramWebhook] ❌ Service client init failed:`, initErr.message);
          await sendTelegramMessage(chatId, '❌ Internal error. Please try again.');
          return Response.json({ ok: true });
        }

        // Find client by telegram_chat_id
        let clients;
        try {
          clients = await svc.entities.Client.filter({ telegram_chat_id: chatId });
          console.log(`[telegramWebhook] Found ${clients.length} clients for chatId=${chatId}`);
        } catch (filterErr) {
          console.error(`[telegramWebhook] ❌ Client filter failed:`, filterErr.message);
          await sendTelegramMessage(chatId, '❌ Could not find your account. Please reconnect from dashboard.');
          return Response.json({ ok: true });
        }
        if (clients.length === 0) {
          await sendTelegramMessage(chatId, '❌ No linked account found.');
          return Response.json({ ok: true });
        }
        const client = clients[0];
        console.log(`[telegramWebhook] Client found: ${client.id} (${client.company_name})`);

        if (action === 'callback') {
          // Ask for callback time
          await sendTelegramMessage(chatId,
            `⏰ <b>Callback selected</b>\n\nReply with the time, e.g.:\n• <code>5 minutes</code>\n• <code>1 hour</code>\n• <code>tomorrow morning</code>\n\nOr type any custom message for the caller.`
          );
          // Store pending callback decision — will be completed when user replies with time
          await svc.entities.CallDecision.create({
            call_log_id: callLogId,
            client_id: client.id,
            decision: 'callback',
            status: 'pending',
            custom_message: '__AWAITING_TIME__'
          });
          // Update the original message to show selection
          await editMessageButtons(chatId, cq.message.message_id, `⏰ <b>Call Back selected</b>\n\nReply mein time bataiye jaise:\n• 5 minutes\n• 1 hour\n• kal subah`);
          return Response.json({ ok: true });
        }

        // For transfer, take_message, block — create decision immediately
        const decisionConfirms = {
          transfer: { label: '📞 Transfer to You', detail: 'AI caller ko bol rahi hai ki aapka call transfer ho raha hai...' },
          take_message: { label: '📝 Take Message', detail: 'AI caller se message le rahi hai aapke liye...' },
          block: { label: '🚫 Block/End Call', detail: 'AI call politely end kar rahi hai...' }
        };

        try {
          const created = await svc.entities.CallDecision.create({
            call_log_id: callLogId,
            client_id: client.id,
            decision: action,
            status: 'pending'
          });
          console.log(`[telegramWebhook] ✅ Decision created: id=${created.id}, action=${action}, callLog=${callLogId}`);

          const conf = decisionConfirms[action] || { label: action, detail: 'AI is executing...' };
          await editMessageButtons(chatId, cq.message.message_id, `✅ <b>${conf.label}</b>\n\n${conf.detail}`);
        } catch (createErr) {
          console.error(`[telegramWebhook] ❌ Decision creation failed:`, createErr.message);
          await sendTelegramMessage(chatId, `❌ Failed to submit decision. Error: ${createErr.message}`);
        }
      }

      return Response.json({ ok: true });
    }

    // ═══ HANDLE TEXT MESSAGES ═══
    const message = body.message;
    if (!message || !message.text) {
      return Response.json({ ok: true });
    }

    const chatId = String(message.chat.id);
    const text = message.text.trim();
    const username = message.from?.username || '';
    const firstName = message.from?.first_name || 'User';

    // Handle /start command with client_id deep link
    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const clientId = parts[1];

      if (!clientId) {
        await sendTelegramMessage(chatId,
          `👋 Hello ${firstName}!\n\nTo connect your VaaniAI account, please use the connect link from your VaaniAI dashboard.\n\nThis will link your Telegram to receive live call notifications.`
        );
        return Response.json({ ok: true });
      }

      const svcStart = getServiceClient();
      try {
        const client = await svcStart.entities.Client.get(clientId);
        if (!client) {
          await sendTelegramMessage(chatId, '❌ Invalid link. Please try again from your VaaniAI dashboard.');
          return Response.json({ ok: true });
        }

        await svcStart.entities.Client.update(clientId, {
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
      const svcDisc = getServiceClient();
      try {
        const clients = await svcDisc.entities.Client.filter({ telegram_chat_id: chatId });
        if (clients.length > 0) {
          await svcDisc.entities.Client.update(clients[0].id, {
            telegram_chat_id: '',
            telegram_connected: false,
            telegram_username: '',
            owner_notification_channel: 'whatsapp'
          });
          await sendTelegramMessage(chatId, '🔕 Disconnected. You will no longer receive call notifications here.');
        } else {
          await sendTelegramMessage(chatId, 'No VaaniAI account is linked to this chat.');
        }
      } catch (err) {
        console.error('[telegramWebhook] Disconnect error:', err.message);
      }
      return Response.json({ ok: true });
    }

    // ═══ CHECK IF THIS IS A REPLY TO A PENDING CALLBACK DECISION ═══
    // If the user sends a text message and there's a pending callback decision awaiting time
    const svcPending = getServiceClient();
    try {
      const clients = await svcPending.entities.Client.filter({ telegram_chat_id: chatId });
      if (clients.length > 0) {
        const client = clients[0];
        // Find pending callback decisions awaiting time
        const pendingDecisions = await svcPending.entities.CallDecision.filter({
          client_id: client.id,
          decision: 'callback',
          status: 'pending'
        });
        const awaitingTime = pendingDecisions.find(d => d.custom_message === '__AWAITING_TIME__');

        if (awaitingTime) {
          // This text message is the callback time/custom message
          await svcPending.entities.CallDecision.update(awaitingTime.id, {
            custom_message: text,
            callback_time: text
          });
          await sendTelegramMessage(chatId,
            `✅ Got it! AI will tell the caller: <b>"Will call back in ${text}"</b>`
          );
          console.log(`[telegramWebhook] ✅ Callback time set: "${text}" for CallDecision ${awaitingTime.id}`);
          return Response.json({ ok: true });
        }

        // Check if there's ANY pending decision (user sending custom instruction)
        const anyPending = pendingDecisions.find(d => d.decision === 'custom' && d.custom_message === '__AWAITING_MESSAGE__');
        if (anyPending) {
          await svcPending.entities.CallDecision.update(anyPending.id, {
            custom_message: text
          });
          await sendTelegramMessage(chatId, `✅ AI will relay your message to the caller.`);
          return Response.json({ ok: true });
        }
      }
    } catch (err) {
      console.log(`[telegramWebhook] Pending decision check: ${err.message}`);
    }

    // Default response for any other message
    await sendTelegramMessage(chatId,
      `Hi ${firstName}! I'm the VaaniAI notification bot. I'll send you live call notifications here.\n\nDuring a live call, use the buttons to control what AI does.\n\nCommands:\n/disconnect — Stop receiving notifications`
    );

    return Response.json({ ok: true });
  } catch (error) {
    console.error('[telegramWebhook] Error:', error.message);
    return Response.json({ ok: true });
  }
});

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[telegramWebhook] Send failed:', err);
  }
  return res;
}

async function editMessageButtons(chatId, messageId, newText) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: newText,
      parse_mode: 'HTML'
    })
  });
}