import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { Client as PgClient } from "jsr:@db/postgres@0.19.4";



// Cron job: polls POSTGRES for finished screening call_logs and processes them.
// The streaming container finalizes screening calls in Postgres ONLY (it can't
// write the transcript back to the Base44 CallLog), so screening must be driven
// off the PG `call_logs` row — that's what makes AI Screening work end-to-end.
//
// Handles:
// 1. COMPLETED screening calls with a transcript → processScreeningResult (PG transcript)
// 2. NO_ANSWER / FAILED / completed-without-transcript → mark ScreeningCall failed

function makePgClient() {
  return new PgClient({
    hostname: Deno.env.get('AZURE_PG_HOST'),
    port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
    database: Deno.env.get('AZURE_PG_DATABASE'),
    user: Deno.env.get('AZURE_PG_USER'),
    password: Deno.env.get('AZURE_PG_PASSWORD'),
    tls: { enabled: true, enforce: true },
    connection: { attempts: 1 },
  });
}

export default async function processScreeningOnCallUpdate(c: any) {
  const _req = c.req.raw || c.req;
  const pg = makePgClient();
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = base44;;

    ; /* pg.connect() not needed */

    // Pull recent (last 2h) finished outbound screening rows. We deliberately do
    // NOT filter on post_processed=false: a call can be prematurely claimed
    // (post_processed=true) and its ScreeningCall marked failed BEFORE the
    // transcript lands in PG (container finalizes at call-end). If we only looked
    // at unclaimed rows, that real transcript would sit forever unscored. Instead
    // we re-pick any completed row that HAS a transcript whose ScreeningCall is
    // still un-scored, and re-run the analysis. Already-scored calls are skipped
    // cheaply below.
    const cutoffIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const res = await pg.queryObject`
      SELECT id, status, duration, transcript,
             agent_config_cache->>'screening_call_id' AS screening_call_id,
             post_processed
      FROM call_logs
      WHERE direction = 'outbound'
        AND (agent_config_cache->>'is_screening_call') = 'true'
        AND status IN ('completed','failed','no_answer')
        AND (
          COALESCE(post_processed, false) = false
          OR (status = 'completed' AND length(coalesce(transcript,'')) >= 50)
        )
        AND created_date >= ${cutoffIso}::timestamptz
      ORDER BY created_date DESC
      LIMIT 50`;

    const rows = res.rows || [];
    let processed = 0, skipped = 0;

    for (const row of rows) {
      const screeningCallId = row.screening_call_id;
      if (!screeningCallId) { skipped++; continue; }

      let screeningCall;
      try { screeningCall = await svc.entities.ScreeningCall.get(screeningCallId); }
      catch (_) { skipped++; continue; }

      // A ScreeningCall is truly DONE only if it was actually SCORED
      // (screening_score present). A terminal-but-unscored call that was
      // prematurely marked failed (before the transcript landed) must be allowed
      // to re-process once the PG transcript exists — otherwise the real call
      // result is lost forever. So we only short-circuit when it's already scored.
      const alreadyScored = typeof screeningCall.screening_score === 'number';
      const hasUsableTranscript = row.transcript && row.transcript.length >= 50;

      if (alreadyScored) {
        await pg.queryObject`UPDATE call_logs SET post_processed = true, updated_at = now() WHERE id = ${row.id}`;
        skipped++;
        continue;
      }

      // If the ScreeningCall is terminal/unscored but there's STILL no transcript,
      // leave it as the genuine no-answer/failed it is and stop re-checking.
      if (['completed', 'failed', 'no_answer'].includes(screeningCall.status) && !hasUsableTranscript) {
        await pg.queryObject`UPDATE call_logs SET post_processed = true, updated_at = now() WHERE id = ${row.id}`;
        skipped++;
        continue;
      }

      // ─── MID-CALL DISCONNECT DETECTION ───
      // A call can end (completed/failed) with a PARTIAL transcript: the candidate
      // was answering but the line dropped before the screening finished. We must
      // NOT score that as the final result — instead resume on the next attempt,
      // naturally ("sorry, we got disconnected — I was asking about X").
      // We decide "finished vs interrupted" by checking whether all REQUIRED
      // questions appear to have been answered AND the AI delivered a closing.
      // If interrupted and attempts remain, carry the partial transcript forward.
      if (hasUsableTranscript) {
        let template = null;
        try { template = await svc.entities.ScreeningTemplate.get(screeningCall.template_id); } catch (_) {}
        const reqQuestions = (template?.questions || []).filter(q => q.required !== false);
        const transcriptLc = (row.transcript || '').toLowerCase();
        // Heuristic completion check: count how many required-question topics were
        // reached. We look for each question's text (or its key terms) in the
        // transcript. A closing phrase ("thank you", "that's all", "dhanyavaad")
        // signals the agent wrapped up normally.
        const closingHit = /(thank you|that's all|that is all|dhanyavaad|shukriya|have a (great|good) day)/i.test(transcriptLc);
        let reachedCount = 0;
        for (const q of reqQuestions) {
          const probe = (q.question_text_en || q.question_text || '').toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3);
          if (probe.length && probe.some(w => transcriptLc.includes(w))) reachedCount++;
        }
        const allReached = reqQuestions.length === 0 || reachedCount >= reqQuestions.length;
        const screeningComplete = closingHit && allReached;

        const attemptN = screeningCall.attempt_count || 1;
        const maxN = screeningCall.max_attempts || 3;
        const callDropped = row.status !== 'completed' || !screeningComplete;

        if (callDropped && attemptN < maxN) {
          // Build a resume hint: which question topics were covered, and what to
          // ask next (the first required question not yet reached).
          const answeredKeys = reqQuestions
            .filter(q => {
              const probe = (q.question_text_en || q.question_text || '').toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3);
              return probe.length && probe.some(w => transcriptLc.includes(w));
            })
            .map(q => q.field_key)
            .filter(Boolean);
          const nextQ = (template?.questions || []).find(q => q.field_key && !answeredKeys.includes(q.field_key));
          const lastTopic = nextQ?.question_text_en || nextQ?.question_text || 'where we left off';

          const RETRY_DELAY_MIN = 5;
          const nextRetryAt = new Date(Date.now() + RETRY_DELAY_MIN * 60 * 1000).toISOString();
          await svc.entities.ScreeningCall.update(screeningCallId, {
            status: 'retry_scheduled',
            next_retry_at: nextRetryAt,
            retry_reason: 'Call disconnected mid-screening — will resume from where it dropped',
            call_duration: row.duration || 0,
            partial_transcript: row.transcript,
            resume_context: {
              answered_field_keys: answeredKeys,
              next_question_text: nextQ?.question_text || nextQ?.question_text_en || '',
              last_topic: lastTopic,
            },
          });
          if (screeningCall.provider_id) {
            await svc.entities.ServiceProvider.update(screeningCall.provider_id, {
              screening_status: 'screening_scheduled',
              screening_summary: `Call disconnected mid-screening — resuming on redial (attempt ${attemptN + 1}/${maxN}).`,
            });
          }
          await pg.queryObject`UPDATE call_logs SET post_processed = true, updated_at = now() WHERE id = ${row.id}`;
          console.log(`[cron-screening] MID-CALL DROP → resume scheduled (attempt ${attemptN + 1}/${maxN}) for ${screeningCallId}; covered ${answeredKeys.length}/${reqQuestions.length} questions`);
          processed++;
          continue;
        }

        // Otherwise treat as a finished screening → score it (merging any prior
        // partial transcript from an earlier dropped leg so all answers count).
        const mergedTranscript = screeningCall.partial_transcript
          ? `${screeningCall.partial_transcript}\n\n--- [Call reconnected after disconnect] ---\n\n${row.transcript}`
          : row.transcript;
        console.log(`[cron-screening] PG row ${row.id} → ScreeningCall ${screeningCallId} (transcript=${mergedTranscript.length}ch${screeningCall.partial_transcript ? ', merged with prior leg' : ''})`);
        row.transcript = mergedTranscript;
        try {
          const result = await svc.functions.invoke('processScreeningResult', {
            screening_call_id: screeningCallId,
            call_log_id: row.id,
            transcript: row.transcript,
            call_log: { id: row.id, duration: row.duration, transcript: row.transcript },
          });
          console.log(`[cron-screening] ✅ ${screeningCallId}:`, JSON.stringify(result?.data || {}).substring(0, 160));
          processed++;
        } catch (e) {
          console.error(`[cron-screening] ❌ ${screeningCallId}: ${e.message}`);
        }
        await pg.queryObject`UPDATE call_logs SET post_processed = true, updated_at = now() WHERE id = ${row.id}`;
        continue;
      }

      // CASE 2: no answer / failed / completed without transcript.
      const failReason = row.status === 'no_answer'
        ? 'Candidate did not answer the call'
        : row.status === 'failed'
          ? 'Call failed to connect'
          : 'Call connected but no conversation captured';

      // ─── AUTO-REDIAL ───
      // A screening call that dropped/was unanswered should be retried
      // automatically (up to max_attempts) so the screening can complete without
      // manual re-dialing. If attempts remain, schedule a retry instead of giving
      // up — processScreeningRetries places the redial once it's due (and within
      // IST calling hours). Only give up permanently once attempts are exhausted.
      const attempt = screeningCall.attempt_count || 1;
      const maxAttempts = screeningCall.max_attempts || 3;
      if (attempt < maxAttempts) {
        const RETRY_DELAY_MIN = 5; // wait 5 minutes before the next redial
        const nextRetryAt = new Date(Date.now() + RETRY_DELAY_MIN * 60 * 1000).toISOString();
        await svc.entities.ScreeningCall.update(screeningCallId, {
          status: 'retry_scheduled',
          next_retry_at: nextRetryAt,
          retry_reason: failReason,
          call_duration: row.duration || 0,
        });
        if (screeningCall.provider_id) {
          await svc.entities.ServiceProvider.update(screeningCall.provider_id, {
            screening_status: 'screening_scheduled',
            screening_summary: `${failReason} — automatic redial scheduled (attempt ${attempt + 1}/${maxAttempts}).`,
          });
        }
        await pg.queryObject`UPDATE call_logs SET post_processed = true, updated_at = now() WHERE id = ${row.id}`;
        console.log(`[cron-screening] Retry scheduled (attempt ${attempt + 1}/${maxAttempts}) for ${screeningCallId} at ${nextRetryAt}`);
        processed++;
        continue;
      }

      // Attempts exhausted → final failure.
      await svc.entities.ScreeningCall.update(screeningCallId, {
        status: row.status === 'no_answer' ? 'no_answer' : 'failed',
        ai_summary: `${failReason} (after ${attempt} attempt${attempt > 1 ? 's' : ''}).`,
        result: 'inconclusive',
        next_retry_at: null,
        call_duration: row.duration || 0,
      });
      if (screeningCall.provider_id) {
        await svc.entities.ServiceProvider.update(screeningCall.provider_id, {
          screening_status: 'not_screened',
          screening_summary: `${failReason} (after ${attempt} attempt${attempt > 1 ? 's' : ''}).`,
        });
      }
      await pg.queryObject`UPDATE call_logs SET post_processed = true, updated_at = now() WHERE id = ${row.id}`;
      console.log(`[cron-screening] Marked ${row.status} (attempts exhausted): ${screeningCallId}`);
      processed++;
    }

    console.log(`[cron-screening] Done. Processed: ${processed}, Skipped: ${skipped}`);
    return c.json({ data: { success: true, processed, skipped, scanned: rows.length } });
  } catch (error) {
    console.error('[cron-screening] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  } finally {
    try { ; /* pg.end() not needed */ } catch (_) {}
  }

};