import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// sendWhatsAppManualReply — Lets a client agent send a manual free-form
// WhatsApp reply into an existing chat session (inside the 24h CS window).
//
// Appends the message to the WhatsAppChatSession history so the inbox stays
// in sync, and logs it to OutreachLog.
//
// Payload: { session_id, text }
// Returns: { success, message_id } or { error }
// ═══════════════════════════════════════════════════════════════════════



const RCS_BASE = 'https://rcsdigital.in';
const META_BASE = 'https://graph.facebook.com';
const RCS_VERSION = 'v23.0';
const META_VERSION = 'v21.0';
const MAX_HISTORY = 20;

function resolveEndpoint(provider, phoneNumberId) {
  if (provider === 'meta_cloud') return `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`;
  return `${RCS_BASE}/${RCS_VERSION}/${phoneNumberId}/messages`;
}

function normalizePhone(to) {
  let n = String(to || '').replace(/[^0-9]/g, '');
  if (n.length === 10) n = '91' + n;
  else if (n.length === 11 && n.startsWith('0')) n = '91' + n.substring(1);
  return n;
}

export default async function sendWhatsAppManualReply(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const svc = base44.asServiceRole;
    const { session_id, text } = await c.req.json();
    if (!session_id || !text?.trim()) {
      return c.json({ data: { error: 'session_id and text are required' } }, 400);
    }

    const session = await svc.entities.WhatsAppChatSession.get(session_id).catch(() => null);
    if (!session) return c.json({ data: { error: 'Chat session not found' } }, 404);

    // Authorize: must be admin or own the client this session belongs to.
    if (user.role !== 'admin') {
      const clients = await svc.entities.Client.filter({ user_id: user.id });
      const ownsSession = clients.some(c => c.id === session.client_id) || user.client_id === session.client_id;
      if (!ownsSession) return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    const configs = await svc.entities.ClientMessagingConfig.filter({ client_id: session.client_id });
    const config = configs[0];
    if (!config || config.whatsapp_status !== 'connected') {
      return c.json({ data: { error: 'WhatsApp not connected for this client' } }, 400);
    }

    const phone = normalizePhone(session.contact_phone);
    const endpoint = resolveEndpoint(config.whatsapp_provider, config.whatsapp_phone_number_id);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.whatsapp_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { preview_url: false, body: text }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      console.warn('[sendWhatsAppManualReply] send error', res.status, JSON.stringify(data).slice(0, 300));
      return c.json({ data: { error: errMsg } }, 200);
    }

    // Append to session history (tagged as a human/agent reply)
    const history = Array.isArray(session.messages) ? session.messages : [];
    const newMessages = [
      ...history,
      { role: 'assistant', text, ts: new Date().toISOString(), manual: true }
    ].slice(-MAX_HISTORY);

    await svc.entities.WhatsAppChatSession.update(session.id, {
      messages: newMessages,
      last_activity_at: new Date().toISOString()
    }).catch(() => {});

    await svc.entities.OutreachLog.create({
      client_id: session.client_id, lead_id: session.lead_id,
      channel: 'whatsapp', recipient_phone: phone,
      body: text, outreach_type: 'lead_followup',
      status: 'sent'
    }).catch(() => {});

    return c.json({ data: { success: true, message_id: data?.messages?.[0]?.id || null } });
  } catch (error) {
    console.error('[sendWhatsAppManualReply] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};