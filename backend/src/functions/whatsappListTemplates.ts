import { Context } from "hono";
import { base44ORM } from "../db/orm.ts";

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const { client_id } = payload;

    if (!client_id) {
      return c.json({ data: { success: false, error: 'client_id required' } });
    }

    const configs = await base44ORM.entities.ClientMessagingConfig.filter({ client_id });
    if (configs.length === 0) {
      return c.json({ data: { success: false, error: 'No messaging config found for this client.' } });
    }
    const cfg = configs[0];

    if (cfg.whatsapp_provider === 'interakt') {
      return c.json({ data: { 
        success: false, 
        error: 'Interakt does not offer an API to list templates. Use "Add Interakt Template" to register an approved template by its code name.' 
      } });
    }

    if (!['meta_cloud', 'rcs_digital'].includes(cfg.whatsapp_provider)) {
      return c.json({ data: { 
        success: false, 
        error: 'Templates are only supported for Meta Cloud API or RCS Digital. Your current provider is: ' + (cfg.whatsapp_provider || 'none') 
      } });
    }

    if (!cfg.whatsapp_api_key || !cfg.whatsapp_business_id) {
      return c.json({ data: { success: false, error: 'WABA ID and Access Token are required in the config.' } });
    }

    const apiKey = String(cfg.whatsapp_api_key).trim().replace(/^Bearer\s+/i, '');
    const businessId = String(cfg.whatsapp_business_id).trim();

    const baseHost = cfg.whatsapp_provider === 'rcs_digital'
      ? `https://rcsdigital.in/v23.0`
      : `https://graph.facebook.com/v20.0`;
      
    const url = `${baseHost}/${businessId}/message_templates?limit=200`;
    console.log(`[whatsappListTemplates] GET ${url}`);

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    
    const rawText = await res.text();
    let data: any;
    try { data = JSON.parse(rawText); } catch (_) { data = { raw: rawText }; }

    if (!res.ok) {
      const metaErr = data.error || {};
      let friendly = metaErr.error_user_msg || metaErr.message || `HTTP ${res.status}`;
      if (metaErr.code === 190 || res.status === 401) {
        friendly = `Authentication failed. Your Access Token is invalid or expired. For Meta Cloud API you need a System User Token.`;
      } else if (metaErr.code === 100 || res.status === 400) {
        friendly = `${metaErr.message || 'Bad Request'}. Check that your WhatsApp Business Account ID is correct.`;
      }
      console.error(`[whatsappListTemplates] Error: ${res.status} ${friendly}`);
      return c.json({ data: { success: false, error: friendly, details: data } });
    }

    const metaTemplates = data.data || [];
    const existing = await base44ORM.entities.WhatsAppTemplate.filter({ client_id }, '-created_at', 500);
    const existingByName: Record<string, any> = {};
    existing.forEach((t: any) => { existingByName[`${t.name}_${t.language}`] = t; });

    let synced = 0, created = 0, updated = 0;
    
    for (const t of metaTemplates) {
      const components = t.components || [];
      const header = components.find((c: any) => c.type === 'HEADER');
      const body = components.find((c: any) => c.type === 'BODY');
      const footer = components.find((c: any) => c.type === 'FOOTER');
      const buttonComp = components.find((c: any) => c.type === 'BUTTONS');

      const record = {
        client_id,
        vendor: cfg.whatsapp_provider,
        meta_template_id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        rejected_reason: t.rejected_reason || '',
        header_type: header?.format || 'NONE',
        header_text: header?.format === 'TEXT' ? (header.text || '') : '',
        body_text: body?.text || '',
        body_examples: body?.example?.body_text?.[0] || [],
        footer_text: footer?.text || '',
        buttons: (buttonComp?.buttons || []).map((b: any) => ({
          type: b.type,
          text: b.text || '',
          url: b.url || '',
          phone_number: b.phone_number || ''
        })),
        last_synced: new Date().toISOString()
      };

      const key = `${t.name}_${t.language}`;
      if (existingByName[key]) {
        await base44ORM.entities.WhatsAppTemplate.update(existingByName[key].id, record);
        updated++;
      } else {
        await base44ORM.entities.WhatsAppTemplate.create({ ...record, linked_actions: [] });
        created++;
      }
      synced++;
    }

    return c.json({ data: { success: true, synced, created, updated, total_meta: metaTemplates.length } });

  } catch (error: any) {
    console.error('[whatsappListTemplates] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
