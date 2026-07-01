import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// resetMonthlyMinutes — Daily housekeeping for US/UK minute packs.
//
// For each US/UK client whose minutes_period_start is ≥ 30 days old:
//   1. Triggers overage billing (chargeIntlOverage) for the closed period
//   2. Resets minutes_used_this_period = 0
//   3. Advances minutes_period_start to today
//
// Invocation:
//   • External cron (cron-job.org, EasyCron, etc.) via GET with ?api_key=$CRON_API_KEY
//   • Manual GET / POST with the same api_key for ad-hoc triggering
//
// Eliminates dependency on Base44 integration credits for scheduling.
// ═══════════════════════════════════════════════════════════════════════



export default async function resetMonthlyMinutes(c: any) {
  const req = c.req.raw || c.req;
  try {
    // ─── Auth — external cron must send ?api_key=$CRON_API_KEY ───
    const url = new URL(req.url);
    const apiKey = url.searchParams.get('api_key');
    const expectedKey = Deno.env.get('CRON_API_KEY');
    if (!expectedKey) {
      console.error('[resetMonthlyMinutes] CRON_API_KEY not configured');
      return c.json({ data: { error: 'Server misconfigured' } }, 500);
    }
    if (apiKey !== expectedKey) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }
    console.log('[resetMonthlyMinutes] Triggered by external cron');

    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // Find all US/UK clients with a minute pack
    const clients = await svc.entities.Client.filter({}).catch(() => []);
    const intlClients = clients.filter(
      (c) => (c.region === 'US' || c.region === 'UK') && c.minutes_included > 0
    );

    const now = new Date();
    const results = { checked: intlClients.length, reset: 0, skipped: 0, overage_charged: 0, errors: [] };

    for (const client of intlClients) {
      try {
        const periodStart = client.minutes_period_start ? new Date(client.minutes_period_start) : null;

        // If no period start, initialize it (don't reset usage)
        if (!periodStart) {
          await svc.entities.Client.update(client.id, { minutes_period_start: now.toISOString() });
          results.skipped++;
          continue;
        }

        const daysSince = (now - periodStart) / (1000 * 60 * 60 * 24);
        if (daysSince < 30) {
          results.skipped++;
          continue;
        }

        const used = Number(client.minutes_used_this_period || 0);
        const included = Number(client.minutes_included || 0);
        const overMinutes = Math.max(0, used - included);

        // Trigger overage billing (fire-and-forget) for the closed period
        if (overMinutes > 0 && client.overage_rate) {
          svc.functions.invoke('chargeIntlOverage', {
            client_id: client.id,
            over_minutes: overMinutes,
            period_start: periodStart.toISOString(),
            period_end: now.toISOString(),
          }).catch((e) => console.error('[resetMonthlyMinutes] chargeIntlOverage failed:', e.message));
          results.overage_charged++;
        }

        // Reset counter and advance period
        await svc.entities.Client.update(client.id, {
          minutes_used_this_period: 0,
          minutes_period_start: now.toISOString(),
        });
        results.reset++;
        console.log(`[resetMonthlyMinutes] Reset ${client.company_name} — used ${used}/${included} (overage: ${overMinutes} min)`);
      } catch (e) {
        results.errors.push({ client_id: client.id, error: e.message });
      }
    }

    return c.json({ data: { success: true, ...results } });
  } catch (error) {
    console.error('[resetMonthlyMinutes] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};