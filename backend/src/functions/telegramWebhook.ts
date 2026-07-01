import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
const APP_ID = Deno.env.get('BASE44_APP_ID');

function getServiceClient() {
  return createClient({ appId: APP_ID, asServiceRole: true });
}

// Default status presets created on first use
const DEFAULT_PRESETS = [
  { title: 'In Meeting', icon: '🏢', caller_message_hindi: 'Sir abhi ek important meeting mein hain, meeting khatam hone ke baad aapko call back karenge. Kya aap koi message dena chahenge?' },
  { title: 'Driving', icon: '🚗', caller_message_hindi: 'Sir abhi driving kar rahe hain, drive khatam hone ke baad aapko call back karenge. Kya aap koi urgent message dena chahenge?' },
  { title: 'In Prayers', icon: '🙏', caller_message_hindi: 'Sir abhi pooja mein hain, pooja khatam hone ke baad aapko call karenge. Kya aap koi message dena chahenge?' },
  { title: 'At Home - Rituals', icon: '🪔', caller_message_hindi: 'Sir abhi ghar par kuch religious rituals mein busy hain, thodi der baad aapko call karenge. Kya aapka koi urgent kaam hai?' },
  { title: 'Sleeping / Rest', icon: '😴', caller_message_hindi: 'Sir abhi rest kar rahe hain. Kal subah aapko call karenge. Agar urgent hai to mujhe bata dijiye main unhe turant inform kar dungi.' },
  { title: 'Out of Station', icon: '✈️', caller_message_hindi: 'Sir abhi station se bahar hain, wapas aane par aapko call karenge. Kya aap koi message chhodna chahenge?' },
  { title: 'On Another Call', icon: '📞', caller_message_hindi: 'Sir abhi ek aur call par busy hain, call khatam hote hi aapko call back karenge. Kya aap koi message dena chahenge?' },
  { title: 'Lunch / Dinner', icon: '🍽️', caller_message_hindi: 'Sir abhi khana kha rahe hain, thodi der mein free honge. Kya aap koi message dena chahenge ya baad mein call karenge?' }
];

export default async function telegramWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    if (req.method !== 'POST') {
      return c.json({ data: { ok: true, message: 'Telegram webhook endpoint' } });
    }

    const body = await c.req.json();
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
          return c.json({ data: { ok: true } });
        }

        // Find client by telegram_chat_id
        let clients;
        try {
          clients = await svc.entities.Client.filter({ telegram_chat_id: chatId });
          console.log(`[telegramWebhook] Found ${clients.length} clients for chatId=${chatId}`);
        } catch (filterErr) {
          console.error(`[telegramWebhook] ❌ Client filter failed:`, filterErr.message);
          await sendTelegramMessage(chatId, '❌ Could not find your account. Please reconnect from dashboard.');
          return c.json({ data: { ok: true } });
        }
        if (clients.length === 0) {
          await sendTelegramMessage(chatId, '❌ No linked account found.');
          return c.json({ data: { ok: true } });
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
          return c.json({ data: { ok: true } });
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

      // ═══ HANDLE STATUS BUTTON CALLBACKS ═══
      if (data.startsWith('status:')) {
        const parts = data.split(':');
        const statusId = parts[1];
        const action = parts[2]; // activate, clear, create

        let svc;
        try { svc = getServiceClient(); } catch (_) { return c.json({ data: { ok: true } }); }

        const clients = await svc.entities.Client.filter({ telegram_chat_id: chatId });
        if (clients.length === 0) { await sendTelegramMessage(chatId, '❌ No linked account.'); return c.json({ data: { ok: true } }); }
        const client = clients[0];

        if (action === 'clear') {
          // Deactivate all statuses
          const activeStatuses = await svc.entities.OwnerStatus.filter({ client_id: client.id, is_active: true });
          for (const as of activeStatuses) {
            await svc.entities.OwnerStatus.update(as.id, { is_active: false });
          }
          await editMessageButtons(chatId, cq.message.message_id, '✅ Status cleared! You are now <b>Available</b>.\n\nAI will handle calls normally.');
        } else if (action === 'create') {
          await editMessageButtons(chatId, cq.message.message_id,
            `✏️ <b>Create Custom Status</b>\n\nSend a message in this format:\n<code>/customstatus Title | Time | Hindi Message</code>\n\nExample:\n<code>/customstatus Bank Meeting | 1 PM to 3 PM | Sir bank meeting mein hain 3 baje tak busy hain</code>`
          );
        } else if (action === 'activate') {
          // Deactivate all, then activate selected
          const activeStatuses = await svc.entities.OwnerStatus.filter({ client_id: client.id, is_active: true });
          for (const as of activeStatuses) {
            await svc.entities.OwnerStatus.update(as.id, { is_active: false });
          }
          const status = await svc.entities.OwnerStatus.get(statusId);
          await svc.entities.OwnerStatus.update(statusId, { is_active: true });
          await editMessageButtons(chatId, cq.message.message_id,
            `${status.icon} <b>Status: ${status.title}</b>\n\n💬 AI will tell callers:\n<i>"${status.caller_message_hindi}"</i>\n\nUse /status to change or /clearstatus to clear.`
          );
          console.log(`[telegramWebhook] ✅ Status activated: ${status.title} for client ${client.id}`);
        }

        return c.json({ data: { ok: true } });
      }

      return c.json({ data: { ok: true } });
    }

    // ═══ HANDLE TEXT MESSAGES ═══
    const message = body.message;
    if (!message || !message.text) {
      return c.json({ data: { ok: true } });
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
        return c.json({ data: { ok: true } });
      }

      const svcStart = getServiceClient();
      try {
        const client = await svcStart.entities.Client.get(clientId);
        if (!client) {
          await sendTelegramMessage(chatId, '❌ Invalid link. Please try again from your VaaniAI dashboard.');
          return c.json({ data: { ok: true } });
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
      return c.json({ data: { ok: true } });
    }

    // Handle /disconnect command
    // Also handle persistent keyboard button "🔕 Disconnect"
    if (text === '/disconnect' || text === '🔕 Disconnect') {
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
      return c.json({ data: { ok: true } });
    }

    // ═══ HANDLE /status COMMAND — Show status menu ═══
    // Also handle persistent keyboard button "🎯 Set Status"
    if (text === '/status' || text === '/setstatus' || text === '🎯 Set Status') {
      const svcStatus = getServiceClient();
      try {
        const clients = await svcStatus.entities.Client.filter({ telegram_chat_id: chatId });
        if (clients.length === 0) { await sendTelegramMessage(chatId, '❌ No linked account.'); return c.json({ data: { ok: true } }); }
        const client = clients[0];

        // Ensure presets exist
        await ensurePresetsExist(svcStatus, client.id);

        // Get all presets + active status
        const statuses = await svcStatus.entities.OwnerStatus.filter({ client_id: client.id, is_preset: true });
        const activeStatus = statuses.find(s => s.is_active);

        let msg = '🎯 <b>Set Your Status</b>\n\n';
        if (activeStatus) {
          msg += `Current: ${activeStatus.icon} <b>${activeStatus.title}</b>\n${activeStatus.caller_message_hindi}\n\n`;
        } else {
          msg += 'Current: ✅ <b>Available</b> (no status set)\n\n';
        }
        msg += '👇 Tap a status or use /customstatus';

        const buttons = [];
        // Show presets in 2-column rows
        for (let i = 0; i < statuses.length; i += 2) {
          const row = [{ text: `${statuses[i].icon} ${statuses[i].title}`, callback_data: `status:${statuses[i].id}:activate` }];
          if (statuses[i + 1]) row.push({ text: `${statuses[i + 1].icon} ${statuses[i + 1].title}`, callback_data: `status:${statuses[i + 1].id}:activate` });
          buttons.push(row);
        }
        // Add clear status + custom status buttons
        buttons.push([
          { text: '✅ Clear Status (Available)', callback_data: 'status:clear:clear' },
          { text: '✏️ Custom Status', callback_data: 'status:custom:create' }
        ]);

        await sendTelegramMessage(chatId, msg, { inline_keyboard: buttons });
      } catch (err) {
        console.error('[telegramWebhook] Status error:', err.message);
        await sendTelegramMessage(chatId, '❌ Error loading statuses.');
      }
      return c.json({ data: { ok: true } });
    }

    // ═══ HANDLE /customstatus COMMAND — Create custom status ═══
    // Also handle persistent keyboard button "✏️ Custom Status"
    if (text === '✏️ Custom Status') {
      await sendTelegramMessage(chatId,
        `✏️ <b>Create Custom Status</b>\n\nFormat:\n<code>/customstatus Title | Time | Hindi Message</code>\n\nExamples:\n<code>/customstatus Bank Meeting | 1 PM to 3 PM | Sir bank meeting mein hain 3 baje tak busy hain</code>\n\n<code>/customstatus Hospital Visit | 2 hours | Sir hospital gaye hain 2 ghante mein wapas aayenge</code>`
      );
      return c.json({ data: { ok: true } });
    }
    if (text.startsWith('/customstatus')) {
      const svcCS = getServiceClient();
      try {
        const clients = await svcCS.entities.Client.filter({ telegram_chat_id: chatId });
        if (clients.length === 0) { await sendTelegramMessage(chatId, '❌ No linked account.'); return c.json({ data: { ok: true } }); }
        const client = clients[0];

        // Parse: /customstatus Meeting with Bank | 1:00 PM to 3:00 PM | Sir bank meeting mein hain 3 baje tak
        const parts = text.replace('/customstatus', '').trim();
        if (!parts) {
          await sendTelegramMessage(chatId,
            `✏️ <b>Create Custom Status</b>\n\nFormat:\n<code>/customstatus Title | Time | Hindi Message</code>\n\nExamples:\n<code>/customstatus Bank Meeting | 1 PM to 3 PM | Sir bank meeting mein hain 3 baje tak busy hain</code>\n\n<code>/customstatus Hospital Visit | 2 hours | Sir hospital gaye hain 2 ghante mein wapas aayenge</code>\n\n<code>/customstatus Family Function | Full day | Sir aaj family function mein hain kal call karenge</code>`
          );
          return c.json({ data: { ok: true } });
        }

        const segments = parts.split('|').map(s => s.trim());
        const title = segments[0] || 'Busy';
        const timeRange = segments[1] || '';
        const callerMsg = segments[2] || `Sir abhi ${title.toLowerCase()} mein busy hain. Baad mein call karenge. Kya aap koi message dena chahenge?`;

        // Deactivate any current active status
        const activeStatuses = await svcCS.entities.OwnerStatus.filter({ client_id: client.id, is_active: true });
        for (const as of activeStatuses) {
          await svcCS.entities.OwnerStatus.update(as.id, { is_active: false });
        }

        // Create and activate new custom status
        await svcCS.entities.OwnerStatus.create({
          client_id: client.id,
          title: title,
          caller_message_hindi: callerMsg,
          is_active: true,
          is_preset: false,
          icon: '📋',
          start_time: timeRange ? timeRange.split('to')[0]?.trim() : '',
          end_time: timeRange ? (timeRange.split('to')[1]?.trim() || '') : ''
        });

        const timeInfo = timeRange ? `\n⏰ Time: ${timeRange}` : '';
        await sendTelegramMessage(chatId,
          `✅ <b>Status Set!</b>\n\n📋 <b>${title}</b>${timeInfo}\n💬 AI will tell callers:\n<i>"${callerMsg}"</i>\n\nUse /status to change or clear.`
        );
      } catch (err) {
        console.error('[telegramWebhook] Custom status error:', err.message);
        await sendTelegramMessage(chatId, '❌ Error creating status.');
      }
      return c.json({ data: { ok: true } });
    }

    // ═══ HANDLE /clearstatus COMMAND ═══
    // Also handle persistent keyboard button "✅ Clear Status"
    if (text === '/clearstatus' || text === '/available' || text === '✅ Clear Status') {
      const svcClear = getServiceClient();
      try {
        const clients = await svcClear.entities.Client.filter({ telegram_chat_id: chatId });
        if (clients.length === 0) { await sendTelegramMessage(chatId, '❌ No linked account.'); return c.json({ data: { ok: true } }); }
        const activeStatuses = await svcClear.entities.OwnerStatus.filter({ client_id: clients[0].id, is_active: true });
        for (const as of activeStatuses) {
          await svcClear.entities.OwnerStatus.update(as.id, { is_active: false });
        }
        await sendTelegramMessage(chatId, '✅ Status cleared! You are now <b>Available</b>. AI will handle calls normally.');
      } catch (err) {
        await sendTelegramMessage(chatId, '❌ Error clearing status.');
      }
      return c.json({ data: { ok: true } });
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
          return c.json({ data: { ok: true } });
        }

        // Check if there's ANY pending decision (user sending custom instruction)
        const anyPending = pendingDecisions.find(d => d.decision === 'custom' && d.custom_message === '__AWAITING_MESSAGE__');
        if (anyPending) {
          await svcPending.entities.CallDecision.update(anyPending.id, {
            custom_message: text
          });
          await sendTelegramMessage(chatId, `✅ AI will relay your message to the caller.`);
          return c.json({ data: { ok: true } });
        }
      }
    } catch (err) {
      console.log(`[telegramWebhook] Pending decision check: ${err.message}`);
    }

    // ═══ CHECK IF THIS IS A LIVE CALL CUSTOM INSTRUCTION ═══
    // If there's an active (non-completed) call for this client, treat free text as a live instruction
    try {
      const clients = await svcPending.entities.Client.filter({ telegram_chat_id: chatId });
      if (clients.length > 0) {
        const client = clients[0];
        // Find active call logs (answered, not completed) from last 10 minutes
        const recentCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const activeLogs = await svcPending.entities.CallLog.filter({ client_id: client.id, status: 'answered' }, '-created_date', 5);
        const liveCall = activeLogs.find(l => l.created_date >= recentCutoff);
        if (liveCall) {
          // Create a custom_message decision that the polling loop will pick up
          await svcPending.entities.CallDecision.create({
            call_log_id: liveCall.id,
            client_id: client.id,
            decision: 'custom_message',
            status: 'pending',
            custom_message: text
          });
          await sendTelegramMessage(chatId, `💬 <b>Sent to AI:</b> "${text.substring(0, 100)}"

AI will incorporate this into the live call.`);
          console.log(`[telegramWebhook] ✅ Live instruction sent for call ${liveCall.id}: "${text.substring(0, 80)}"`);
          return c.json({ data: { ok: true } });
        }
      }
    } catch (err) {
      console.log(`[telegramWebhook] Live instruction check: ${err.message}`);
    }

    // Default response for any other message
    await sendTelegramMessage(chatId,
      `Hi ${firstName}! I'm the VaaniAI notification bot.\n\n🎯 <b>Status Commands:</b>\n/status — Set your availability status\n/customstatus — Create custom status\n/clearstatus — Clear status (Available)\n\n📞 <b>During Live Calls:</b>\nUse buttons to control AI, or just type a message to instruct the AI in real-time!\n\n⚙️ <b>Other:</b>\n/disconnect — Stop notifications`
    );

    return c.json({ data: { ok: true } });
  } catch (error) {
    console.error('[telegramWebhook] Error:', error.message);
    return c.json({ data: { ok: true } });
  }

};

async function ensurePresetsExist(svc, clientId) {
  const existing = await svc.entities.OwnerStatus.filter({ client_id: clientId, is_preset: true });
  if (existing.length >= 5) return; // Already has presets
  // Create default presets
  for (const preset of DEFAULT_PRESETS) {
    const exists = existing.find(e => e.title === preset.title);
    if (!exists) {
      await svc.entities.OwnerStatus.create({
        client_id: clientId,
        title: preset.title,
        icon: preset.icon,
        caller_message_hindi: preset.caller_message_hindi,
        is_active: false,
        is_preset: true
      });
    }
  }
  console.log(`[telegramWebhook] ✅ Presets ensured for client ${clientId}`);
}

// Persistent reply keyboard — always visible at bottom of Telegram chat
const PERSISTENT_KEYBOARD = {
  keyboard: [
    [{ text: '🎯 Set Status' }, { text: '✅ Clear Status' }],
    [{ text: '✏️ Custom Status' }, { text: '🔕 Disconnect' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) {
    // If inline buttons are provided, use them (for status selection, call decisions, etc.)
    payload.reply_markup = replyMarkup;
  } else {
    // Otherwise always show the persistent keyboard
    payload.reply_markup = PERSISTENT_KEYBOARD;
  }
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