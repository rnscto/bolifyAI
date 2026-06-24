import { Context } from "hono";
import { base44ORM } from "../db/orm.ts";

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const { provider, api_key, phone_number_id, business_id } = payload;
    
    if (!api_key || !phone_number_id) {
      return c.json({ data: { success: false, error: 'api_key and phone_number_id are required' } });
    }

    const baseHost = provider === 'rcs_digital'
      ? 'https://rcsdigital.in/v23.0'
      : 'https://graph.facebook.com/v20.0';

    const fullUrl = `${baseHost}/${phone_number_id}?fields=verified_name,display_phone_number`;
    const tokenPreview = api_key.length > 12 ? `${api_key.slice(0, 6)}...${api_key.slice(-4)} (len=${api_key.length})` : `(len=${api_key.length})`;
    console.log(`[testPlatformWhatsAppConnection] GET ${fullUrl}`);
    console.log(`[testPlatformWhatsAppConnection] Provider: ${provider}, Token: ${tokenPreview}`);

    const res = await fetch(fullUrl, {
      headers: { 'Authorization': `Bearer ${api_key}` }
    });
    
    const rawText = await res.text();
    let data: any;
    try { data = JSON.parse(rawText); } catch (_) { data = { raw: rawText }; }

    console.log(`[testPlatformWhatsAppConnection] HTTP ${res.status}`);

    // Persist status
    const cfgs = await base44ORM.entities.PlatformMessagingConfig.list('-created_date', 1);
    const newStatus = res.ok ? 'connected' : 'error';
    const updates = {
      whatsapp_provider: provider,
      whatsapp_api_key: api_key,
      whatsapp_phone_number_id: phone_number_id,
      whatsapp_business_id: business_id || '',
      whatsapp_status: newStatus,
      whatsapp_last_tested: new Date().toISOString()
    };
    
    if (cfgs.length > 0) {
      await base44ORM.entities.PlatformMessagingConfig.update(cfgs[0].id, updates);
    } else {
      await base44ORM.entities.PlatformMessagingConfig.create({ is_singleton: true, ...updates });
    }

    if (res.ok) {
      return c.json({ data: { success: true, status: 'connected', message: `Connected to ${provider} — phone ${data.display_phone_number || phone_number_id}`, details: data } });
    }
    return c.json({ data: { success: false, status: 'error', error: data.error?.message || JSON.stringify(data) } });
  } catch (error: any) {
    console.error('[testPlatformWhatsAppConnection] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
