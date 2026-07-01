import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Inbound webhook receiver for RCS Digital WhatsApp messages.
// Register this URL in your RCS Digital portal for incoming message / status events.
//
// URL to register (in RCS Digital console → WhatsApp API → Webhook):
//   https://<your-base44-app>.base44.app/functions/rcsDigitalWebhook
//
// Payload shape mirrors Meta Cloud API webhook:
//   { entry: [ { changes: [ { value: { messages: [...], statuses: [...] } } ] } ] }



export default async function rcsDigitalWebhook(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Meta-style verification (GET with hub.challenge)
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const challenge = url.searchParams.get('hub.challenge');
      if (challenge) return new Response(challenge, { status: 200 });
      return c.json({ data: { ok: true } });
    }

    if (req.method !== 'POST') {
      return c.json({ data: { error: 'Method not allowed' } }, 405);
    }

    const payload = await c.req.json();
    console.log('[rcsDigitalWebhook] Received:', JSON.stringify(payload).slice(0, 1000));

    /* const base44 = ... */;

    // Walk the standard Meta webhook shape
    const entries = payload?.entry || [];
    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        const value = change?.value || {};
        const phoneNumberId = value?.metadata?.phone_number_id;

        // Find the client by matching phone_number_id.
        // A number can be shared across multiple configs (e.g. internal accounts),
        // so route deterministically: prefer a 'connected' config (sorted by id
        // for stability) over any disconnected one. This guarantees inbound
        // messages always land in the same single Inbox.
        let client = null;
        if (phoneNumberId) {
          const configs = await base44.asServiceRole.entities.ClientMessagingConfig.filter({
            whatsapp_phone_number_id: phoneNumberId
          });
          if (configs.length > 0) {
            const sorted = [...configs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
            const owner = sorted.find(c => c.whatsapp_status === 'connected') || sorted[0];
            client = { id: owner.client_id, config_id: owner.id };
          }
        }

        // Profile name (if the provider includes it in contacts[])
        const contactName = (value.contacts || [])[0]?.profile?.name || null;

        // Incoming messages
        for (const msg of (value.messages || [])) {
          console.log(`[rcsDigitalWebhook] message from ${msg.from}: ${msg.text?.body || msg.type}`);
          // Persist as an AuditLog for tracking / richer workflows
          if (client) {
            await base44.asServiceRole.entities.AuditLog.create({
              client_id: client.id,
              action: 'whatsapp_inbound_message',
              details: {
                from: msg.from,
                message_id: msg.id,
                type: msg.type,
                text: msg.text?.body || null,
                timestamp: msg.timestamp,
                raw: msg
              }
            }).catch(e => console.error('AuditLog write failed:', e.message));

            // ─── AI chat agent: reply / book demos / trigger calls ───
            // Fire-and-forget so the webhook returns instantly (no retry storms).
            // Routes TEXT, IMAGE and VOICE-NOTE (audio) messages to the AI brain.
            const isText = msg.type === 'text' && msg.text?.body;
            const isImage = msg.type === 'image' && msg.image?.id;
            const isAudio = (msg.type === 'audio' || msg.type === 'voice') && (msg.audio?.id || msg.voice?.id);
            if (isText || isImage || isAudio) {
              base44.asServiceRole.functions.invoke('whatsappAiAgent', {
                client_id: client.id,
                phone_number_id: phoneNumberId,
                contact_phone: msg.from,
                contact_name: contactName,
                text: msg.text?.body || msg.image?.caption || '',
                message_id: msg.id,
                media_type: isImage ? 'image' : isAudio ? 'audio' : 'text',
                media_id: isImage ? msg.image.id : isAudio ? (msg.audio?.id || msg.voice?.id) : null
              }).catch(e => console.error('[rcsDigitalWebhook] whatsappAiAgent invoke failed:', e.message));
            }
          }
        }

        // Delivery / read statuses
        for (const st of (value.statuses || [])) {
          console.log(`[rcsDigitalWebhook] status ${st.status} for message ${st.id}`);
          if (client) {
            await base44.asServiceRole.entities.AuditLog.create({
              client_id: client.id,
              action: 'whatsapp_status_update',
              details: {
                message_id: st.id,
                status: st.status,
                recipient: st.recipient_id,
                timestamp: st.timestamp,
                raw: st
              }
            }).catch(e => console.error('AuditLog write failed:', e.message));
          }
        }
      }
    }

    return c.json({ data: { ok: true } });
  } catch (error) {
    console.error('rcsDigitalWebhook error:', error);
    // Always 200 to prevent webhook retry storms
    return c.json({ data: { ok: false, error: error.message } }, 200);
  }

};