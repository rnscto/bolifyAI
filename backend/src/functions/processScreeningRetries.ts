import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// ═══════════════════════════════════════════════════════════════════════
// processScreeningRetries — automatic redial for dropped/unanswered screenings
// ═══════════════════════════════════════════════════════════════════════
// Cron job. Picks up ScreeningCall rows in status 'retry_scheduled' whose
// next_retry_at is due, and re-initiates the screening call (carrying the
// running attempt_count forward so the chain stops at max_attempts).
//
// Why a separate runner: processScreeningOnCallUpdate decides WHETHER to retry
// (when a call ends as no_answer/failed/no-transcript and attempts remain) and
// just schedules next_retry_at. This runner actually places the redial once it's
// due AND we're inside the IST calling window (10:00–21:00). It marks the old
// ScreeningCall row terminal so it isn't picked again, then invokes
// initiateScreeningCall which creates the next attempt's row.
// ═══════════════════════════════════════════════════════════════════════

// IST calling window (same compliance window used by processAutoTriggerCalls).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istHour() {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  return nowIst.getUTCHours();
}

export default async function processScreeningRetries(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Auth: CRON_API_KEY (header or body) or an admin session.
    const cronKey = Deno.env.get('CRON_API_KEY');
    let authed = false;
    const headerKey = req.headers.get('x-cron-key') || req.headers.get('x-api-key');
    let body = {};
    try { body = await c.req.json(); } catch (_) { body = {}; }
    if (cronKey && (headerKey === cronKey || body.cron_key === cronKey)) authed = true;

    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = base44;;

    if (!authed) {
      // Allow an authenticated admin to trigger manually.
      try {
        const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.31');
        const userClient = base44;;
        const user = c.get('jwtPayload');
        if (user && user.role === 'admin') authed = true;
      } catch (_) { /* ignore */ }
    }
    if (!authed) return c.json({ data: { error: 'Unauthorized' } }, 401);

    // Respect IST calling hours — defer redials placed outside 10:00–21:00 IST.
    const hour = istHour();
    if (hour < 10 || hour >= 21) {
      return c.json({ data: { success: true, skipped: 'outside_calling_hours', ist_hour: hour } });
    }

    const nowIso = new Date().toISOString();
    const due = await svc.entities.ScreeningCall.filter({ status: 'retry_scheduled' }, '-next_retry_at', 50);

    let redialed = 0, skipped = 0, exhausted = 0;
    for (const sc of due) {
      // Only fire once the scheduled time has passed.
      if (!sc.next_retry_at || sc.next_retry_at > nowIso) { skipped++; continue; }

      const attempt = sc.attempt_count || 1;
      const maxAttempts = sc.max_attempts || 3;
      const nextAttempt = attempt + 1;

      // Safety: if somehow already at the cap, finalize instead of redialing.
      if (nextAttempt > maxAttempts) {
        await svc.entities.ScreeningCall.update(sc.id, {
          status: 'no_answer',
          next_retry_at: null,
          ai_summary: `${sc.retry_reason || 'Call did not complete'} (after ${attempt} attempts).`,
          result: 'inconclusive',
        });
        exhausted++;
        continue;
      }

      // Mark the current row terminal so it's not re-picked, then place the redial.
      await svc.entities.ScreeningCall.update(sc.id, {
        status: 'failed',
        next_retry_at: null,
        ai_summary: `${sc.retry_reason || 'Call did not complete'} — redialed (attempt ${nextAttempt}/${maxAttempts}).`,
      });

      try {
        await svc.functions.invoke('initiateScreeningCall', {
          provider_id: sc.provider_id,
          template_id: sc.template_id,
          job_id: sc.job_id || null,
          agent_id: sc.agent_id || null,
          attempt_count: nextAttempt,
          max_attempts: maxAttempts,
          // Carry forward mid-call-disconnect context so the redial resumes
          // naturally ("sorry, we got disconnected — I was asking about X")
          // and skips questions already answered in the dropped leg.
          partial_transcript: sc.partial_transcript || null,
          resume_context: sc.resume_context || null,
        });
        console.log(`[processScreeningRetries] Redialed ${sc.provider_id} (attempt ${nextAttempt}/${maxAttempts})`);
        redialed++;
      } catch (e) {
        console.error(`[processScreeningRetries] Redial failed for ScreeningCall ${sc.id}: ${e.message}`);
        // Re-queue shortly so a transient failure doesn't drop the retry.
        await svc.entities.ScreeningCall.update(sc.id, {
          status: 'retry_scheduled',
          next_retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }).catch(() => {});
      }
    }

    console.log(`[processScreeningRetries] Done. Redialed: ${redialed}, Skipped: ${skipped}, Exhausted: ${exhausted}`);
    return c.json({ data: { success: true, redialed, skipped, exhausted, scanned: due.length } });
  } catch (error) {
    console.error('[processScreeningRetries] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};