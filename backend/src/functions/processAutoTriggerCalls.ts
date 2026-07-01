import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Scheduled job (every 5 min) — places AI calls for leads whose
// auto_call_scheduled_at has passed. Set by onNewLeadAutoTrigger.
//
// For each due lead:
//   - Invoke initiateCall(lead_id, agent_id, phone)
//   - Clear auto_call_scheduled_at so it isn't picked up twice
//
// TRAI-friendly: respects 10am–9pm IST calling window (defers calls outside).



function isIndianBusinessHours() {
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = nowIST.getHours();
  return h >= 9 && h < 21;
}

export default async function processAutoTriggerCalls(c: any) {
  const req = c.req.raw || c.req;
  try {
    // External cron auth — accept CRON_API_KEY via header, query, or body.
    // Falls through to authenticated admin if no cron key present.
    const url = new URL(req.url);
    const expectedKey = Deno.env.get('CRON_API_KEY');
    const authHeader = req.headers.get('authorization') || '';
    const bearerKey = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
    const headerKey = req.headers.get('x-cron-key') || req.headers.get('x-api-key') || bearerKey;
    const queryKey = url.searchParams.get('secret') || url.searchParams.get('api_key') || url.searchParams.get('key');
    let bodyKey = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        const b = await req.clone().json();
        bodyKey = b?.secret || b?.cron_key || null;
      } catch (_) {}
    }
    const providedKey = headerKey || queryKey || bodyKey;
    const isCron = !!(expectedKey && providedKey && providedKey === expectedKey);

    const client = base44;;
    if (!isCron) {
      const user = c.get('jwtPayload').catch(() => null);
      if (!user || user.role !== 'admin') {
        return c.json({ data: { error: 'Forbidden — provide CRON_API_KEY' } }, 403);
      }
    }
    const base44 = client.asServiceRole;

    if (!isIndianBusinessHours()) {
      console.log('[processAutoTriggerCalls] Outside IST 10am-9pm window — skipping');
      return c.json({ data: { skipped: 'outside_calling_hours' } });
    }

    const nowIso = new Date().toISOString();
    // Pull leads with a scheduled call due now
    const dueLeads = await base44.entities.Lead.filter(
      { auto_call_scheduled_at: { $lte: nowIso } },
      '-auto_call_scheduled_at',
      50
    ).catch(() => []);

    const pending = (dueLeads || []).filter(l => l.auto_call_scheduled_at && l.auto_call_agent_id);
    console.log(`[processAutoTriggerCalls] ${pending.length} leads due`);

    // One call per client at a time — track in-flight clients within this run
    // and check existing live CallLogs before each dial.
    const busyClients = new Set();
    async function isClientBusy(clientId) {
      if (busyClients.has(clientId)) return true;
      const [a, b, c] = await Promise.all([
        base44.entities.CallLog.filter({ client_id: clientId, status: 'initiated' }, '-created_date', 1).catch(() => []),
        base44.entities.CallLog.filter({ client_id: clientId, status: 'ringing' }, '-created_date', 1).catch(() => []),
        base44.entities.CallLog.filter({ client_id: clientId, status: 'answered' }, '-created_date', 1).catch(() => []),
      ]);
      const live = (a.length + b.length + c.length) > 0;
      if (live) busyClients.add(clientId);
      return live;
    }

    const results = [];
    for (const lead of pending) {
      try {
        if (await isClientBusy(lead.client_id)) {
          // Defer: leave auto_call_scheduled_at intact (push +2 min) so it retries next tick
          const retryAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
          await base44.entities.Lead.update(lead.id, { auto_call_scheduled_at: retryAt });
          results.push({ lead_id: lead.id, success: false, deferred: true, error: 'client busy' });
          continue;
        }

        // Clear immediately so a slow call doesn't get retried
        await base44.entities.Lead.update(lead.id, {
          auto_call_scheduled_at: null,
          auto_actions_taken: [...(lead.auto_actions_taken || []), `auto_call_fired:${new Date().toISOString()}`]
        });

        const callRes = await base44.functions.invoke('initiateCall', {
          lead_id: lead.id,
          agent_id: lead.auto_call_agent_id,
          phone_number: lead.phone,
          service_call: true
        });

        if (callRes?.data?.success) busyClients.add(lead.client_id);

        results.push({
          lead_id: lead.id,
          success: !!callRes?.data?.success,
          error: callRes?.data?.error || null
        });
      } catch (e) {
        console.error(`[processAutoTriggerCalls] lead ${lead.id} failed:`, e.message);
        results.push({ lead_id: lead.id, success: false, error: e.message });
      }
    }

    return c.json({ data: { processed: results.length, results } });
  } catch (error) {
    console.error('[processAutoTriggerCalls] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};