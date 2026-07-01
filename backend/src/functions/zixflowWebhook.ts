import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Inbound webhook receiver for Zixflow WhatsApp messages.
// Register this URL in Zixflow → Settings → Developer → Webhook,
// subscribed to the `incoming.whatsapp.message` event.
//
// URL to register:
//   https://vaaniai.io/functions/zixflowWebhook
//
// Zixflow payload (incoming.whatsapp.message):
//   {
//     event, eventId, timestamp, phoneId, wabaId, messageId,
//     sender: { name, number },
//     message: { type, text?:{body}, image?:{link,...}, audio?:{link,...}, ... }
//   }



export default async function zixflowWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    if (req.method === 'GET') {
      // Some panels do a verification GET — echo any challenge param.
      const url = new URL(req.url);
      const challenge = url.searchParams.get('challenge') || url.searchParams.get('hub.challenge');
      if (challenge) return new Response(challenge, { status: 200 });
      return c.json({ data: { ok: true } });
    }
    if (req.method !== 'POST') {
      return c.json({ data: { error: 'Method not allowed' } }, 405);
    }

    const payload = await c.req.json();
    console.log('[zixflowWebhook] Received:', JSON.stringify(payload).slice(0, 1000));

    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // Only handle inbound WhatsApp messages
    if (payload?.event && payload.event !== 'incoming.whatsapp.message') {
      return c.json({ data: { ok: true, skipped: payload.event } });
    }

    const sender = payload?.sender || {};
    const msg = payload?.message || {};
    const phoneId = payload?.phoneId || null;
    const contactPhone = sender.number;
    const contactName = sender.name || null;
    const messageId = payload?.messageId || payload?.eventId || null;

    if (!contactPhone) {
      return c.json({ data: { ok: false, error: 'no sender number' } }, 200);
    }

    // Resolve the owning client.
    //  1) Try matching the Zixflow Meta phoneId against ClientMessagingConfig.
    //  2) Fall back to the single connected WhatsApp client (common for 1-tenant setups).
    let clientId = null;
    if (phoneId) {
      const byPnid = await svc.entities.ClientMessagingConfig.filter({ whatsapp_phone_number_id: phoneId });
      if (byPnid.length > 0) {
        // A number can be shared across multiple configs — route deterministically:
        // prefer a 'connected' config (sorted by id for stability) so inbound
        // messages always land in the same single Inbox.
        const sorted = [...byPnid].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const owner = sorted.find(c => c.whatsapp_status === 'connected') || sorted[0];
        clientId = owner.client_id;
      }
    }
    if (!clientId) {
      const connected = await svc.entities.ClientMessagingConfig.filter({ whatsapp_status: 'connected' });
      if (connected.length === 1) clientId = connected[0].client_id;
    }
    if (!clientId) {
      console.warn('[zixflowWebhook] could not resolve client for phoneId', phoneId);
      return c.json({ data: { ok: false, error: 'client not resolved' } }, 200);
    }

    // Map Zixflow message → agent input
    let mediaType = 'text';
    let mediaUrl = null;
    let text = '';
    if (msg.type === 'text') {
      text = msg.text?.body || '';
    } else if (msg.type === 'image') {
      mediaType = 'image';
      mediaUrl = msg.image?.link || null;
      text = msg.image?.caption || '';
    } else if (msg.type === 'audio' || msg.type === 'voice') {
      mediaType = 'audio';
      mediaUrl = (msg.audio || msg.voice)?.link || null;
    } else {
      // Unsupported type (location/contacts/order/etc.) — log and ack.
      await svc.entities.AuditLog.create({
        client_id: clientId,
        action: 'whatsapp_inbound_message',
        details: { from: contactPhone, message_id: messageId, type: msg.type, provider: 'zixflow', raw: msg }
      }).catch(() => {});
      return c.json({ data: { ok: true, skipped: `unsupported_type_${msg.type}` } });
    }

    // Audit the inbound message
    await svc.entities.AuditLog.create({
      client_id: clientId,
      action: 'whatsapp_inbound_message',
      details: { from: contactPhone, message_id: messageId, type: msg.type, text: text.slice(0, 200), provider: 'zixflow' }
    }).catch(() => {});

    if (!text && !mediaUrl) {
      return c.json({ data: { ok: true, skipped: 'empty' } });
    }

    // Route into the shared AI agent (fire-and-forget for fast ack).
    svc.functions.invoke('whatsappAiAgent', {
      client_id: clientId,
      contact_phone: contactPhone,
      contact_name: contactName,
      text,
      message_id: messageId,
      media_type: mediaType,
      media_url: mediaUrl
    }).catch(e => console.error('[zixflowWebhook] whatsappAiAgent invoke failed:', e.message));

    return c.json({ data: { ok: true } });
  } catch (error) {
    console.error('zixflowWebhook error:', error);
    // Always 200 to avoid webhook retry storms
    return c.json({ data: { ok: false, error: error.message } }, 200);
  }

};