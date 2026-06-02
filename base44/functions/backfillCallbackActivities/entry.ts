import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Backfill scheduled callback Activities for past calls that requested a callback
// but never got an Activity created (e.g. calls from before postCallActionExtractor
// was deployed, or calls that failed extraction).
//
// Strategy:
//  1. Find recent completed CallLogs (last 30 days) for this client that have a transcript.
//  2. Skip calls that already have any scheduled call/followup Activity for the same lead.
//  3. Invoke postCallActionExtractor for each — it will create the Activity if a callback
//     was requested in the transcript.
//
// Triggered manually from the ClientCallbacks page via the "Backfill" button.
// Capped at 20 calls per run to fit cron/HTTP limits.

Deno.serve(async (req) => {
  try {
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