import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Backfill scheduled callback Activities for past calls that requested a callback
// but never got an Activity created (e.g. calls from before postCallActionExtractor
// was deployed, or calls that failed extraction).
//
// TWO MODES:
//
// 1) MANUAL (POST, authenticated): triggered from the ClientCallbacks page for
//    a single client. Body: { client_id }. Scans last 30 days, up to 20 calls.
//
// 2) CRON (GET, ?cron_secret=...): platform-wide safety net for ALL clients.
//    Scans last 24h of completed calls across the platform and re-invokes
//    postCallActionExtractor for any call that has a transcript but no
//    scheduled call/followup Activity for its lead. Caps at 100 calls per run.
//
// This is the belt-and-braces guarantee: even if the hot-path inline invoke in
// smartfloWebhook / streamAudioInbound ever misses a call, this cron will catch
// it within 5 minutes (depending on the external cron schedule).

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const cronSecret = url.searchParams.get('cron_secret');
    const cronApiKey = url.searchParams.get('api_key');
    const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
    const expectedCronKey = Deno.env.get('CRON_API_KEY');
    const isCronCall = req.method === 'GET' && (
      (expectedSecret && cronSecret === expectedSecret) ||
      (expectedCronKey && cronApiKey === expectedCronKey) ||
      (expectedCronKey && cronSecret === expectedCronKey)
    );

    // ─── CRON MODE: Platform-wide backfill (no auth, secret-protected) ───
    if (isCronCall) {
      const { createClient } = await import('npm:@base44/sdk@0.8.25');
      const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

      const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // Scan only the last 24h of completed calls across the platform
      const recentCalls = await svc.entities.CallLog.filter({ status: 'completed' }, '-created_date', 300);
      const eligible = recentCalls.filter(c =>
        c.created_date >= cutoffIso &&
        c.transcript && c.transcript.length > 100 &&
        c.client_id && c.client_id !== 'unknown'
      );

      const toProcess = eligible.slice(0, 100);
      const result = { mode: 'cron', scanned: toProcess.length, skipped_already_scheduled: 0, extractor_invoked: 0, extractor_failed: 0 };

      // Pre-build a set of (lead_id) that already have a scheduled call/followup
      // to skip cheaply. We batch by client_id to keep queries small.
      const clientIds = [...new Set(toProcess.map(c => c.client_id))];
      const scheduledLeadIds = new Set();
      for (const cid of clientIds) {
        try {
          const [fa, ca] = await Promise.all([
            svc.entities.Activity.filter({ client_id: cid, type: 'followup', status: 'scheduled' }),
            svc.entities.Activity.filter({ client_id: cid, type: 'call', status: 'scheduled' })
          ]);
          [...fa, ...ca].forEach(a => { if (a.lead_id) scheduledLeadIds.add(a.lead_id); });
        } catch (_) {}
      }

      for (const call of toProcess) {
        if (call.lead_id && scheduledLeadIds.has(call.lead_id)) {
          result.skipped_already_scheduled++;
          continue;
        }
        try {
          await svc.functions.invoke('postCallActionExtractor', { call_log_id: call.id });
          result.extractor_invoked++;
          if (call.lead_id) scheduledLeadIds.add(call.lead_id);
        } catch (e) {
          result.extractor_failed++;
          console.error(`[backfillCallbacks-cron] Failed call ${call.id}: ${e.message}`);
        }
      }

      console.log(`[backfillCallbacks-cron] Done: scanned=${result.scanned}, invoked=${result.extractor_invoked}, skipped=${result.skipped_already_scheduled}, failed=${result.extractor_failed}`);
      return Response.json({ success: true, ...result });
    }

    // ─── MANUAL MODE: Per-client, user-triggered (existing behavior) ───
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { client_id } = await req.json();
    if (!client_id) {
      return Response.json({ error: 'Missing client_id' }, { status: 400 });
    }

    // Verify the user owns this client (or is admin)
    if (user.role !== 'admin') {
      const ownedClients = await base44.entities.Client.filter({ user_id: user.id });
      if (!ownedClients.find(c => c.id === client_id)) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const svc = base44.asServiceRole;
    const results = {
      mode: 'manual',
      scanned: 0,
      skipped_already_scheduled: 0,
      skipped_no_transcript: 0,
      extractor_invoked: 0,
      extractor_failed: 0,
      errors: []
    };

    // Last 30 days of completed calls (max 100 to keep runtime sane)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentCalls = await svc.entities.CallLog.filter({ client_id, status: 'completed' }, '-created_date', 100);
    const eligible = recentCalls.filter(c => c.created_date >= cutoff && c.transcript && c.transcript.length > 100);

    // Pre-fetch existing scheduled call/followup activities once to dedupe
    const followupActs = await svc.entities.Activity.filter({ client_id, type: 'followup', status: 'scheduled' });
    const callActs = await svc.entities.Activity.filter({ client_id, type: 'call', status: 'scheduled' });
    const scheduledLeadIds = new Set([...followupActs, ...callActs].map(a => a.lead_id).filter(Boolean));

    // Process up to 20 calls per run
    const toProcess = eligible.slice(0, 20);
    results.scanned = toProcess.length;

    for (const call of toProcess) {
      try {
        if (!call.transcript || call.transcript.length < 100) {
          results.skipped_no_transcript++;
          continue;
        }
        // Skip if lead already has a queued callback
        if (call.lead_id && scheduledLeadIds.has(call.lead_id)) {
          results.skipped_already_scheduled++;
          continue;
        }

        // Invoke postCallActionExtractor — it will create Activities only if the
        // AI detects an actionable callback in the transcript. Idempotent because
        // postCallActionExtractor has its own dedup logic.
        try {
          await svc.functions.invoke('postCallActionExtractor', { call_log_id: call.id });
          results.extractor_invoked++;
          // Mark this lead as scheduled so we don't double-process within this run
          if (call.lead_id) scheduledLeadIds.add(call.lead_id);
        } catch (e) {
          results.extractor_failed++;
          results.errors.push({ call_id: call.id, error: e.message });
        }
      } catch (e) {
        results.errors.push({ call_id: call.id, error: e.message });
      }
    }

    console.log(`[backfillCallbacks] Done for client ${client_id}: scanned=${results.scanned}, invoked=${results.extractor_invoked}, skipped=${results.skipped_already_scheduled}, failed=${results.extractor_failed}`);
    return Response.json({ success: true, ...results });
  } catch (error) {
    console.error('[backfillCallbacks] Fatal:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});