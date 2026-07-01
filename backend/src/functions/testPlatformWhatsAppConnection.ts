import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Quick health check for the platform RCS Digital WhatsApp connection.
// Hits the WABA endpoint; returns connected/error and updates whatsapp_status + whatsapp_last_tested.



export default async function testPlatformWhatsAppConnection(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') return c.json({ data: { error: 'Forbidden' } }, 403);

    const cfgList = await base44.asServiceRole.entities.PlatformMessagingConfig.list();
    const cfg = cfgList[0];
    if (!cfg || !cfg.whatsapp_api_key || !cfg.whatsapp_business_id) {
      return c.json({ data: { ok: false, error: 'Missing api_key or business_id' } });
    }

    const url = `https://rcsdigital.in/v23.0/${cfg.whatsapp_business_id}?fields=id,name`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfg.whatsapp_api_key}` } });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && (data?.id || data?.name);

    await base44.asServiceRole.entities.PlatformMessagingConfig.update(cfg.id, {
      whatsapp_status: ok ? 'connected' : 'error',
      whatsapp_last_tested: new Date().toISOString()
    });
    return c.json({ data: { ok, details: data } });
  } catch (e) {
    return c.json({ data: { ok: false, error: e.message } }, 500);
  }

};