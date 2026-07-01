import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Syncs WhatsApp templates from RCS Digital → MessageTemplate entity for the PLATFORM account.
// Stores templates with client_id = "platform" so they're isolated from client templates.
//
// Admin-only. Returns count of templates upserted.



const RCS_BASE = 'https://rcsdigital.in';
const VERSION = 'v23.0';

export default async function syncPlatformTemplates(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const configs = await base44.asServiceRole.entities.PlatformMessagingConfig.list();
    const config = configs[0];
    if (!config || !config.whatsapp_api_key || !config.whatsapp_business_id) {
      return c.json({ data: { error: 'Platform WhatsApp not configured' } }, 400);
    }

    // Fetch templates from RCS Digital (Meta-compatible endpoint)
    const url = `${RCS_BASE}/${VERSION}/${config.whatsapp_business_id}/message_templates?limit=200`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${config.whatsapp_api_key}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return c.json({ data: { error: data?.error?.message || `HTTP ${res.status}`, details: data } }, 400);
    }

    const templates = data?.data || [];
    const existing = await base44.asServiceRole.entities.MessageTemplate.filter({ client_id: 'platform' });
    const existingByName = new Map(existing.map(t => [t.name, t]));

    let upserted = 0;
    for (const t of templates) {
      const bodyComp = (t.components || []).find(c => c.type === 'BODY');
      const headerComp = (t.components || []).find(c => c.type === 'HEADER');
      const footerComp = (t.components || []).find(c => c.type === 'FOOTER');
      const buttonsComp = (t.components || []).find(c => c.type === 'BUTTONS');

      const fields = {
        client_id: 'platform',
        vendor: 'rcs_digital',
        channel: 'whatsapp',
        name: t.name,
        category: t.category || 'UTILITY',
        language: t.language || 'en',
        body: bodyComp?.text || '',
        header_type: headerComp ? (headerComp.format || 'text').toLowerCase() : 'none',
        header_text: headerComp?.text || '',
        footer_text: footerComp?.text || '',
        buttons: (buttonsComp?.buttons || []).map(b => ({ type: b.type, text: b.text, url: b.url, phone_number: b.phone_number })),
        approval_status: (t.status || 'pending').toLowerCase(),
        vendor_template_id: t.id || '',
        rejection_reason: t.rejected_reason || '',
        last_synced_at: new Date().toISOString(),
        ...(t.status === 'APPROVED' ? { approved_at: new Date().toISOString() } : {}),
      };

      const existingTpl = existingByName.get(t.name);
      if (existingTpl) {
        await base44.asServiceRole.entities.MessageTemplate.update(existingTpl.id, fields);
      } else {
        await base44.asServiceRole.entities.MessageTemplate.create(fields);
      }
      upserted++;
    }

    return c.json({ data: { success: true, total: templates.length, upserted } });
  } catch (e) {
    console.error('[syncPlatformTemplates] error:', e);
    return c.json({ data: { error: e.message } }, 500);
  }

};