import { Context } from "hono";
import { base44ORM } from "../db/orm.ts";

export async function sendPlatformWhatsAppLogic({ template_id, to, variables, lead_id, client_id, outreach_type }: any) {
  if (!template_id || !to) {
    throw new Error('template_id and to are required');
  }

  const cfgs = await base44ORM.entities.PlatformMessagingConfig.list('-created_date', 1);
  if (cfgs.length === 0) throw new Error('Platform messaging not configured');
  const cfg = cfgs[0];

  if (cfg.whatsapp_status !== 'connected') {
    throw new Error(`Platform WhatsApp not connected (status: ${cfg.whatsapp_status})`);
  }
  if (!cfg.whatsapp_api_key || !cfg.whatsapp_phone_number_id) {
    throw new Error('Platform WhatsApp credentials missing');
  }

  const template = await base44ORM.entities.WhatsAppTemplate.get(template_id);
  if (!template) throw new Error('Template not found');
  if (template.status !== 'APPROVED') {
    throw new Error(`Template is ${template.status}, not APPROVED`);
  }

  let cleanTo = String(to).replace(/[^0-9]/g, '');
  if (cleanTo.length === 10) cleanTo = '91' + cleanTo;
  else if (cleanTo.length === 11 && cleanTo.startsWith('0')) cleanTo = '91' + cleanTo.slice(1);

  const components: any[] = [];
  const vars = variables || [];
  if (vars.length > 0) {
    components.push({
      type: 'body',
      parameters: vars.map((v: string) => ({ type: 'text', text: String(v) }))
    });
  }

  const baseHost = cfg.whatsapp_provider === 'rcs_digital'
    ? `https://rcsdigital.in/v23.0`
    : `https://graph.facebook.com/v20.0`;
  const url = `${baseHost}/${cfg.whatsapp_phone_number_id}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.whatsapp_api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language || 'en' },
        ...(components.length > 0 ? { components } : {})
      }
    })
  });
  const data = await res.json();
  const messageId = data.messages?.[0]?.id;

  try {
    await base44ORM.entities.OutreachLog.create({
      client_id: client_id || 'PLATFORM',
      lead_id: lead_id || null,
      channel: 'whatsapp',
      direction: 'outbound',
      vendor: cfg.whatsapp_provider,
      vendor_message_id: messageId || null,
      template_id,
      template_name: template.name,
      recipient_phone: cleanTo,
      body: template.body_text || '',
      outreach_type: outreach_type || 'broadcast',
      status: res.ok ? 'sent' : 'failed',
      error_message: res.ok ? '' : (data.error?.error_user_msg || data.error?.message || JSON.stringify(data))
    });
  } catch (_) {}

  if (!res.ok) {
    throw new Error(data.error?.error_user_msg || data.error?.message || 'Send failed');
  }

  await base44ORM.entities.WhatsAppTemplate.update(template_id, { send_count: (template.send_count || 0) + 1 });
  return { success: true, message_id: messageId };
}

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const result = await sendPlatformWhatsAppLogic(payload);
    return c.json({ data: result });
  } catch (error: any) {
    console.error('[sendPlatformWhatsApp]', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
