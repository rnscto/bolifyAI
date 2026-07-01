import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// sendWhatsAppMedia
// ────────────────────────────────────────────────────────────────────────────
// Sends a PDF / image / document to a WhatsApp number via the client's connected
// provider (Meta Cloud API or RCS Digital's Meta-compatible proxy).
//
// Unlike sendWhatsAppTemplate, this sends a SESSION message (type: document/image)
// which works inside the 24-hour customer-service window that a live call opens
// (the customer is actively talking to us, so the window is open). This is what
// lets the agent attach a brochure/pricing PDF in real-time mid-call.
//
// Two ways to specify the file:
//   1. media_asset_id  → look up a MediaAsset from the client's library
//   2. raw fields       → media_url, media_type, file_name, caption
//
// Payload: {
//   client_id, to,
//   media_asset_id?,                 // OR
//   media_url?, media_type?, file_name?, caption?,
//   lead_id?, call_log_id?, outreach_type?
// }
// Returns: { success, message_id } or { error }
// ────────────────────────────────────────────────────────────────────────────



const RCS_BASE = 'https://rcsdigital.in';
const META_BASE = 'https://graph.facebook.com';
const RCS_VERSION = 'v23.0';
const META_VERSION = 'v21.0';

function resolveEndpoint(provider, phoneNumberId) {
  if (provider === 'meta_cloud') {
    return `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`;
  }
  return `${RCS_BASE}/${RCS_VERSION}/${phoneNumberId}/messages`;
}

function normalizePhone(to) {
  let n = String(to || '').replace(/[^0-9]/g, '');
  if (n.length === 10) n = '91' + n;
  else if (n.length === 11 && n.startsWith('0')) n = '91' + n.substring(1);
  return n;
}

export default async function sendWhatsAppMedia(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const svc = client.asServiceRole;
    const body = await c.req.json();
    let {
      client_id,
      to,
      media_asset_id = null,
      media_url = null,
      media_type = 'document',
      file_name = null,
      caption = null,
      lead_id = null,
      call_log_id = null,
      outreach_type = 'lead_followup'
    } = body;

    if (!client_id || !to) {
      return c.json({ data: { error: 'client_id and to are required' } }, 400);
    }

    // Resolve from the media library if an asset id was passed.
    let asset = null;
    if (media_asset_id) {
      asset = await svc.entities.MediaAsset.get(media_asset_id).catch(() => null);
      if (!asset) return c.json({ data: { error: 'Media asset not found' } }, 404);
      if (asset.client_id !== client_id) {
        return c.json({ data: { error: 'Media asset does not belong to this client' } }, 403);
      }
      media_url = asset.file_url;
      media_type = asset.media_type || 'document';
      file_name = asset.file_name || asset.name || file_name;
      caption = caption || asset.caption || null;
    }

    if (!media_url) {
      return c.json({ data: { error: 'media_url (or a valid media_asset_id) is required' } }, 400);
    }
    if (!['document', 'image'].includes(media_type)) {
      return c.json({ data: { error: "media_type must be 'document' or 'image'" } }, 400);
    }

    // Load the client's WhatsApp config
    const configs = await svc.entities.ClientMessagingConfig.filter({ client_id });
    const config = configs[0];
    if (!config || config.whatsapp_status !== 'connected' || !config.whatsapp_api_key || !config.whatsapp_phone_number_id) {
      const err = 'WhatsApp not connected for this client';
      await svc.entities.OutreachLog.create({
        client_id, lead_id, call_log_id,
        channel: 'whatsapp', recipient_phone: to, outreach_type,
        status: 'failed', error_message: err
      }).catch(() => {});
      return c.json({ data: { error: err } }, 400);
    }

    const normalizedTo = normalizePhone(to);

    // Build the media object. WhatsApp fetches the file from `link`.
    const mediaObj = { link: media_url };
    if (caption) mediaObj.caption = caption;
    if (media_type === 'document' && file_name) mediaObj.filename = file_name;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: media_type,
      [media_type]: mediaObj
    };

    const endpoint = resolveEndpoint(config.whatsapp_provider, config.whatsapp_phone_number_id);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.whatsapp_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const e = data?.error || {};
      const parts = [
        e.message, e.error_user_msg, e.error_user_title,
        e.error_subcode ? `subcode ${e.error_subcode}` : null,
        e.code ? `code ${e.code}` : null,
        e.fbtrace_id ? `fbtrace ${e.fbtrace_id}` : null
      ].filter(Boolean);
      const errMsg = parts.length ? parts.join(' | ') : `HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`;
      console.warn('[sendWhatsAppMedia] Provider error', res.status, JSON.stringify(data));
      await svc.entities.OutreachLog.create({
        client_id, lead_id, call_log_id,
        channel: 'whatsapp', recipient_phone: to,
        subject: asset?.name || file_name || 'media', body: media_url,
        outreach_type, status: 'failed', error_message: errMsg
      }).catch(() => {});
      return c.json({ data: { error: errMsg, http_status: res.status, details: data } }, 200);
    }

    // Success — log + bump send_count
    await svc.entities.OutreachLog.create({
      client_id, lead_id, call_log_id,
      channel: 'whatsapp', recipient_phone: to,
      subject: asset?.name || file_name || 'media', body: media_url,
      outreach_type, status: 'sent'
    }).catch(() => {});

    if (asset) {
      await svc.entities.MediaAsset.update(asset.id, {
        send_count: (asset.send_count || 0) + 1
      }).catch(() => {});
    }

    return c.json({ data: {
      success: true,
      message_id: data?.messages?.[0]?.id || null,
      asset_name: asset?.name || file_name || null
    } });
  } catch (error) {
    console.error('[sendWhatsAppMedia] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};