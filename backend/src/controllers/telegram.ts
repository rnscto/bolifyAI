import { Context, Hono } from "hono";
import { jwt } from "hono/jwt";
import { base44ORM as base44 } from "../db/orm.ts";

export const telegramRouter = new Hono();

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

const DEFAULT_PRESETS = [
  { title: "In Meeting", icon: "🏢", caller_message_hindi: "Sir abhi ek important meeting mein hain, meeting khatam hone ke baad aapko call back karenge. Kya aap koi message dena chahenge?" },
  { title: "Driving", icon: "🚗", caller_message_hindi: "Sir abhi driving kar rahe hain, drive khatam hone ke baad aapko call back karenge. Kya aap koi urgent message dena chahenge?" },
  { title: "In Prayers", icon: "🙏", caller_message_hindi: "Sir abhi pooja mein hain, pooja khatam hone ke baad aapko call karenge. Kya aap koi message dena chahenge?" },
  { title: "At Home - Rituals", icon: "🪔", caller_message_hindi: "Sir abhi ghar par kuch religious rituals mein busy hain, thodi der baad aapko call karenge. Kya aapka koi urgent kaam hai?" },
  { title: "Sleeping / Rest", icon: "😴", caller_message_hindi: "Sir abhi rest kar rahe hain. Kal subah aapko call karenge. Agar urgent hai to mujhe bata dijiye main unhe turant inform kar dungi." },
  { title: "Out of Station", icon: "✈️", caller_message_hindi: "Sir abhi station se bahar hain, wapas aane par aapko call karenge. Kya aap koi message chhodna chahenge?" },
  { title: "On Another Call", icon: "📞", caller_message_hindi: "Sir abhi ek aur call par busy hain, call khatam hote hi aapko call back karenge. Kya aap koi message dena chahenge?" },
  { title: "Lunch / Dinner", icon: "🍽️", caller_message_hindi: "Sir abhi khana kha rahe hain, thodi der mein free honge. Kya aap koi message dena chahenge ya baad mein call karenge?" }
];

const PERSISTENT_KEYBOARD = {
  keyboard: [
    [{ text: "🎯 Set Status" }, { text: "✅ Clear Status" }],
    [{ text: "✏️ Custom Status" }, { text: "🔕 Disconnect" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: any) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload: any = { chat_id: chatId, text, parse_mode: "HTML" };
  payload.reply_markup = replyMarkup || PERSISTENT_KEYBOARD;
  
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function editMessageButtons(chatId: string, messageId: string, newText: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: newText, parse_mode: "HTML" })
  });
}

async function ensurePresetsExist(clientId: string) {
  const existing = await base44.entities.OwnerStatus.filter({ client_id: clientId, is_preset: true });
  if (existing.length >= 5) return;
  for (const preset of DEFAULT_PRESETS) {
    if (!existing.find((e: any) => e.title === preset.title)) {
      await base44.entities.OwnerStatus.create({
        client_id: clientId, title: preset.title, icon: preset.icon, caller_message_hindi: preset.caller_message_hindi,
        is_active: false, is_preset: true
      });
    }
  }
}

// POST /api/telegram/setup
telegramRouter.post("/setup", jwt({ secret: JWT_SECRET, alg: "HS256" }), async (c) => {
  const user = c.get("jwtPayload") as any;
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const { webhook_url } = await c.req.json();
  if (!webhook_url) return c.json({ error: "webhook_url required" }, 400);

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhook_url, allowed_updates: ["message", "callback_query"] })
  });
  const data = await res.json();
  return c.json(data);
});

// POST /api/telegram/webhook
telegramRouter.post("/webhook", async (c) => {
  try {
    const body = await c.req.json();
    
    // Callback Query
    if (body.callback_query) {
      const cq = body.callback_query;
      const chatId = String(cq.message?.chat?.id || cq.from?.id);
      const data = cq.data || "";

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cq.id })
      });

      if (data.startsWith("decision:")) {
        const parts = data.split(":");
        const callLogId = parts[1];
        const action = parts[2];
        const clients = await base44.entities.Client.filter({ telegram_chat_id: chatId });
        if (!clients.length) return c.json({ ok: true });
        const client = clients[0];

        if (action === "callback") {
          await sendTelegramMessage(chatId, "⏰ <b>Callback selected</b>\n\nReply with time.");
          await base44.entities.CallDecision.create({ call_log_id: callLogId, client_id: client.id, decision: "callback", status: "pending", custom_message: "__AWAITING_TIME__" });
          await editMessageButtons(chatId, cq.message.message_id, "⏰ <b>Call Back selected</b>\n\nReply mein time bataiye");
        } else {
          await base44.entities.CallDecision.create({ call_log_id: callLogId, client_id: client.id, decision: action, status: "pending" });
          await editMessageButtons(chatId, cq.message.message_id, `✅ <b>Decision: ${action}</b>`);
        }
      }

      if (data.startsWith("status:")) {
        const parts = data.split(":");
        const statusId = parts[1];
        const action = parts[2];
        const clients = await base44.entities.Client.filter({ telegram_chat_id: chatId });
        if (!clients.length) return c.json({ ok: true });
        const client = clients[0];

        if (action === "clear") {
          const actives = await base44.entities.OwnerStatus.filter({ client_id: client.id, is_active: true });
          for (const s of actives) await base44.entities.OwnerStatus.update(s.id, { is_active: false });
          await editMessageButtons(chatId, cq.message.message_id, "✅ Status cleared! You are now Available.");
        } else if (action === "activate") {
          const actives = await base44.entities.OwnerStatus.filter({ client_id: client.id, is_active: true });
          for (const s of actives) await base44.entities.OwnerStatus.update(s.id, { is_active: false });
          const status = await base44.entities.OwnerStatus.get(statusId);
          await base44.entities.OwnerStatus.update(statusId, { is_active: true });
          await editMessageButtons(chatId, cq.message.message_id, `${status.icon} <b>Status: ${status.title}</b>`);
        }
      }
      return c.json({ ok: true });
    }

    // Text messages
    if (!body.message?.text) return c.json({ ok: true });
    const message = body.message;
    const chatId = String(message.chat.id);
    const text = message.text.trim();

    if (text.startsWith("/start")) {
      const clientId = text.split(" ")[1];
      if (!clientId) {
         await sendTelegramMessage(chatId, "Please connect from your dashboard.");
         return c.json({ ok: true });
      }
      const client = await base44.entities.Client.get(clientId);
      if (client) {
         await base44.entities.Client.update(clientId, { telegram_chat_id: chatId, telegram_connected: true, owner_notification_channel: "telegram" });
         await sendTelegramMessage(chatId, "✅ Connected successfully!");
      }
      return c.json({ ok: true });
    }

    if (text === "/disconnect" || text === "🔕 Disconnect") {
      const clients = await base44.entities.Client.filter({ telegram_chat_id: chatId });
      if (clients.length) {
         await base44.entities.Client.update(clients[0].id, { telegram_chat_id: "", telegram_connected: false, owner_notification_channel: "whatsapp" });
         await sendTelegramMessage(chatId, "🔕 Disconnected.");
      }
      return c.json({ ok: true });
    }

    if (text === "/status" || text === "/setstatus" || text === "🎯 Set Status") {
      const clients = await base44.entities.Client.filter({ telegram_chat_id: chatId });
      if (!clients.length) return c.json({ ok: true });
      const client = clients[0];
      await ensurePresetsExist(client.id);
      
      const statuses = await base44.entities.OwnerStatus.filter({ client_id: client.id, is_preset: true });
      const buttons = [];
      for (let i = 0; i < statuses.length; i += 2) {
        const row = [{ text: `${statuses[i].icon} ${statuses[i].title}`, callback_data: `status:${statuses[i].id}:activate` }];
        if (statuses[i + 1]) row.push({ text: `${statuses[i + 1].icon} ${statuses[i + 1].title}`, callback_data: `status:${statuses[i + 1].id}:activate` });
        buttons.push(row);
      }
      buttons.push([{ text: "✅ Clear Status", callback_data: "status:clear:clear" }]);
      await sendTelegramMessage(chatId, "🎯 <b>Set Your Status</b>", { inline_keyboard: buttons });
      return c.json({ ok: true });
    }

    if (text.startsWith("/customstatus")) {
      const parts = text.replace("/customstatus", "").trim().split("|").map((s: string) => s.trim());
      const title = parts[0] || "Busy";
      const callerMsg = parts[2] || `Sir abhi busy hain.`;
      const clients = await base44.entities.Client.filter({ telegram_chat_id: chatId });
      if (!clients.length) return c.json({ ok: true });
      const client = clients[0];

      const actives = await base44.entities.OwnerStatus.filter({ client_id: client.id, is_active: true });
      for (const s of actives) await base44.entities.OwnerStatus.update(s.id, { is_active: false });

      await base44.entities.OwnerStatus.create({ client_id: client.id, title, caller_message_hindi: callerMsg, is_active: true, is_preset: false, icon: "📋" });
      await sendTelegramMessage(chatId, `✅ <b>Status Set!</b>\n📋 <b>${title}</b>`);
      return c.json({ ok: true });
    }

    if (text === "/clearstatus" || text === "✅ Clear Status") {
      const clients = await base44.entities.Client.filter({ telegram_chat_id: chatId });
      if (clients.length) {
         const actives = await base44.entities.OwnerStatus.filter({ client_id: clients[0].id, is_active: true });
         for (const s of actives) await base44.entities.OwnerStatus.update(s.id, { is_active: false });
         await sendTelegramMessage(chatId, "✅ Status cleared! You are now Available.");
      }
      return c.json({ ok: true });
    }

    // Pending callback
    const clients = await base44.entities.Client.filter({ telegram_chat_id: chatId });
    if (clients.length) {
       const client = clients[0];
       const pending = await base44.entities.CallDecision.filter({ client_id: client.id, decision: "callback", status: "pending" });
       const awaiting = pending.find((d: any) => d.custom_message === "__AWAITING_TIME__");
       if (awaiting) {
         await base44.entities.CallDecision.update(awaiting.id, { custom_message: text, callback_time: text });
         await sendTelegramMessage(chatId, `✅ Callback time set to ${text}`);
         return c.json({ ok: true });
       }
    }

    await sendTelegramMessage(chatId, "Use /status to set availability.");
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
