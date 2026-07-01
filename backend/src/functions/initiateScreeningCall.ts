import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { Client as PgClient } from "jsr:@db/postgres@0.19.4";



// Initiates an AI screening call to a ServiceProvider using a ScreeningTemplate
// Creates a ScreeningCall record and sets up the agent config for the screening conversation

// ─── PG-PRIMARY CallLog helpers ───
// The streaming container (streamGeminiOutgoing) reads agent config PURELY from
// Postgres (call_logs.agent_config_cache) via custom_identifier. A screening
// call that only wrote a Base44 CallLog left PG empty → container fell back to a
// GENERIC prompt (the "generic agent speaking" bug). We mirror the CallLog into
// Postgres exactly like initiateCall does so the container loads the real config.
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
function genUuid() {
  try { return crypto.randomUUID(); }
  catch (_) { return 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12); }
}
async function pgInsertCallLog(row) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    const nowIso = new Date().toISOString();
    await pg.queryObject`
      INSERT INTO call_logs
        (id, client_id, agent_id, lead_id, call_sid, caller_id, callee_number,
         direction, status, agent_config_cache, conversation_summary, call_start_time, created_date, updated_at)
      VALUES
        (${row.id}, ${row.client_id}, ${row.agent_id}, ${row.lead_id || null}, ${row.call_sid},
         ${row.caller_id}, ${row.callee_number}, 'outbound', ${row.status || 'initiated'},
         ${JSON.stringify(row.agent_config_cache || {})}::jsonb, ${row.conversation_summary || ''},
         ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${nowIso}::timestamptz)
      ON CONFLICT (id) DO NOTHING`;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}
async function pgUpdateCallLogStatus(id, callSid, status) {
  const pg = makePgClient();
  try {
    ; /* pg.connect() not needed */
    if (callSid) await pg.queryObject`UPDATE call_logs SET call_sid = ${callSid}, status = ${status}, updated_at = now() WHERE id = ${id}`;
    else await pg.queryObject`UPDATE call_logs SET status = ${status}, updated_at = now() WHERE id = ${id}`;
  } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
}

export default async function initiateScreeningCall(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { provider_id, template_id, job_id, agent_id, attempt_count, max_attempts, partial_transcript, resume_context } = await c.req.json();
    if (!provider_id || !template_id) {
      return c.json({ data: { error: 'provider_id and template_id are required' } }, 400);
    }
    // Carry the running attempt count forward across automatic redials so the
    // retry chain terminates after max_attempts (defaults: attempt 1 of 3).
    const thisAttempt = Number(attempt_count) > 0 ? Number(attempt_count) : 1;
    const maxAttempts = Number(max_attempts) > 0 ? Number(max_attempts) : 3;
    // Mid-call-disconnect resume: when present, this redial continues a screening
    // that dropped mid-conversation rather than starting fresh.
    const isResume = !!(resume_context && (resume_context.answered_field_keys?.length || resume_context.next_question_text));
    const answeredKeys = new Set(resume_context?.answered_field_keys || []);

    // Fetch provider, template, and optionally agent in parallel
    const [provider, template] = await Promise.all([
      base44.asServiceRole.entities.ServiceProvider.get(provider_id),
      base44.asServiceRole.entities.ScreeningTemplate.get(template_id)
    ]);

    if (!provider) return c.json({ data: { error: 'Provider not found' } }, 404);
    if (!template) return c.json({ data: { error: 'Template not found' } }, 404);

    const clientId = provider.client_id;

    // Get the agent to use (either specified or find the first active one for this client)
    let agent;
    if (agent_id) {
      agent = await base44.asServiceRole.entities.Agent.get(agent_id);
    } else {
      const agents = await base44.asServiceRole.entities.Agent.filter({ client_id: clientId, status: 'active' });
      agent = agents[0];
    }
    if (!agent) return c.json({ data: { error: 'No active agent found' } }, 400);

    // Build the screening instruction block (kept compact — agent persona comes from buildAgentContext)
    // On a resume, annotate questions already answered in the dropped leg so the
    // AI skips them and only asks the remaining ones.
    const questionsText = (template.questions || []).map((q, i) => {
      const done = q.field_key && answeredKeys.has(q.field_key);
      const opts = q.answer_type === 'multiple_choice' ? ` (Options: ${q.options.join(', ')})` : '';
      const req = q.required ? ' [REQUIRED]' : '';
      return `${i + 1}. ${q.question_text}${opts}${req}${done ? '  ← ALREADY ANSWERED in the earlier call — DO NOT ask again' : ''}`;
    }).join('\n');

    // Reconnect opener + resume task differ from a fresh screening.
    const lang = template.language === 'hi-IN' ? 'Hindi (simple Hindustani)' : 'English';
    const taskBlock = isResume
      ? `THIS IS A RECONNECT — the previous call with this candidate got DISCONNECTED mid-screening.
TASK:
1. Open by briefly apologising for the drop, e.g. ${template.language === 'hi-IN'
          ? '"Maaf kijiye, hamari call kat gayi thi. Hum baat kar rahe the' + (resume_context?.last_topic ? ' ' + resume_context.last_topic + ' ke baare mein' : '') + '. Aage badhte hain."'
          : '"Sorry about that — it looks like our call got disconnected' + (resume_context?.last_topic ? ' while I was asking about ' + resume_context.last_topic : '') + '. Let\'s continue where we left off."'}
2. Do NOT re-greet from scratch or re-explain the whole screening. Do NOT re-ask questions marked "ALREADY ANSWERED".
3. Continue asking the REMAINING questions STRICTLY ONE AT A TIME, starting with: "${resume_context?.next_question_text || 'the next unanswered question'}"
4. Thank them at the end, then call end_call`
      : `TASK:
1. Greet the candidate warmly by name
2. Briefly explain this is a short screening for the ${template.category.replace(/_/g, ' ')} role
3. Ask questions STRICTLY ONE AT A TIME, wait for each answer
4. Thank them at the end, then call end_call`;

    const screeningData = `=== SCREENING INTERVIEW MODE ===
TEMPLATE: ${template.name}
${taskBlock}

QUESTIONS (in order):
${questionsText}

RULES:
- ONE question per response (max 1 question mark)
- Speak in ${lang}
- Do NOT share employer details or scoring info
- Keep call under ${template.max_call_duration_seconds || 300}s
${template.system_prompt_override || ''}`;

    // Create ScreeningCall record
    const screeningCall = await base44.asServiceRole.entities.ScreeningCall.create({
      client_id: clientId,
      provider_id,
      template_id,
      job_id: job_id || null,
      agent_id: agent.id,
      status: 'scheduled',
      attempt_count: thisAttempt,
      max_attempts: maxAttempts,
      // Preserve the dropped-leg transcript so final scoring merges both legs.
      partial_transcript: partial_transcript || null,
      resume_context: resume_context || null
    });

    // Update provider status
    await base44.asServiceRole.entities.ServiceProvider.update(provider_id, {
      screening_status: 'screening_scheduled',
      screening_template_id: template_id
    });

    // Get DID for the agent
    const allDIDs = (agent.assigned_dids && agent.assigned_dids.length > 0)
      ? agent.assigned_dids
      : (agent.assigned_did ? [agent.assigned_did] : []);

    if (allDIDs.length === 0) {
      return c.json({ data: { error: 'No DID assigned to agent' } }, 400);
    }
    const callerDID = allDIDs[0];

    // Build slim context via buildAgentContext (screening-aware)
    let slimCache = null;
    try {
      const ctxRes = await base44.asServiceRole.functions.invoke('buildAgentContext', {
        agent_id: agent.id,
        provider_id: provider_id,
        is_screening: true,
        screening_data: screeningData
      });
      slimCache = ctxRes?.data?.cache;
    } catch (e) {
      console.error('buildAgentContext failed for screening — falling back:', e.message);
    }

    // Fallback: build minimal cache inline
    if (!slimCache) {
      slimCache = {
        agent_name: agent.name,
        agent_id: agent.id,
        client_id: clientId,
        provider_id: provider_id,
        core_prompt: ((agent.system_prompt || '').substring(0, 1200) + '\n\n' + screeningData).substring(0, 1500),
        greeting_message: isResume
          ? (template.language === 'hi-IN'
            ? `Namaste ${provider.name} ji, maaf kijiye hamari pichhli call kat gayi thi. Aage badhte hain.`
            : `Hi ${provider.name}, sorry about that — our call got disconnected. Let's continue where we left off.`)
          : (agent.greeting_message
            ? agent.greeting_message.replace(/\{name\}/g, provider.name)
            : (template.language === 'hi-IN'
              ? `Namaste ${provider.name} ji, main ${agent.name} bol rahi hoon.`
              : `Hello ${provider.name}, I'm calling from ${agent.name}.`)),
        persona: agent.persona || {},
        tool_flags: { has_kb: false, has_shopify: false, has_unicommerce: false, has_call_history: false, has_transfer: false, has_end_call: true },
        kb_file_uri: agent.kb_file_uri || '',
        human_transfer_number: '',
        enable_auto_transfer: false,
        is_screening_call: true
      };
    }

    // Add screening-specific metadata needed by processScreeningResult
    const screeningCache = {
      ...slimCache,
      is_screening_call: true,
      screening_call_id: screeningCall.id,
      screening_template_id: template_id,
      provider_id: provider_id,
      // BACKWARD COMPAT (so old stream code keeps working)
      system_prompt: slimCache.core_prompt,
      knowledge_base_content: ''
    };

    // Create CallLog with slim screening cache
    const callLog = await base44.asServiceRole.entities.CallLog.create({
      client_id: clientId,
      agent_id: agent.id,
      call_sid: `screening_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      caller_id: callerDID,
      callee_number: provider.phone,
      direction: 'outbound',
      status: 'initiated',
      call_start_time: new Date().toISOString(),
      agent_config_cache: screeningCache
    });
    console.log(`[initiateScreeningCall] Slim cache built: core_prompt=${slimCache.core_prompt.length}ch`);

    // ─── MIRROR INTO POSTGRES (canonical for the streaming container) ───
    // The streaming container reads agent_config_cache from PG `call_logs` via
    // custom_identifier (O(1)) or callee phone-match. The PG `id` column is a
    // UUID — a Base44 id (24-hex) fails the uuid cast and the insert throws, so
    // the screening row never landed in PG → container fell back to a normal-lead
    // row for the same number → WRONG/GENERIC agent. We mirror with a real UUID
    // (same as initiateCall) and send THAT as custom_identifier.
    const pgCallLogId = genUuid();
    try {
      await pgInsertCallLog({
        id: pgCallLogId,
        client_id: clientId,
        agent_id: agent.id,
        lead_id: null,
        call_sid: callLog.call_sid,
        caller_id: callerDID,
        callee_number: provider.phone,
        status: 'initiated',
        agent_config_cache: screeningCache,
      });
      console.log(`[initiateScreeningCall] PG mirror written: pgCallLogId=${pgCallLogId} (base44=${callLog.id})`);
    } catch (e) {
      console.error('[initiateScreeningCall] PG mirror failed:', e.message);
    }

    // Update screening call with call_log_id
    await base44.asServiceRole.entities.ScreeningCall.update(screeningCall.id, {
      call_log_id: callLog.id,
      status: 'in_progress'
    });

    // Initiate the actual phone call via Smartflo
    let cleanCallerID = callerDID.replace(/[^0-9]/g, '');
    if (cleanCallerID.length === 10) cleanCallerID = '91' + cleanCallerID;
    const cleanPhone = provider.phone.replace(/[^0-9]/g, '');

    // Phase 2/3: route engine-specific outbound calls to dedicated channels.
    const isGeminiAgent = agent.persona?.voice_engine === 'gemini_live';
    const isRealtimeAgent = agent.persona?.voice_engine === 'realtime' || agent.persona?.voice_engine === 'azure_speech';
    const baseToken = agent.smartflo_api_token || Deno.env.get('SMARTFLO_API_KEY');
    let smartfloApiKey = baseToken;
    if (isGeminiAgent && Deno.env.get('SMARTFLO_C2C_GEMINI_OUTGOING')) {
      smartfloApiKey = Deno.env.get('SMARTFLO_C2C_GEMINI_OUTGOING');
      console.log('[initiateScreeningCall] 🔀 Routing via Gemini-Outgoing channel');
    } else if (isRealtimeAgent && Deno.env.get('SMARTFLO_C2C_REALTIME_OUTGOING')) {
      smartfloApiKey = Deno.env.get('SMARTFLO_C2C_REALTIME_OUTGOING');
      console.log('[initiateScreeningCall] 🔀 Routing via Realtime-Outgoing channel');
    }
    if (!smartfloApiKey) {
      return c.json({ data: { error: 'No Smartflo API token configured' } }, 400);
    }

    const smartfloRes = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: smartfloApiKey,
        customer_number: cleanPhone,
        caller_id: cleanCallerID,
        async: 1,
        // Echoed back into the stream's start.customParameters so the container
        // resolves THIS call's screening config in O(1) (same as initiateCall).
        // MUST be the PG UUID (not the Base44 CallLog id) — that's what the
        // container looks up in call_logs.
        custom_identifier: pgCallLogId
      })
    });
    const smartfloData = await smartfloRes.json();

    if (!smartfloRes.ok || smartfloData.success === false || smartfloData.error) {
      await base44.asServiceRole.entities.CallLog.update(callLog.id, { status: 'failed' });
      await pgUpdateCallLogStatus(pgCallLogId, '', 'failed').catch(() => {});
      await base44.asServiceRole.entities.ScreeningCall.update(screeningCall.id, { status: 'failed' });
      await base44.asServiceRole.entities.ServiceProvider.update(provider_id, { screening_status: 'not_screened' });
      return c.json({ data: { success: false, error: smartfloData.message || smartfloData.error || 'Call failed' } });
    }

    // Update call log with Smartflo response (Base44 + PG mirror)
    const finalCallSid = smartfloData.call_id || smartfloData.call_sid || callLog.call_sid;
    await base44.asServiceRole.entities.CallLog.update(callLog.id, {
      call_sid: finalCallSid,
      status: 'ringing'
    });
    await pgUpdateCallLogStatus(pgCallLogId, finalCallSid, 'ringing').catch(() => {});

    // Update provider to show screening is in progress
    await base44.asServiceRole.entities.ServiceProvider.update(provider_id, {
      screening_status: 'screening_in_progress'
    });

    return c.json({ data: {
      success: true,
      screening_call_id: screeningCall.id,
      call_log_id: callLog.id,
      message: `Screening call initiated to ${provider.name}`
    } });

  } catch (error) {
    console.error('[initiateScreeningCall] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};