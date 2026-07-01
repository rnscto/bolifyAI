import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

const RCS_BASE = 'https://rcsdigital.in';
const VERSION = 'v23.0';

export async function sendPlatformWhatsAppLogic(payload: any) {
  try {
    const { template_id, to, variables = [], recipient_client_id = null, broadcast_id = null } = payload;

    if (!template_id || !to) return { success: false, error: 'template_id and to are required' };

    // Load platform config (singleton)
    const configs = await base44.entities.PlatformMessagingConfig.list();
    const config = configs[0];
    if (!config || config.whatsapp_status !== 'connected' || !config.whatsapp_api_key || !config.whatsapp_phone_number_id) {
      return { success: false, error: 'Platform WhatsApp not connected' };
    }

    const template = await base44.entities.MessageTemplate.get(template_id).catch(() => null);
    if (!template) return { success: false, error: 'Template not found' };
    if (template.approval_status !== 'approved') {
      return { success: false, error: `Template is "${template.approval_status}" — must be approved` };
    }

    let recipientName = '';
    let recipientCompany = '';
    if (recipient_client_id && recipient_client_id !== 'platform') {
      const c = await base44.entities.Client.get(recipient_client_id).catch(() => null);
      if (c) {
        recipientName = c.company_name || '';
        recipientCompany = c.company_name || '';
      }
    }
    const resolvedVariables = (variables || []).map((v: any) => {
      const s = String(v ?? '');
      return s
        .replace(/\{\{\s*name\s*\}\}/gi, recipientName)
        .replace(/\{\{\s*company\s*\}\}/gi, recipientCompany);
    });

    let normalizedTo = String(to).replace(/[^0-9]/g, '');
    if (normalizedTo.length === 10) normalizedTo = '91' + normalizedTo;
    else if (normalizedTo.length === 11 && normalizedTo.startsWith('0')) normalizedTo = '91' + normalizedTo.substring(1);

    const expectedVarCount = (() => {
      const matches = (template.body || '').match(/\{\{\s*(\d+)\s*\}\}/g) || [];
      const nums = matches.map((m: any) => parseInt(m.replace(/[^0-9]/g, ''), 10)).filter((n: any) => !isNaN(n));
      return nums.length ? Math.max(...nums) : 0;
    })();
    if (resolvedVariables.length !== expectedVarCount) {
      const errMsg = `Template "${template.name}" needs ${expectedVarCount} variable(s) but got ${resolvedVariables.length}`;
      await base44.entities.OutreachLog.create({
        client_id: recipient_client_id || 'platform',
        channel: 'whatsapp', recipient_phone: normalizedTo,
        subject: template.name, body: template.body || '',
        outreach_type: broadcast_id ? 'platform_broadcast' : 'lead_followup',
        status: 'failed', error_message: errMsg
      }).catch(() => {});
      return { success: false, error: errMsg };
    }

    const components = [];
    if (resolvedVariables.length > 0) {
      components.push({ type: 'body', parameters: resolvedVariables.map((v: any) => ({ type: 'text', text: String(v) })) });
    }

    const requestPayload = {
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

    const res = await fetch(`${RCS_BASE}/${VERSION}/${config.whatsapp_phone_number_id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.whatsapp_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload)
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      console.error('[sendPlatformWhatsApp] error:', errMsg, data);
      await base44.entities.OutreachLog.create({
        client_id: recipient_client_id || 'platform',
        channel: 'whatsapp', recipient_phone: normalizedTo,
        subject: template.name, body: template.body || '',
        outreach_type: broadcast_id ? 'platform_broadcast' : 'lead_followup',
        status: 'failed', error_message: errMsg
      }).catch(() => {});
      return { success: false, error: errMsg, details: data };
    }

    await base44.entities.OutreachLog.create({
      client_id: recipient_client_id || 'platform',
      channel: 'whatsapp', recipient_phone: normalizedTo,
      subject: template.name, body: template.body || '',
      outreach_type: broadcast_id ? 'platform_broadcast' : 'lead_followup',
      status: 'sent'
    }).catch(() => {});

    await base44.entities.MessageTemplate.update(template_id, {
      usage_count: (template.usage_count || 0) + 1
    }).catch(() => {});

    return { success: true, message_id: data?.messages?.[0]?.id || null };
  } catch (e: any) {
    console.error('[sendPlatformWhatsApp] exception:', e);
    return { success: false, error: e.message };
  }
}

export default async function sendPlatformWhatsApp(c: any) {
  try {
    const payload = await c.req.json();
    const result = await sendPlatformWhatsAppLogic(payload);
    
    if (!result.success) {
      return c.json({ data: result }, 400);
    }
    
    return c.json({ data: result });
  } catch (e: any) {
    return c.json({ data: { success: false, error: e.message } }, 500);
  }
}