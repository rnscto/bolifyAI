import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// whatsappCampaignPoller — Tick:
//   - Promote 'scheduled' campaigns whose scheduled_at has arrived to 'running'
//   - For each 'running' campaign, invoke executeWhatsAppCampaign (one batch)
//
// AUTH (any one):
//   - Header:  x-cron-key: $CRON_API_KEY   (or Authorization: Bearer $CRON_API_KEY)
//   - Query:   ?secret=$CRON_API_KEY  (or ?key=, ?cron_key=)
//   - Body:    { "secret": "$CRON_API_KEY" }
//   - OR authenticated admin user
// ═══════════════════════════════════════════════════════════════════



export default async function whatsappCampaignPoller(c: any) {
  const req = c.req.raw || c.req;
  try {
    const url = new URL(req.url);
    const expectedKey = Deno.env.get('CRON_API_KEY');

    const authHeader = req.headers.get('authorization') || '';
    const bearerKey = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
    const headerKey = req.headers.get('x-cron-key') || req.headers.get('x-api-key') || bearerKey;
    const queryKey = url.searchParams.get('secret') || url.searchParams.get('cron_key') || url.searchParams.get('key');

    let bodyKey = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        const b = await req.clone().json();
        bodyKey = b?.secret || b?.cron_key || null;
      } catch (_) { /* empty body ok */ }
    }
    const providedKey = headerKey || queryKey || bodyKey;
    const isCron = !!(expectedKey && providedKey && providedKey === expectedKey);

    const client = base44;;

    if (!isCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user || user.role !== 'admin') {
        return c.json({ data: {
          error: 'Forbidden — provide CRON_API_KEY via x-cron-key header, ?secret= query, or admin login'
        } }, 403);
      }
    }

    const svc = client.asServiceRole;
    const nowIso = new Date().toISOString();

    const scheduled = await svc.entities.WhatsAppCampaign.filter({ status: 'scheduled' }).catch(() => []);
    let promoted = 0;
    for (const c of scheduled) {
      if (!c.scheduled_at || new Date(c.scheduled_at).getTime() <= Date.now()) {
        await svc.entities.WhatsAppCampaign.update(c.id, {
          status: 'running',
          started_at: c.started_at || nowIso
        }).catch(() => {});
        promoted++;
      }
    }

    const running = await svc.entities.WhatsAppCampaign.filter({ status: 'running' }).catch(() => []);
    const results = [];
    for (const c of running) {
      try {
        const r = await svc.functions.invoke('executeWhatsAppCampaign', { campaign_id: c.id });
        results.push({ campaign_id: c.id, name: c.name, ...(r?.data || {}) });
      } catch (e) {
        results.push({ campaign_id: c.id, name: c.name, error: e.message });
      }
    }

    return c.json({ data: {
      success: true,
      triggered_by: isCron ? 'external_cron' : 'admin',
      promoted,
      ticked: results.length,
      results,
      at: nowIso
    } });
  } catch (error) {
    console.error('[whatsappCampaignPoller] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};