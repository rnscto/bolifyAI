import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// emailCampaignPoller — External-cron-driven tick:
//   - Promotes 'scheduled' campaigns whose scheduled_at has arrived to 'running'
//   - For each 'running' campaign, invokes executeEmailCampaign (one batch)
//
// AUTH (any one of):
//   - Header:  x-cron-key: $CRON_API_KEY
//   - Query:   ?secret=$CRON_API_KEY
//   - Body:    { "secret": "$CRON_API_KEY" }
//   - OR authenticated admin user
//
// Recommended external schedule: every 5 minutes.
// Example (cron-job.org / EasyCron / GitHub Actions):
//   GET  https://<app-domain>/functions/emailCampaignPoller?secret=YOUR_CRON_API_KEY
// ═══════════════════════════════════════════════════════════════════



export default async function emailCampaignPoller(c: any) {
  const req = c.req.raw || c.req;
  try {
    const url = new URL(req.url);
    const expectedKey = Deno.env.get('CRON_API_KEY');

    // Collect cron key from header / query / body
    const headerKey = req.headers.get('x-cron-key') || req.headers.get('x-api-key');
    const queryKey = url.searchParams.get('secret') || url.searchParams.get('cron_key');
    let bodyKey = null;
    let bodyParsed = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        bodyParsed = await req.clone().json();
        bodyKey = bodyParsed?.secret || bodyParsed?.cron_key || null;
      } catch (_) {
        // ignore — body may be empty
      }
    }
    const providedKey = headerKey || queryKey || bodyKey;
    const isCron = !!(expectedKey && providedKey && providedKey === expectedKey);

    const client = base44;;

    if (!isCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user || user.role !== 'admin') {
        return c.json({ data: { error: 'Forbidden — provide CRON_API_KEY via x-cron-key header, ?secret= query, or admin login' } }, 403);
      }
    }

    const svc = client.asServiceRole;
    const nowIso = new Date().toISOString();

    // 1. Promote scheduled → running when due
    const scheduled = await svc.entities.EmailCampaign.filter({ status: 'scheduled' }).catch(() => []);
    let promoted = 0;
    for (const c of scheduled) {
      if (!c.scheduled_at || new Date(c.scheduled_at).getTime() <= Date.now()) {
        await svc.entities.EmailCampaign.update(c.id, {
          status: 'running',
          started_at: c.started_at || nowIso
        }).catch(() => {});
        promoted++;
      }
    }

    // 2. Tick each running campaign (one batch each)
    const running = await svc.entities.EmailCampaign.filter({ status: 'running' }).catch(() => []);
    const results = [];
    for (const c of running) {
      try {
        const r = await svc.functions.invoke('executeEmailCampaign', { campaign_id: c.id });
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
    console.error('[emailCampaignPoller] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};