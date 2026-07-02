import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { createClient, createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";

// Processes a completed screening call — extracts structured answers from transcript,
// scores the candidate, and updates ScreeningCall + ServiceProvider records
// Called automatically after a screening call completes (via postCallActionExtractor or manually)

export default async function processScreeningResult(c: any) {
  const req = c.req.raw || c.req;
  try {
    const body = await c.req.json();
    // call_log (resolved Postgres row) + transcript may be passed directly by
    // postCallOrchestrator so we never depend on the Base44 CallLog (the
    // streaming container finalizes the call in Postgres only — it cannot write
    // the transcript back to the Base44 CallLog). This is what makes screening
    // work end-to-end on PG.
    const { screening_call_id, call_log_id, call_log: pgCallLog, transcript: passedTranscript } = body;
    console.log(`[processScreeningResult] Called with screening_call_id=${screening_call_id}, call_log_id=${call_log_id}, pgTranscript=${passedTranscript ? passedTranscript.length + 'ch' : 'no'}`);

    if (!screening_call_id && !call_log_id) {
      return c.json({ data: { error: 'screening_call_id or call_log_id required' } }, 400);
    }

    // Use service role directly — this function is called from streamAudio/Gemini
    // via serviceClient.functions.invoke(), not from frontend with user auth
    const appId = Deno.env.get('BASE44_APP_ID');
    const svc = base44;;

    // Find the screening call
    let screeningCall;
    if (screening_call_id) {
      screeningCall = await svc.entities.ScreeningCall.get(screening_call_id);
    } else {
      const calls = await svc.entities.ScreeningCall.filter({ call_log_id });
      screeningCall = calls[0];
    }

    if (!screeningCall) {
      // Resolve via screening metadata in agent_config_cache. Prefer the PG row
      // passed in (PG-only id 404s on a Base44 .get), else try Base44.
      const cache = pgCallLog?.agent_config_cache
        || (call_log_id ? (await svc.entities.CallLog.get(call_log_id).catch(() => null))?.agent_config_cache : null);
      if (cache?.is_screening_call && cache.screening_call_id) {
        screeningCall = await svc.entities.ScreeningCall.get(cache.screening_call_id).catch(() => null);
      }
      if (!screeningCall) return c.json({ data: { success: false, error: 'Screening call not found' } });
    }

    // GUARD: Refuse to process screening calls without a valid template_id.
    // Legitimate screening calls are created by initiateScreeningCall with a real template_id.
    // Records without template_id are rogue (from old bad is_screening_call keyword detection).
    if (!screeningCall.template_id) {
      console.warn(`[processScreeningResult] ⚠️ ScreeningCall ${screeningCall.id} has no template_id — refusing to process (likely misclassified inbound call)`);
      return c.json({ data: { success: false, error: 'No template_id — not a valid screening call' } });
    }

    // Fetch related data. The Base44 CallLog may not exist (PG-only finalize) —
    // tolerate a 404 and use the passed PG row for duration.
    const [callLog, template, provider] = await Promise.all([
      screeningCall.call_log_id ? svc.entities.CallLog.get(screeningCall.call_log_id).catch(() => null) : null,
      svc.entities.ScreeningTemplate.get(screeningCall.template_id).catch(() => null),
      svc.entities.ServiceProvider.get(screeningCall.provider_id).catch(() => null)
    ]);
    const callDuration = pgCallLog?.duration || callLog?.duration || 0;

    if (!template) {
      console.warn(`[processScreeningResult] ⚠️ Template ${screeningCall.template_id} not found — aborting`);
      return c.json({ data: { success: false, error: 'Template not found' } });
    }
    if (!provider) {
      console.warn(`[processScreeningResult] ⚠️ Provider ${screeningCall.provider_id} not found — aborting`);
      return c.json({ data: { success: false, error: 'Provider not found' } });
    }

    // Transcript source priority: explicitly passed (from PG) → passed PG callLog
    // row → the Base44 CallLog (legacy). The container finalizes in PG only, so
    // the PG-sourced transcript is the reliable path.
    const transcript = passedTranscript || pgCallLog?.transcript || callLog?.transcript || '';
    if (!transcript || transcript.length < 50) {
      await svc.entities.ScreeningCall.update(screeningCall.id, {
        status: 'failed',
        ai_summary: 'No sufficient transcript to analyze',
        result: 'inconclusive'
      });
      await svc.entities.ServiceProvider.update(screeningCall.provider_id, {
        screening_status: 'on_hold'
      });
      return c.json({ data: { success: false, error: 'Insufficient transcript' } });
    }

    // Use Azure OpenAI for analysis — normalize endpoint
        const openaiIdx = baseUrl.indexOf('/openai/');
    if (openaiIdx > 0) baseUrl = baseUrl.substring(0, openaiIdx);
    const apiProjIdx = baseUrl.indexOf('/api/projects');
    if (apiProjIdx > 0) baseUrl = baseUrl.substring(0, apiProjIdx);
            if (!baseUrl || !deployment || !apiKey) {
      return c.json({ data: { error: 'Azure OpenAI not configured' } }, 500);
    }

    const questionsJson = (template.questions || []).map(q => ({
      id: q.id, field_key: q.field_key, question: q.question_text_en || q.question_text,
      answer_type: q.answer_type, required: q.required, weight: q.scoring_weight || 1
    }));

    const analysisRes = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: `You are an expert HR screening analyst reviewing real-world phone interview transcripts.

IMPORTANT CONTEXT:
- Transcripts are from real phone calls in India and often contain: mixed Hindi/English/regional languages (Hinglish, Telugu, Marathi, Tamil), speech-recognition errors, garbled phrases, background noise, and interruptions.
- Your job is to DO YOUR BEST to extract answers from the meaningful parts — IGNORE garbled/nonsense phrases.
- ALWAYS return all fields below with best-effort values. If a specific answer cannot be found, set its confidence to 0.1 and answer to "Not clearly stated". DO NOT return empty extracted_answers — always include every template question key.
- Make a reasonable judgement call on scoring even with imperfect transcripts.

SCREENING TEMPLATE QUESTIONS:
${JSON.stringify(questionsJson, null, 2)}

SCORING RULES:
- Score each question 0-10 based on the candidate's answer (10=perfect match, 5=partial/unclear, 0=not answered or concerning)
- Calculate overall_score as weighted average normalized to 0-100 (use the 'weight' field for each question)
- Flag red flags (inconsistencies, concerning answers) — can be empty array
- Note strengths (relevant experience, clarity, enthusiasm) — can be empty array

Respond ONLY in valid JSON. NEVER return an empty object — always fill all fields with your best inference.`
          },
          {
            role: 'user',
            content: `Candidate: ${provider.name} (${provider.category})\n\nTRANSCRIPT:\n${transcript}\n\nReturn JSON with this EXACT structure (fill every field — use "Not clearly stated" + confidence 0.1 for unknowns, NEVER leave extracted_answers empty):
{
  "extracted_answers": { "<field_key>": { "answer": "...", "confidence": 0.0-1.0 } },
  "score_breakdown": { "<question_id>": { "score": 0-10, "max_score": 10, "reasoning": "..." } },
  "overall_score": 0-100,
  "summary": "2-3 sentence summary of candidate's suitability",
  "recommendation": "strongly_recommend|recommend|neutral|not_recommended|reject",
  "red_flags": ["..."],
  "strengths": ["..."],
  "result": "passed|failed|inconclusive"
}`
          }
        ],
        max_completion_tokens: 2000,
        response_format: { type: "json_object" }
      })
    });

    if (!analysisRes.ok) {
      const errBody = await analysisRes.text().catch(() => '');
      console.error(`[processScreeningResult] AI analysis HTTP ${analysisRes.status}: ${errBody.substring(0, 500)}`);
      // Mark as inconclusive but DO NOT overwrite provider's existing successful data
      await svc.entities.ScreeningCall.update(screeningCall.id, {
        status: 'completed',
        transcript,
        result: 'inconclusive',
        ai_summary: `AI analysis failed (HTTP ${analysisRes.status}). Transcript saved — retry processing manually.`,
        call_duration: callDuration
      });
      return c.json({ data: { success: false, error: 'AI analysis failed', http_status: analysisRes.status } });
    }

    const rawContent = (await analysisRes.json()).choices?.[0]?.message?.content || '{}';
    let analysis;
    try {
      analysis = JSON.parse(rawContent);
    } catch (parseErr) {
      console.error(`[processScreeningResult] JSON parse failed: ${parseErr.message}, raw: ${rawContent.substring(0, 300)}`);
      await svc.entities.ScreeningCall.update(screeningCall.id, {
        status: 'completed',
        transcript,
        result: 'inconclusive',
        ai_summary: 'AI returned unparseable JSON. Transcript saved — retry processing manually.',
        call_duration: callDuration
      });
      return c.json({ data: { success: false, error: 'AI JSON parse failed' } });
    }

    // GUARD: if AI returned empty analysis, RETRY ONCE with a simpler, more aggressive prompt
    let hasAnswers = analysis.extracted_answers && Object.keys(analysis.extracted_answers).length > 0;
    let hasScore = typeof analysis.overall_score === 'number' && analysis.overall_score > 0;
    if (!hasAnswers && !hasScore) {
      console.warn(`[processScreeningResult] ⚠️ First attempt empty. Retrying with simpler prompt...`);
      try {
        const retryRes = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
          method: 'POST',
          headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'Extract candidate info from this phone interview transcript. The transcript may be messy with mixed languages and speech-recognition errors — do your best. ALWAYS fill every field. Respond in JSON.' },
              { role: 'user', content: `Candidate: ${provider.name} (${provider.category})\nTranscript:\n${transcript}\n\nExtract the following (use "Not stated" if unclear, never return empty):\n${(template.questions || []).map(q => `- ${q.field_key}: ${q.question_text_en || q.question_text}`).join('\n')}\n\nReturn JSON:\n{\n  "extracted_answers": { "<field_key>": { "answer": "best-effort answer or Not stated", "confidence": 0.0-1.0 } for EVERY field above },\n  "overall_score": 0-100 (best guess based on answered questions),\n  "summary": "2-3 sentence summary",\n  "recommendation": "strongly_recommend|recommend|neutral|not_recommended|reject",\n  "red_flags": [],\n  "strengths": [],\n  "score_breakdown": {}\n}` }
            ],
            max_completion_tokens: 2000,
            response_format: { type: "json_object" }
          })
        });
        if (retryRes.ok) {
          const retryRaw = (await retryRes.json()).choices?.[0]?.message?.content || '{}';
          const retryAnalysis = JSON.parse(retryRaw);
          const retryHasAnswers = retryAnalysis.extracted_answers && Object.keys(retryAnalysis.extracted_answers).length > 0;
          const retryHasScore = typeof retryAnalysis.overall_score === 'number' && retryAnalysis.overall_score > 0;
          if (retryHasAnswers || retryHasScore) {
            console.log(`[processScreeningResult] ✅ Retry succeeded`);
            analysis = retryAnalysis;
            hasAnswers = retryHasAnswers;
            hasScore = retryHasScore;
          }
        }
      } catch (retryErr) {
        console.error(`[processScreeningResult] Retry failed: ${retryErr.message}`);
      }
    }

    // If still empty after retry, mark inconclusive without overwriting provider data
    if (!hasAnswers && !hasScore) {
      console.warn(`[processScreeningResult] ⚠️ AI returned empty analysis after retry. Marking inconclusive, NOT overwriting provider data.`);
      await svc.entities.ScreeningCall.update(screeningCall.id, {
        status: 'completed',
        transcript,
        result: 'inconclusive',
        ai_summary: 'AI analysis produced no structured answers (transcript may be too noisy). Transcript saved — review manually.',
        call_duration: callDuration,
        score_breakdown: analysis.score_breakdown || {}
      });
      // DON'T update ServiceProvider — preserve previous successful data
      return c.json({ data: { success: false, error: 'Empty AI analysis — provider data preserved' } });
    }

    const passingScore = template.passing_score || 60;
    const finalResult = analysis.overall_score >= passingScore ? 'passed' : 'failed';

    // Update ScreeningCall
    await svc.entities.ScreeningCall.update(screeningCall.id, {
      status: 'completed',
      transcript,
      extracted_answers: analysis.extracted_answers || {},
      screening_score: analysis.overall_score || 0,
      score_breakdown: analysis.score_breakdown || {},
      ai_summary: analysis.summary || '',
      ai_recommendation: analysis.recommendation || 'neutral',
      red_flags: analysis.red_flags || [],
      strengths: analysis.strengths || [],
      result: finalResult,
      call_duration: callDuration
    });

    // Update ServiceProvider — only write fields that have real values (don't blank out existing data)
    const providerUpdate = {
      screening_status: finalResult === 'passed' ? 'passed' : 'failed',
      screening_score: analysis.overall_score || 0,
      screening_call_id: screeningCall.call_log_id || '',
    };
    if (analysis.summary) providerUpdate.screening_summary = analysis.summary;
    if (hasAnswers) providerUpdate.screening_answers = analysis.extracted_answers;
    // Merge extracted structured data
    if (analysis.extracted_answers?.experience_years?.answer) providerUpdate.experience_years = parseInt(analysis.extracted_answers.experience_years.answer) || 0;
    if (analysis.extracted_answers?.skills?.answer) providerUpdate.skills = Array.isArray(analysis.extracted_answers.skills.answer) ? analysis.extracted_answers.skills.answer : [analysis.extracted_answers.skills.answer];
    if (analysis.extracted_answers?.expected_salary?.answer) providerUpdate.expected_salary = parseInt(analysis.extracted_answers.expected_salary.answer) || 0;
    if (analysis.extracted_answers?.location?.answer) providerUpdate.location = analysis.extracted_answers.location.answer;
    if (analysis.extracted_answers?.education?.answer) providerUpdate.education = analysis.extracted_answers.education.answer;
    if (analysis.extracted_answers?.languages_spoken?.answer) {
      const langs = analysis.extracted_answers.languages_spoken.answer;
      providerUpdate.languages_spoken = Array.isArray(langs) ? langs : [langs];
    }
    console.log(`[processScreeningResult] Updating provider ${screeningCall.provider_id}: status=${providerUpdate.screening_status}, score=${providerUpdate.screening_score}`);
    await svc.entities.ServiceProvider.update(screeningCall.provider_id, providerUpdate);

    console.log(`[processScreeningResult] ${provider.name}: score=${analysis.overall_score}, result=${finalResult}, recommendation=${analysis.recommendation}`);

    // ─── Webhook Push: Send structured JSON to client's CRM/Dashboard ───
    if (template.result_push_enabled && template.webhook_url) {
      try {
        const webhookPayload = {
          event: 'screening_completed',
          timestamp: new Date().toISOString(),
          screening_call_id: screeningCall.id,
          template: { id: template.id, name: template.name, category: template.category },
          candidate: {
            id: provider.id,
            name: provider.name,
            phone: provider.phone,
            email: provider.email || null,
            category: provider.category,
            location: provider.location || null,
            experience_years: provider.experience_years || null,
            education: provider.education || null,
            current_company: provider.current_company || null,
            current_role: provider.current_role || null,
            skills: provider.skills || [],
          },
          result: {
            score: analysis.overall_score || 0,
            passing_score: template.passing_score || 60,
            outcome: finalResult,
            recommendation: analysis.recommendation || 'neutral',
            summary: analysis.summary || '',
            red_flags: analysis.red_flags || [],
            strengths: analysis.strengths || [],
          },
          extracted_answers: analysis.extracted_answers || {},
          score_breakdown: analysis.score_breakdown || {},
          call_metadata: {
            call_log_id: screeningCall.call_log_id || null,
            duration_seconds: callDuration,
            transcript_length: transcript.length,
          }
        };

        const webhookHeaders = {
          'Content-Type': 'application/json',
          ...(template.webhook_headers || {})
        };

        const webhookRes = await fetch(template.webhook_url, {
          method: 'POST',
          headers: webhookHeaders,
          body: JSON.stringify(webhookPayload)
        });

        console.log(`[processScreeningResult] Webhook push to ${template.webhook_url}: status=${webhookRes.status}`);

        // Update provider with webhook push timestamp
        await svc.entities.ServiceProvider.update(provider.id, {
          last_webhook_push: new Date().toISOString()
        });

        // If webhook returned an external ID, store it
        try {
          const webhookResponse = await webhookRes.json();
          if (webhookResponse?.id || webhookResponse?.external_id || webhookResponse?.crm_id) {
            await svc.entities.ServiceProvider.update(provider.id, {
              external_crm_id: webhookResponse.id || webhookResponse.external_id || webhookResponse.crm_id
            });
          }
        } catch (_) { /* response may not be JSON */ }
      } catch (webhookErr) {
        console.error(`[processScreeningResult] Webhook push failed: ${webhookErr.message}`);
      }
    }

    return c.json({ data: {
      success: true,
      provider_name: provider.name,
      score: analysis.overall_score,
      result: finalResult,
      recommendation: analysis.recommendation,
      summary: analysis.summary
    } });

  } catch (error) {
    console.error('[processScreeningResult] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};