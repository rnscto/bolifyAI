import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Sends a pre-approved WhatsApp template via RCS Digital (Meta-compatible).
// Service-role callable from automations (sequences, campaigns).
// Logs every send to OutreachLog.
//
// Payload: { client_id, template_id, to, variables: [string], lead_id?, call_log_id?, outreach_type? }
// Returns: { success, message_id } or { error }



const RCS_BASE = 'https://rcsdigital.in';
const META_BASE = 'https://graph.facebook.com';
const RCS_VERSION = 'v23.0';
const META_VERSION = 'v21.0';

// Pick the correct API host + version based on the provider configured for the client.
// meta_cloud → Meta's official Graph API (graph.facebook.com)
// rcs_digital → RCS Digital's Meta-compatible proxy
// everything else falls back to RCS Digital for backward compat.
function resolveEndpoint(provider, phoneNumberId) {
  if (provider === 'meta_cloud') {
    return `${META_BASE}/${META_VERSION}/${phoneNumberId}/messages`;
  }
  return `${RCS_BASE}/${RCS_VERSION}/${phoneNumberId}/messages`;
}

function interpolate(template, lead) {
  if (!template) return '';
  const firstName = (lead?.name || '').trim().split(/\s+/)[0] || '';
  return template
    // name aliases: {{name}}, {{lead_name}}, {{full_name}}
    .replace(/\{\{\s*(name|lead_name|full_name)\s*\}\}/gi, lead?.name || '')
    // first-name aliases: {{first_name}}, {{firstname}}
    .replace(/\{\{\s*(first_name|firstname)\s*\}\}/gi, firstName)
    .replace(/\{\{\s*company\s*\}\}/gi, lead?.company || '')
    .replace(/\{\{\s*phone\s*\}\}/gi, lead?.phone || '')
    .replace(/\{\{\s*email\s*\}\}/gi, lead?.email || '');
}

export default async function sendWhatsAppTemplate(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const base44 = client.asServiceRole;
    const body = await c.req.json();
    const { client_id, template_id, to, variables = [], lead_id, call_log_id, outreach_type = 'lead_followup' } = body;

    if (!client_id || !template_id || !to) {
      return c.json({ data: { error: 'client_id, template_id, and to are required' } }, 400);
    }

    // Load messaging config
    const configs = await base44.entities.ClientMessagingConfig.filter({ client_id });
    const config = configs[0];
    if (!config || config.whatsapp_status !== 'connected' || !config.whatsapp_api_key || !config.whatsapp_phone_number_id) {
      const err = 'WhatsApp not connected for this client';
      await base44.entities.OutreachLog.create({
        client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
        channel: 'whatsapp', recipient_phone: to, outreach_type,
        status: 'failed', error_message: err
      }).catch(() => {});
      return c.json({ data: { error: err } }, 400);
    }

    // Load template
    const template = await base44.entities.MessageTemplate.get(template_id).catch(() => null);
    if (!template) return c.json({ data: { error: 'Template not found' } }, 404);
    if (template.approval_status !== 'approved') {
      return c.json({ data: { error: `Template is "${template.approval_status}" — must be approved before sending` } }, 400);
    }

    // Optionally resolve lead to support variable interpolation ({{name}} etc.)
    let lead = null;
    if (lead_id) {
      lead = await base44.entities.Lead.get(lead_id).catch(() => null);
    }

    // Interpolate any variables that contain placeholders
    const resolvedVars = (variables || []).map(v => interpolate(String(v || ''), lead));

    // Validate variable count matches the template body's {{N}} placeholders.
    // WhatsApp will reject with cryptic error #132000 if counts don't match.
    const expectedVarCount = (() => {
      const matches = (template.body || '').match(/\{\{\s*(\d+)\s*\}\}/g) || [];
      const nums = matches.map(m => parseInt(m.replace(/[^0-9]/g, ''), 10)).filter(n => !isNaN(n));
      return nums.length ? Math.max(...nums) : 0;
    })();
    if (resolvedVars.length !== expectedVarCount) {
      const errMsg = `Template "${template.name}" needs ${expectedVarCount} variable(s) but got ${resolvedVars.length}`;
      await base44.entities.OutreachLog.create({
        client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
        channel: 'whatsapp', recipient_phone: to,
        subject: template.name, body: template.body || '',
        outreach_type, status: 'failed', error_message: errMsg
      }).catch(() => {});
      return c.json({ data: { error: errMsg } }, 400);
    }

    const components = [];

    // Attach header media (image/video/document) when the template defines one.
    // The file comes from the client's Media Library (or a pasted URL) saved on
    // the template as header_media_url. Text headers carry no parameters here.
    if (['image', 'video', 'document'].includes(template.header_type) && template.header_media_url) {
      components.push({
        type: 'header',
        parameters: [{
          type: template.header_type,
          [template.header_type]: { link: template.header_media_url }
        }]
      });
    }

    if (resolvedVars.length > 0) {
      components.push({
        type: 'body',
        parameters: resolvedVars.map(v => ({ type: 'text', text: String(v) }))
      });
    }

    // Normalize phone to international format (E.164 without leading +).
    // RCS Digital / Meta WhatsApp API requires country code. Default to India (91) for 10-digit numbers.
    let normalizedTo = String(to).replace(/[^0-9]/g, '');
    if (normalizedTo.length === 10) normalizedTo = '91' + normalizedTo;
    else if (normalizedTo.length === 11 && normalizedTo.startsWith('0')) normalizedTo = '91' + normalizedTo.substring(1);

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language || 'en' },
        ...(components.length > 0 && { components })
      }
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
      // Surface as much detail as possible — Meta nests errors deep
      const e = data?.error || {};
      const parts = [
        e.message,
        e.error_user_msg,
        e.error_user_title,
        e.error_subcode ? `subcode ${e.error_subcode}` : null,
        e.code ? `code ${e.code}` : null,
        e.fbtrace_id ? `fbtrace ${e.fbtrace_id}` : null
      ].filter(Boolean);
      const errMsg = parts.length ? parts.join(' | ') : `HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`;
      console.warn('[sendWhatsAppTemplate] Provider error', res.status, JSON.stringify(data));
      await base44.entities.OutreachLog.create({
        client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
        channel: 'whatsapp', recipient_phone: to,
        subject: template.name, body: template.body || '',
        outreach_type, status: 'failed', error_message: errMsg
      }).catch(() => {});
      return c.json({ data: { error: errMsg, http_status: res.status, details: data } }, 200);
    }

    // Success — log + bump usage
    await base44.entities.OutreachLog.create({
      client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
      channel: 'whatsapp', recipient_phone: to,
      subject: template.name, body: template.body || '',
      outreach_type, status: 'sent'
    }).catch(() => {});

    await base44.entities.MessageTemplate.update(template_id, {
      usage_count: (template.usage_count || 0) + 1
    }).catch(() => {});

    return c.json({ data: {
      success: true,
      message_id: data?.messages?.[0]?.id || null,
      template_name: template.name
    } });
  } catch (error) {
    console.error('[sendWhatsAppTemplate] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};