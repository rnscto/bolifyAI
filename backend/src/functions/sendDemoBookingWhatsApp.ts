import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Sends the Vaani Demo Room link to a lead via WhatsApp using the PLATFORM
// RCS Digital WhatsApp integration (client_id='platform').
//
// Uses the template that the admin selected in
// PlatformMessagingConfig.demo_booking_template_id.
//
// Variable mapping (in this exact order, matching the chosen template's {{1}}, {{2}}, {{3}}, ...):
//   {{1}} → lead_name
//   {{2}} → date & time (IST)
//   {{3}} → booking_code
// Any additional variables ({{4}}+) get an empty string so the API call still succeeds —
// pick a template whose body uses 1-3 variables for best results.
//
// If the template has a URL button with a dynamic suffix, the room_token is sent as the
// button parameter. The full demo room URL becomes: <button base url> + <room_token>
// e.g. button URL "https://vaaniai.io/DemoRoom?token={{1}}" → final link
//      "https://vaaniai.io/DemoRoom?token=2b1e757cf2df4bc6ad386873fa770733"
//
// Payload: { booking_id } OR { room_token } OR an entity-automation payload
// Returns { success, message_id } or { skipped, reason }



const RCS_BASE = 'https://rcsdigital.in';
const VERSION = 'v23.0';

function fmtIST(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric',
      month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
    }) + ' IST';
  } catch { return iso; }
}

async function rcsFetch(path, { method = 'GET', headers = {}, body, token }) {
  const res = await fetch(`${RCS_BASE}${path}`, {
    method, headers: { 'Authorization': `Bearer ${token}`, ...headers }, body
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Count {{n}} placeholders in a string
function countVars(s) {
  if (!s) return 0;
  const m = String(s).match(/\{\{\s*\d+\s*\}\}/g);
  return m ? m.length : 0;
}

export default async function sendDemoBookingWhatsApp(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const body = await c.req.json().catch(() => ({}));

    // Resolve booking
    let bookingId = body.booking_id || body.event?.entity_id;
    let booking = body.data;
    if (!booking && bookingId) booking = await svc.entities.DemoBooking.get(bookingId).catch(() => null);
    if (!booking && body.room_token) {
      const m = await svc.entities.DemoBooking.filter({ room_token: body.room_token });
      booking = m[0]; bookingId = booking?.id;
    }
    if (!booking) return c.json({ data: { skipped: 'booking_not_found' } });
    if (!booking.lead_phone) return c.json({ data: { skipped: 'no_phone' } });

    // Load platform WhatsApp config
    const configs = await svc.entities.PlatformMessagingConfig.list().catch(() => []);
    const platCfg = configs[0];
    if (!platCfg || !platCfg.whatsapp_api_key || !platCfg.whatsapp_phone_number_id || !platCfg.whatsapp_business_id) {
      return c.json({ data: { skipped: 'platform_whatsapp_not_configured' } });
    }

    // Load the admin-selected template
    const templateId = platCfg.demo_booking_template_id;
    if (!templateId) {
      return c.json({ data: {
        skipped: 'no_template_selected',
        hint: 'Go to Admin → Platform Messaging → Lifecycle and pick a template for "Demo Booking Confirmation".'
      } });
    }
    const tpl = await svc.entities.MessageTemplate.get(templateId).catch(() => null);
    if (!tpl) return c.json({ data: { skipped: 'template_not_found', template_id: templateId } });
    if (tpl.approval_status !== 'approved') {
      return c.json({ data: { skipped: 'template_not_approved', status: tpl.approval_status } });
    }
    if (tpl.channel !== 'whatsapp') {
      return c.json({ data: { skipped: 'template_not_whatsapp', channel: tpl.channel } });
    }

    // Build variable values in canonical order:
    //   {{1}} → lead name
    //   {{2}} → date & time (IST)
    //   {{3}} → full demo room URL (so plain-body templates without a URL button still show a clickable link)
    //   {{4}} → booking code (fallback, rarely used)
    // The full URL is also used because WhatsApp auto-linkifies https:// URLs inside the body text,
    // making the message useful even when the chosen template has no dynamic URL button.
    const appOrigin = Deno.env.get('APP_PUBLIC_URL') || 'https://vaaniai.io';
    const roomUrl = `${appOrigin.replace(/\/+$/, '')}/DemoRoom?token=${booking.room_token}`;
    const canonicalVars = [
      booking.lead_name || 'there',
      fmtIST(booking.scheduled_at),
      roomUrl,
      booking.booking_code || 'DEMO'
    ];
    // Pad/trim to match template body variable count
    const bodyVarCount = countVars(tpl.body);
    const bodyVars = [];
    for (let i = 0; i < bodyVarCount; i++) bodyVars.push(canonicalVars[i] ?? '');

    // Header text variables (rare but possible)
    const headerVarCount = tpl.header_type === 'text' ? countVars(tpl.header_text) : 0;
    const headerVars = [];
    for (let i = 0; i < headerVarCount; i++) headerVars.push(canonicalVars[i] ?? '');

    // Build components
    const components = [];
    if (headerVarCount > 0) {
      components.push({ type: 'header', parameters: headerVars.map(v => ({ type: 'text', text: String(v) })) });
    }
    if (bodyVarCount > 0) {
      components.push({ type: 'body', parameters: bodyVars.map(v => ({ type: 'text', text: String(v) })) });
    }

    // URL button with dynamic suffix → pass room_token as the suffix value
    const buttons = Array.isArray(tpl.buttons) ? tpl.buttons : [];
    buttons.forEach((btn, idx) => {
      if (btn?.type === 'URL' && countVars(btn.url) > 0) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(idx),
          parameters: [{ type: 'text', text: booking.room_token }]
        });
      }
    });

    const cleanPhone = String(booking.lead_phone).replace(/[^0-9]/g, '');
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'template',
      template: {
        name: tpl.name,
        language: { code: tpl.language || 'en' },
        ...(components.length > 0 ? { components } : {})
      }
    };

    const { ok, status, data } = await rcsFetch(
      `/${VERSION}/${platCfg.whatsapp_phone_number_id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        token: platCfg.whatsapp_api_key
      }
    );

    if (!ok) {
      const err = data?.error?.message || `HTTP ${status}`;
      console.error('[sendDemoBookingWhatsApp] send failed', err, JSON.stringify(data).slice(0, 500));
      return c.json({ data: { success: false, error: err, template: tpl.name } });
    }

    const messageId = data?.messages?.[0]?.id || null;
    await svc.entities.MessageTemplate.update(tpl.id, { usage_count: (tpl.usage_count || 0) + 1 }).catch(() => {});

    console.log(`[sendDemoBookingWhatsApp] ✅ ${cleanPhone} msg_id=${messageId} tpl=${tpl.name}`);
    return c.json({ data: { success: true, message_id: messageId, sent_to: cleanPhone, template: tpl.name } });
  } catch (error) {
    console.error('sendDemoBookingWhatsApp error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};