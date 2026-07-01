import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Sends a pre-approved RCS template via RCS Digital.
// Service-role callable from automations (sequences, campaigns).
// Logs every send to OutreachLog.
//
// API Docs:
//   POST https://rcsdigital.in/api/v1/Rcs/sendmessage
//   Headers: Authorization: Bearer <rcs_api_key>
//   Body: { botid, templatename, destination: [phone], var: { property1, property2, ... }, callbackdata }
//
// Auth note: per user, RCS bearer token is the SAME as WhatsApp's whatsapp_api_key.
//
// Payload: { client_id, template_id, to, variables: [string], lead_id?, call_log_id?, outreach_type? }
// Returns: { success, message_id } or { error }



const RCS_BASE = 'https://rcsdigital.in';

function interpolate(template, lead) {
  if (!template) return '';
  return template
    .replace(/\{\{name\}\}/g, lead?.name || '')
    .replace(/\{\{company\}\}/g, lead?.company || '')
    .replace(/\{\{phone\}\}/g, lead?.phone || '')
    .replace(/\{\{email\}\}/g, lead?.email || '');
}

export default async function sendRCSTemplate(c: any) {
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
    // Bearer token = whatsapp_api_key (per user).
    // Auto-pick bot by template category: MARKETING -> promo bot, UTILITY/AUTH -> transactional bot.
    const token = config?.rcs_api_key || config?.whatsapp_api_key;
    if (!config || !token) {
      const err = 'RCS not connected for this client (missing token or bot ID)';
      await base44.entities.OutreachLog.create({
        client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
        channel: 'rcs', recipient_phone: to, outreach_type,
        status: 'failed', error_message: err
      }).catch(() => {});
      return c.json({ data: { error: err } }, 400);
    }

    // Load template
    const template = await base44.entities.MessageTemplate.get(template_id).catch(() => null);
    if (!template) return c.json({ data: { error: 'Template not found' } }, 404);
    if (template.channel !== 'rcs') {
      return c.json({ data: { error: 'Template is not an RCS template' } }, 400);
    }
    if (template.approval_status !== 'approved') {
      return c.json({ data: { error: `Template is "${template.approval_status}" — must be approved before sending` } }, 400);
    }

    // Pick bot by category: MARKETING -> promo bot (falls back to trans), else -> trans bot
    const isMarketing = (template.category || '').toUpperCase() === 'MARKETING';
    const botId = isMarketing
      ? (config?.rcs_promo_bot_id || config?.rcs_bot_id)
      : config?.rcs_bot_id;
    if (!botId) {
      const err = `RCS Bot ID not configured for ${isMarketing ? 'MARKETING' : 'UTILITY/AUTH'} templates`;
      await base44.entities.OutreachLog.create({
        client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
        channel: 'rcs', recipient_phone: to, outreach_type,
        status: 'failed', error_message: err
      }).catch(() => {});
      return c.json({ data: { error: err } }, 400);
    }

    // Resolve lead for variable interpolation
    let lead = null;
    if (lead_id) lead = await base44.entities.Lead.get(lead_id).catch(() => null);
    const resolvedVars = (variables || []).map(v => interpolate(String(v || ''), lead));

    // Build var object using the template's ACTUAL named keys (e.g. "Yadav", "AIvoice").
    // RCS Digital templates store variables as named placeholders — not property1/property2.
    // Falls back to property1, property2... only if the template has no variable-name metadata.
    const varObject = {};
    const varNames = Array.isArray(template.variables) ? template.variables : [];
    resolvedVars.forEach((v, i) => {
      const key = (varNames[i] && String(varNames[i]).trim()) || `property${i + 1}`;
      varObject[key] = String(v);
    });

    // Normalize phone (E.164 without +). Default to India 91 for 10-digit.
    let normalizedTo = String(to).replace(/[^0-9]/g, '');
    if (normalizedTo.length === 10) normalizedTo = '91' + normalizedTo;
    else if (normalizedTo.length === 11 && normalizedTo.startsWith('0')) normalizedTo = '91' + normalizedTo.substring(1);

    const callbackData = `client:${client_id}|tpl:${template_id}|lead:${lead_id || ''}|call:${call_log_id || ''}`.substring(0, 250);

    const payload = {
      botid: botId,
      templatename: template.name,
      destination: [normalizedTo],
      var: varObject,
      callbackdata: callbackData
    };

    const res = await fetch(`${RCS_BASE}/api/v1/Rcs/sendmessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errMsg = data?.message || data?.error?.message || data?.error || `HTTP ${res.status}`;
      await base44.entities.OutreachLog.create({
        client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
        channel: 'rcs', recipient_phone: to,
        subject: template.name, body: template.body || '',
        outreach_type, status: 'failed', error_message: errMsg
      }).catch(() => {});
      return c.json({ data: { error: errMsg, details: data } }, 400);
    }

    // Success
    const messageId = data?.messageId || data?.message_id || data?.id || data?.requestId || null;

    await base44.entities.OutreachLog.create({
      client_id, lead_id: lead_id || null, call_log_id: call_log_id || null,
      channel: 'rcs', recipient_phone: to,
      subject: template.name, body: template.body || '',
      outreach_type, status: 'sent'
    }).catch(() => {});

    await base44.entities.MessageTemplate.update(template_id, {
      usage_count: (template.usage_count || 0) + 1
    }).catch(() => {});

    return c.json({ data: {
      success: true,
      message_id: messageId,
      template_name: template.name,
      response: data
    } });
  } catch (error) {
    console.error('[sendRCSTemplate] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};