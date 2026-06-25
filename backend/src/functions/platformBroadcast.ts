import { Context } from "hono";
import { base44ORM } from "../db/orm.ts";
import { sendPlatformWhatsAppLogic } from "./sendPlatformWhatsApp.ts";

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const { template_id, audience, default_variables } = payload;
    
    if (!template_id || !audience) {
      return c.json({ data: { success: false, error: 'template_id and audience required' } });
    }

    const template = await base44ORM.entities.WhatsAppTemplate.get(template_id);
    if (!template || template.status !== 'APPROVED') {
      return c.json({ data: { success: false, error: 'Template not found or not approved' } });
    }

    // Resolve audience
    let clients: any[] = [];
    if (Array.isArray(audience)) {
      clients = await Promise.all(audience.map(id => base44ORM.entities.Client.get(id).catch(() => null)));
      clients = clients.filter(Boolean);
    } else {
      const all = await base44ORM.entities.Client.list('-created_at', 5000);
      if (audience === 'all') clients = all;
      else if (audience === 'trial') clients = all.filter((c: any) => c.account_status === 'trial');
      else if (audience === 'active') clients = all.filter((c: any) => c.account_status === 'active');
      else if (audience === 'expired') clients = all.filter((c: any) => c.account_status === 'expired');
      else clients = [];
    }

    let sent = 0, skipped = 0, failed = 0;
    const errors: string[] = [];
    for (const client of clients) {
      if (!client.phone) { skipped++; continue; }
      try {
        const result = await sendPlatformWhatsAppLogic({
          template_id, 
          to: client.phone, 
          variables: default_variables || [client.company_name || 'there'],
          client_id: client.id, 
          outreach_type: 'broadcast'
        });
        if (result.success) sent++;
        else { failed++; errors.push(`${client.id}: Unknown failure`); }
        // Small throttle
        await new Promise(r => setTimeout(r, 250));
      } catch (e: any) {
        failed++; errors.push(`${client.id}: ${e.message}`);
      }
    }

    return c.json({ data: { success: true, total_recipients: clients.length, sent, skipped, failed, errors: errors.slice(0, 20) } });
  } catch (error: any) {
    console.error('[platformBroadcast] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
