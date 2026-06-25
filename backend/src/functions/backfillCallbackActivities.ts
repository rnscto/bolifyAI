import { base44ORM as base44 } from "../db/orm.ts";

export default async function backfillCallbackActivities(c: any) {
  try {
    const isCronCall = c.req.method === 'GET' && (() => {
      const cronSecret = c.req.query('cron_secret');
      const cronApiKey = c.req.query('api_key');
      const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
      const expectedCronKey = Deno.env.get('CRON_API_KEY');
      return (expectedSecret && cronSecret === expectedSecret) ||
             (expectedCronKey && cronApiKey === expectedCronKey) ||
             (expectedCronKey && cronSecret === expectedCronKey);
    })();

    const localUrl = c.req.url ? new URL(c.req.url).origin : 'http://127.0.0.1:8000';
    const invokeExtractor = async (callLogId: string) => {
      const res = await fetch(`${localUrl}/api/functions/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': c.req.header('Authorization') || ''
        },
        body: JSON.stringify({
          functionName: 'postCallActionExtractor',
          payload: { call_log_id: callLogId }
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      return res.json();
    };

    if (isCronCall) {
      const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentCalls = await base44.entities.CallLog.filter({ status: 'completed' }, '-created_at', 150);
      const eligible = recentCalls.filter((c: any) =>
        c.created_at >= cutoffIso &&
        c.transcript && c.transcript.length > 100 &&
        c.client_id && c.client_id !== 'unknown'
      );

      const toProcess = eligible.slice(0, 30);
      const result = { mode: 'cron', scanned: toProcess.length, skipped_already_scheduled: 0, extractor_invoked: 0, extractor_failed: 0 };

      const clientIds = [...new Set(toProcess.map((c: any) => c.client_id))];
      const scheduledLeadIds = new Set();
      await Promise.all(clientIds.map(async (cid) => {
        try {
          const [fa, ca] = await Promise.all([
            base44.entities.Activity.filter({ client_id: cid, type: 'followup', status: 'scheduled' }),
            base44.entities.Activity.filter({ client_id: cid, type: 'call', status: 'scheduled' })
          ]);
          [...fa, ...ca].forEach(a => { if (a.lead_id) scheduledLeadIds.add(a.lead_id); });
        } catch (_) {}
      }));

      const needsExtraction = [];
      for (const call of toProcess) {
        if (call.lead_id && scheduledLeadIds.has(call.lead_id)) {
          result.skipped_already_scheduled++;
        } else {
          needsExtraction.push(call);
        }
      }

      const BATCH = 5;
      for (let i = 0; i < needsExtraction.length; i += BATCH) {
        const batch = needsExtraction.slice(i, i + BATCH);
        await Promise.all(batch.map(async (call) => {
          try {
            await invokeExtractor(call.id);
            result.extractor_invoked++;
          } catch (e: any) {
            result.extractor_failed++;
            console.error(`[backfillCallbacks-cron] Failed call ${call.id}: ${e.message}`);
          }
        }));
      }

      console.log(`[backfillCallbacks-cron] Done: scanned=${result.scanned}, invoked=${result.extractor_invoked}, skipped=${result.skipped_already_scheduled}, failed=${result.extractor_failed}`);
      return c.json({ data: { success: true, ...result } });
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { client_id } = await c.req.json().catch(() => ({}));
    if (!client_id) {
      return c.json({ data: { error: 'Missing client_id' } }, 400);
    }

    if (user.role !== 'admin') {
      const ownedClients = await base44.entities.Client.filter({ user_id: user.id });
      if (!ownedClients.find((cl: any) => cl.id === client_id)) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const results = {
      mode: 'manual',
      scanned: 0,
      skipped_already_scheduled: 0,
      skipped_no_transcript: 0,
      extractor_invoked: 0,
      extractor_failed: 0,
      errors: [] as any[]
    };

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentCalls = await base44.entities.CallLog.filter({ client_id, status: 'completed' }, '-created_at', 100);
    const eligible = recentCalls.filter((c: any) => c.created_at >= cutoff && c.transcript && c.transcript.length > 100);

    const followupActs = await base44.entities.Activity.filter({ client_id, type: 'followup', status: 'scheduled' });
    const callActs = await base44.entities.Activity.filter({ client_id, type: 'call', status: 'scheduled' });
    const scheduledLeadIds = new Set([...followupActs, ...callActs].map(a => a.lead_id).filter(Boolean));

    const toProcess = eligible.slice(0, 20);
    results.scanned = toProcess.length;

    for (const call of toProcess) {
      try {
        if (!call.transcript || call.transcript.length < 100) {
          results.skipped_no_transcript++;
          continue;
        }
        if (call.lead_id && scheduledLeadIds.has(call.lead_id)) {
          results.skipped_already_scheduled++;
          continue;
        }

        try {
          await invokeExtractor(call.id);
          results.extractor_invoked++;
          if (call.lead_id) scheduledLeadIds.add(call.lead_id);
        } catch (e: any) {
          results.extractor_failed++;
          results.errors.push({ call_id: call.id, error: e.message });
        }
      } catch (e: any) {
        results.errors.push({ call_id: call.id, error: e.message });
      }
    }

    console.log(`[backfillCallbacks] Done for client ${client_id}: scanned=${results.scanned}, invoked=${results.extractor_invoked}, skipped=${results.skipped_already_scheduled}, failed=${results.extractor_failed}`);
    return c.json({ data: { success: true, ...results } });
  } catch (error: any) {
    console.error('[backfillCallbacks] Fatal:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
