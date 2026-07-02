import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";
// ⚠️ DEPRECATED Phase 4 — replaced by streamGeminiPersonal/Outgoing/Incoming. Kept online for backward compat. DO NOT add features here.
// streamAudioGemini — Gemini 3.1 Flash Live (legacy monolithic stream)
// ─── Audio Conversion Helpers — Smartflo 8kHz mu-law ↔ Gemini 16k input / 24k output PCM16 ───

function decodeMulaw(mulawByte) {
  const MULAW_BIAS = 33;
  let mu = ~mulawByte & 0xFF;
  const sign = (mu & 0x80) ? -1 : 1;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign * sample;
}

function encodeMulaw(sample) {
  const MULAW_MAX = 32635;
  const MULAW_BIAS = 33;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;
  let exponent = 7;
  const expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & expMask) break;
    sample <<= 1;
  }
  const mantissa = (sample >> 10) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Audio state is now per-session (moved into session object to avoid cross-call contamination)

// Convert mu-law 8kHz → PCM16 16kHz LE base64 (upsample 2x for Gemini input)
// session object is passed for per-session audio state
function mulawToBase64PCM16_16k(mulawBytes, session) {
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm8k[i] = decodeMulaw(mulawBytes[i]);
  }
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = i === 0 ? session._lastUpsampleValue : pcm8k[i - 1];
    const s1 = pcm8k[i];
    pcm16k[i * 2] = s1;
    pcm16k[i * 2 + 1] = Math.round((s1 + (i < pcm8k.length - 1 ? pcm8k[i + 1] : s1)) / 2);
  }
  if (pcm8k.length > 0) session._lastUpsampleValue = pcm8k[pcm8k.length - 1];

  const buffer = new Uint8Array(pcm16k.length * 2);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < pcm16k.length; i++) {
    view.setInt16(i * 2, pcm16k[i], true);
  }
  let binary = '';
  for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]);
  return btoa(binary);
}

// Convert PCM16 24kHz LE base64 (Gemini output) → mu-law 8kHz (downsample 3x)
function base64PCM16_24kToMulaw(base64Pcm16, session) {
  const raw = atob(base64Pcm16);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  const numSamples = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const remainder = session._lastDownsampleRemainder;
  const allSamples = new Int16Array(remainder.length + numSamples);
  for (let i = 0; i < remainder.length; i++) allSamples[i] = remainder[i];
  for (let i = 0; i < numSamples; i++) allSamples[remainder.length + i] = view.getInt16(i * 2, true);

  const totalSamples = allSamples.length;
  const downsampledLen = Math.floor(totalSamples / 3);
  const mulaw = new Uint8Array(downsampledLen);

  for (let i = 0; i < downsampledLen; i++) {
    const idx = i * 3;
    const prev = idx > 0 ? allSamples[idx - 1] : allSamples[idx];
    const curr = allSamples[idx];
    const next = idx + 1 < totalSamples ? allSamples[idx + 1] : curr;
    const filtered = Math.round((prev + 2 * curr + next) / 4);
    const clamped = Math.max(-32768, Math.min(32767, filtered));
    mulaw[i] = encodeMulaw(clamped);
  }

  const consumed = downsampledLen * 3;
  session._lastDownsampleRemainder = [];
  for (let i = consumed; i < totalSamples; i++) session._lastDownsampleRemainder.push(allSamples[i]);
  return mulaw;
}

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─── Filler audio cache (cold-start hider) ───
// Single pre-recorded "Hello" mu-law 8kHz clip stored in private storage.
// Fetched ONCE per isolate at module load (kicks off in background), then served
// from in-memory Uint8Array for every subsequent call. Zero per-call network/TTS.
const FILLER_URI = 'mp/private/698823c19043e168a5daaa86/69ee309a0_filler_hello.mulaw';
let _fillerCache = null;
let _fillerLoadPromise = null;

async function loadFillerFromStorage(uri, label) {
  try {
    
    const sdk = base44;;
    const { signed_url } = await sdk.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: 3600 });
    const res = await fetch(signed_url);
    if (!res.ok) { console.error(`[filler] fetch failed for ${label}: ${res.status}`); return null; }
    const buf = new Uint8Array(await res.arrayBuffer());
    console.log(`[filler] Loaded ${label}: ${buf.length} bytes (~${Math.round(buf.length/8000*1000)}ms)`);
    return buf;
  } catch (e) {
    console.error(`[filler] load error for ${label}: ${e.message}`);
    return null;
  }
}

async function getFillerAudio() {
  if (_fillerCache) return _fillerCache;
  if (!_fillerLoadPromise) _fillerLoadPromise = loadFillerFromStorage(FILLER_URI, 'hello');
  _fillerCache = await _fillerLoadPromise;
  return _fillerCache;
}

// Pre-warm: kick off fetch at module load so the very first call is also instant
_fillerLoadPromise = loadFillerFromStorage(FILLER_URI, 'hello').then(b => { _fillerCache = b; return b; });

// ─── Save call record (identical to streamAudio) ───
async function saveCallRecord(session, reqId, duration) {
  if (!session.callLogId) { console.log(`[${reqId}] ⚠️ No callLogId, skipping save`); return; }
  if (session._saved) return;
  session._saved = true;

  try {
    // Flush any pending transcription text before saving
    if (session._pendingCustomerText) {
      session.transcript.push({ speaker: 'Customer', text: session._pendingCustomerText.trim() });
      session._pendingCustomerText = '';
    }
    if (session._pendingAiText) {
      session.transcript.push({ speaker: 'AI', text: session._pendingAiText.trim() });
      session._pendingAiText = '';
    }
    const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
    
    const appId = Deno.env.get('BASE44_APP_ID');
    const serviceClient = base44;;

                        let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0, intentSignals = [], scoreBreakdown = {}, keyTopics = [], objections = [];
    let summaryHindi = '';

    if (transcript && transcript.trim().length > 30 && baseUrl && deployment && apiKey) {
      try {
        const analysisRes = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
          method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: `You are an expert sales call analyst. Analyze the transcript and provide a comprehensive analysis.\n\nIMPORTANT TRANSCRIPTION NOTES:\n- Speech-to-text can MISINTERPRET short words. Common errors: "Hi" heard as "Bye-bye", "Haan" as "Nah", "Hello" as various words.\n- If the transcript is very short (1-2 lines) and the customer only said a single word like "Bye-bye", "Bye", or similar — consider that it might actually be a greeting.\n- Do NOT mark a lead as "do_not_call" or "very_negative" based on a single ambiguous short word.\n- Only use "do_not_call" when the customer EXPLICITLY says they don't want to be called.\n\nSCORING (total 100):\n- Sentiment (0-25)\n- Intent signals (0-30)\n- Engagement (0-25)\n- Keywords (0-20)\n\nRespond ONLY in valid JSON.` },
              { role: 'user', content: `Analyze this call transcript:\n\n${transcript}\n\nReturn JSON:\n{"summary":"2-3 sentence summary","summary_hindi":"Same in Hindi DEVANAGARI","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":[],"objections":[],"recommended_next_action":"..."}` }
            ], max_completion_tokens: 800, response_format: { type: "json_object" }
          })
        });
        if (analysisRes.ok) {
          const analysis = JSON.parse((await analysisRes.json()).choices?.[0]?.message?.content || '{}');
          summary = analysis.summary || '';
          summaryHindi = analysis.summary_hindi || '';
          leadStatus = analysis.lead_status || 'contacted';
          sentiment = analysis.sentiment || 'neutral';
          leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
          intentSignals = analysis.intent_signals || [];
          scoreBreakdown = { ...(analysis.score_breakdown || {}), objections: analysis.objections || [], recommended_next_action: analysis.recommended_next_action || '', key_topics: analysis.key_topics || [], summary_hindi: summaryHindi };
          keyTopics = analysis.key_topics || [];
          console.log(`[${reqId}] 🧠 AI Analysis: score=${leadScore}, status=${leadStatus}, sentiment=${sentiment}`);
        }
      } catch (e) { console.error(`[${reqId}] ⚠️ AI analysis error: ${e.message}`); }
    } else if (!transcript || transcript.trim().length <= 30) {
      summary = 'Call ended with minimal or no conversation captured.';
    }

    // Short call safeguard
    const customerLines = session.transcript.filter(t => t.speaker === 'Customer');
    const totalCustomerWords = customerLines.reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);
    if (totalCustomerWords <= 5 && duration < 30) {
      if (leadStatus === 'do_not_call' || leadStatus === 'not_interested') {
        leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
      }
    }

    let qualificationTier = 'cold', qualificationReason = '';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) { qualificationTier = 'hot'; qualificationReason = `Score ${leadScore}/100, ${sentiment}`; }
    else if (leadScore >= 50) { qualificationTier = 'warm'; qualificationReason = `Score ${leadScore}/100`; }
    else if (leadScore >= 25) { qualificationTier = 'nurture'; qualificationReason = `Score ${leadScore}/100`; }
    else if (['negative', 'very_negative'].includes(sentiment)) { qualificationTier = 'disqualified'; }
    if (leadStatus === 'converted') { qualificationTier = 'hot'; }
    if (leadStatus === 'do_not_call') { qualificationTier = 'disqualified'; }

    const enrichedSummary = summary ? `${summary}${summaryHindi ? '\n\n🇮🇳 ' + summaryHindi : ''}\n\n---\nScore: ${leadScore}/100 | Sentiment: ${sentiment} | Tier: ${qualificationTier} | Signals: ${intentSignals.join(', ')}` : '';

    const currentLog = await serviceClient.entities.CallLog.get(session.callLogId);
    const wasAlreadyCompleted = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);

    const callLogUpdate = wasAlreadyCompleted
      ? { transcript: transcript || '', duration, lead_status_updated: leadStatus, ...(enrichedSummary ? { conversation_summary: enrichedSummary } : {}) }
      : { status: 'completed', transcript: transcript || '', duration, call_end_time: new Date().toISOString(), lead_status_updated: leadStatus, ...(enrichedSummary ? { conversation_summary: enrichedSummary } : {}) };
    // ── POSTGRES-PRIMARY WRITE ── transcript + summary survive a Base44 429.
    try { await serviceClient.functions.invoke('pgLeadSync', { call_log: { ...currentLog, ...callLogUpdate } }); }
    catch (pgErr) { console.error(`[${reqId}] ⚠️ PG-primary write failed: ${pgErr.message}`); }
    await serviceClient.entities.CallLog.update(session.callLogId, callLogUpdate);
    console.log(`[${reqId}] 💾 Call saved: ${session.callLogId}, score=${leadScore}`);

    // Update Lead
    const leadId = currentLog.lead_id || session._inboundLeadId;
    if (leadId) {
      try {
        const existingLead = await serviceClient.entities.Lead.get(leadId);
        const mergedTags = [...new Set([...(existingLead.tags || []), ...keyTopics.slice(0, 10)])];
        await serviceClient.entities.Lead.update(leadId, {
          status: leadStatus, score: leadScore, sentiment, intent_signals: intentSignals, score_breakdown: scoreBreakdown,
          qualification_tier: qualificationTier, qualification_reason: qualificationReason, tags: mergedTags,
          last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString(),
          engagement_count: (existingLead.engagement_count || 0) + 1,
          notes: `[Score: ${leadScore}/100 | ${sentiment} | ${qualificationTier}] ${summary.substring(0, 300)}`
        });
      } catch (e) { console.error(`[${reqId}] ⚠️ Lead update failed: ${e.message}`); }
    }

    // Save VoicemailMessage for personal accounts
    if (session._personalMode && session._personalClientId) {
      try {
        const customerMsgs = session.transcript.filter(t => t.speaker === 'Customer').map(t => t.text);
        const summaryLower = (summary || '').toLowerCase();
        let category = 'unknown';
        if (summaryLower.includes('spam')) category = 'spam';
        else if (summaryLower.includes('promotional')) category = 'promotional';
        else if (summaryLower.includes('family')) category = 'family';
        else if (summaryLower.includes('business')) category = 'business';
        let urgency = 'medium';
        if (summaryLower.includes('urgent') || summaryLower.includes('emergency')) urgency = 'urgent';
        else if (sentiment === 'very_positive') urgency = 'high';
        else if (category === 'spam' || category === 'promotional') urgency = 'low';
        // Resolve caller identity (trusted > saved > lead > AI-extracted from transcript) so summary shows the real name
        const cPh = currentLog.caller_id || session.callerNumber || '';
        const rId = (session._isTrustedCaller && session._trustedContactName) ? { name: session._trustedContactName, source: 'Saved Contact' } : await resolveCallerName(serviceClient, session._personalClientId, cPh, { transcript, baseUrl, deployment, apiKey });
        await serviceClient.entities.VoicemailMessage.create({ client_id: session._personalClientId, call_log_id: session.callLogId, caller_number: cPh, caller_name: rId.name || '', message: summary || customerMsgs.join(' ').substring(0, 1000), urgency, category, is_read: false });
        // Telegram post-call summary
        const tgTk = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgTk) {
          try {
            const pCl = await serviceClient.entities.Client.get(session._personalClientId);
            if (pCl?.telegram_connected && pCl?.telegram_chat_id && !pCl.dnd_enabled && pCl.owner_notification_channel === 'telegram') {
              const emj = category === 'spam' ? '🚫' : category === 'family' ? '👨‍👩‍👧' : category === 'business' ? '💼' : '📋';
              const freshLog = await serviceClient.entities.CallLog.get(session.callLogId);
              const recLine = freshLog?.recording_url ? `\n\n🎧 <a href="${freshLog.recording_url}">Play Recording</a>` : '';
              const hindiLine = summaryHindi ? `\n\n🇮🇳 ${summaryHindi.substring(0, 300)}` : '';
              const fromLine = rId.name ? `<b>${rId.name}</b>${cPh ? `\n📞 ${cPh}` : ''}${rId.source ? `\n🏷️ ${rId.source}` : ''}` : `<b>${cPh || 'Unknown'}</b>`;
              const tgS = `${emj} <b>Call Summary</b>\n\n📱 From: ${fromLine}\n📂 ${category}\n\n💬 ${(summary).substring(0, 400)}${hindiLine}${recLine}`;
              fetch(`https://api.telegram.org/bot${tgTk}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: pCl.telegram_chat_id, text: tgS, parse_mode: 'HTML', disable_web_page_preview: false }) }).catch(() => {});
            }
          } catch (_) {}
        }
      } catch (e) { console.error(`[${reqId}] ⚠️ Voicemail save failed: ${e.message}`); }
    }

    // Fetch recording & extract actions
    setTimeout(() => {
      serviceClient.functions.invoke('fetchCallRecording', { call_log_id: session.callLogId }).catch(() => {});
    }, 20000);
    if (transcript.length > 50 && !session._personalMode) {
      serviceClient.functions.invoke('postCallActionExtractor', { call_log_id: session.callLogId }).catch(() => {});
    }

    // Auto-create Lead for inbound calls from unknown numbers (business accounts only)
    if (
      currentLog?.direction === 'inbound' &&
      !currentLog?.lead_id &&
      !session._inboundLeadId &&
      transcript.length > 50 &&
      !session._personalMode &&
      !session._isScreeningAgent &&
      !currentLog?.agent_config_cache?.is_screening_call
    ) {
      serviceClient.functions.invoke('autoCreateLeadFromInbound', { call_log_id: session.callLogId })
        .then(r => console.log(`[${reqId}] 🆕 autoCreateLeadFromInbound: ${JSON.stringify(r?.data || {}).substring(0, 150)}`))
        .catch(e => console.error(`[${reqId}] ⚠️ autoCreateLeadFromInbound failed: ${e.message}`));
    }

    // Process screening result if this was a screening call
    if (currentLog?.agent_config_cache?.is_screening_call) {
      console.log(`[${reqId}] 🔬 Triggering processScreeningResult for screening call (log=${session.callLogId})`);
      serviceClient.functions.invoke('processScreeningResult', { call_log_id: session.callLogId })
        .then(r => console.log(`[${reqId}] ✅ processScreeningResult result:`, JSON.stringify(r?.data || {}).substring(0, 200)))
        .catch(e => console.error(`[${reqId}] ❌ processScreeningResult FAILED: ${e.message}`));
    }

    // Auto-create or update ServiceProvider + ScreeningCall for inbound screening calls
    const customerTurns = session.transcript.filter(t => t.speaker === 'Customer');
    const customerWords = customerTurns.reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);
    if (currentLog?.direction === 'inbound' && session._isScreeningAgent && transcript.length > 100 && customerWords >= 5) {
      try {
        const callerPhone = currentLog.caller_id || session.callerNumber || '';
        if (callerPhone) {
          const cleanPhone = callerPhone.replace(/\D/g, '').slice(-10);
          // Check if provider already exists
          const existingProviders = await serviceClient.entities.ServiceProvider.filter({ client_id: session.clientId });
          const existingProvider = existingProviders.find(p => p.phone && p.phone.replace(/\D/g, '').slice(-10) === cleanPhone);
          
          if (existingProvider) {
            // UPDATE existing provider with data from this inbound call
            console.log(`[${reqId}] 👤 Found existing ServiceProvider: ${existingProvider.name} (${existingProvider.id}) — updating from inbound call`);
            const updateData = {
              screening_summary: summary || existingProvider.screening_summary || '',
              screening_call_id: session.callLogId,
              screening_score: leadScore || existingProvider.screening_score || 50,
            };
            // Extract details from transcript if Azure OpenAI is available
            if (baseUrl && deployment && apiKey) {
              try {
                const extractRes = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
                  method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    messages: [
                      { role: 'system', content: 'Extract candidate details from this call transcript. Return JSON with: name, category (domestic_help/driver/cook/nanny/security/office_staff/software_engineer/sales/marketing/finance/hr/customer_support/operations/design/data_analyst/management/healthcare/education/legal/custom), skills (array), experience_years (number), expected_salary (number), location, education, languages_spoken (array), availability (immediate/1_week/2_weeks/1_month). Only include fields you can confidently extract.' },
                      { role: 'user', content: transcript }
                    ], max_completion_tokens: 500, response_format: { type: 'json_object' }
                  })
                });
                if (extractRes.ok) {
                  const cd = JSON.parse((await extractRes.json()).choices?.[0]?.message?.content || '{}');
                  if (cd.name && !existingProvider.name?.includes('Unknown')) updateData.name = cd.name;
                  if (cd.skills?.length) updateData.skills = cd.skills;
                  if (cd.experience_years) updateData.experience_years = cd.experience_years;
                  if (cd.expected_salary) updateData.expected_salary = cd.expected_salary;
                  if (cd.location) updateData.location = cd.location;
                  if (cd.education) updateData.education = cd.education;
                  if (cd.languages_spoken?.length) updateData.languages_spoken = cd.languages_spoken;
                  if (cd.availability) updateData.availability = cd.availability;
                  if (cd.category && existingProvider.category === 'custom') updateData.category = cd.category;
                }
              } catch (_) {}
            }
            updateData.screening_status = 'passed';
            updateData.notes = (existingProvider.notes || '') + `\nUpdated from inbound call on ${new Date().toLocaleDateString('en-IN')}`;
            await serviceClient.entities.ServiceProvider.update(existingProvider.id, updateData);
            console.log(`[${reqId}] 👤 Updated ServiceProvider ${existingProvider.name}: score=${updateData.screening_score}`);
            
            // Create ScreeningCall record for screening history
            try {
              const screeningCall = await serviceClient.entities.ScreeningCall.create({
                client_id: session.clientId,
                provider_id: existingProvider.id,
                template_id: existingProvider.screening_template_id || '',
                call_log_id: session.callLogId,
                agent_id: currentLog.agent_id || '',
                status: 'completed',
                transcript,
                screening_score: updateData.screening_score || leadScore || 50,
                ai_summary: summary || '',
                ai_recommendation: leadScore >= 60 ? 'recommend' : 'neutral',
                result: leadScore >= 60 ? 'passed' : (leadScore >= 30 ? 'inconclusive' : 'failed'),
                call_duration: duration,
                attempt_count: 1
              });
              // Update CallLog to reference the screening call
              await serviceClient.entities.CallLog.update(session.callLogId, {
                agent_config_cache: { ...currentLog.agent_config_cache, is_screening_call: true, screening_call_id: screeningCall.id }
              });
              console.log(`[${reqId}] 📋 ScreeningCall created: ${screeningCall.id} for existing provider ${existingProvider.name}`);
            } catch (scErr) { console.error(`[${reqId}] ⚠️ ScreeningCall create failed: ${scErr.message}`); }
          } else {
            // Create new provider
            if (baseUrl && deployment && apiKey) {
              const extractRes = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
                method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  messages: [
                    { role: 'system', content: 'Extract candidate details from this call transcript. Return JSON with: name, phone, category (domestic_help/driver/cook/nanny/security/office_staff/software_engineer/sales/marketing/finance/hr/customer_support/operations/design/data_analyst/management/healthcare/education/legal/custom), skills (array), experience_years (number), expected_salary (number), location, education, languages_spoken (array), availability (immediate/1_week/2_weeks/1_month). Only include fields you can extract from the conversation.' },
                    { role: 'user', content: transcript }
                  ], max_completion_tokens: 500, response_format: { type: 'json_object' }
                })
              });
              if (extractRes.ok) {
                const candidateData = JSON.parse((await extractRes.json()).choices?.[0]?.message?.content || '{}');
                const newProvider = await serviceClient.entities.ServiceProvider.create({
                  client_id: session.clientId,
                  name: candidateData.name || 'Unknown Caller',
                  phone: callerPhone.startsWith('+') ? callerPhone : `+91${cleanPhone}`,
                  category: candidateData.category || 'custom',
                  skills: candidateData.skills || [],
                  experience_years: candidateData.experience_years || null,
                  expected_salary: candidateData.expected_salary || null,
                  location: candidateData.location || null,
                  education: candidateData.education || null,
                  languages_spoken: candidateData.languages_spoken || [],
                  availability: candidateData.availability || 'immediate',
                  screening_status: 'passed',
                  screening_score: leadScore || 50,
                  screening_summary: summary || '',
                  screening_call_id: session.callLogId,
                  source: 'inbound_call',
                  notes: `Auto-created from inbound call on ${new Date().toLocaleDateString('en-IN')}`
                });
                console.log(`[${reqId}] 👤 Auto-created ServiceProvider from inbound call: ${candidateData.name || callerPhone}`);
                // Create ScreeningCall record for screening history
                try {
                  await serviceClient.entities.ScreeningCall.create({
                    client_id: session.clientId,
                    provider_id: newProvider.id,
                    template_id: '',
                    call_log_id: session.callLogId,
                    agent_id: currentLog.agent_id || '',
                    status: 'completed',
                    transcript,
                    screening_score: leadScore || 50,
                    ai_summary: summary || '',
                    ai_recommendation: leadScore >= 60 ? 'recommend' : 'neutral',
                    result: leadScore >= 60 ? 'passed' : (leadScore >= 30 ? 'inconclusive' : 'failed'),
                    call_duration: duration,
                    attempt_count: 1
                  });
                  console.log(`[${reqId}] 📋 ScreeningCall created for new provider ${newProvider.id}`);
                } catch (scErr) { console.error(`[${reqId}] ⚠️ ScreeningCall create failed: ${scErr.message}`); }
              }
            }
          }
        }
      } catch (e) { console.error(`[${reqId}] ⚠️ Auto-create/update provider failed: ${e.message}`); }
    }

    try { serviceClient.cleanup(); } catch (_) {}
  } catch (err) { console.error(`[${reqId}] ❌ Save failed:`, err.message); }
}

// ═══ Main Handler ═══
export default async function streamAudioGemini(c: any) {
  const req = c.req.raw || c.req;
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWebSocket = upgrade === 'websocket';

  console.log(`[${reqId}] 📨 ${req.method} ${req.url}, ws=${isWebSocket}`);

  if (!isWebSocket) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    const protocol = req.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
    return c.json({ data: {
      status: 'ready', version: 'v1.4-gemini-3.1-flash-live',
      wss_url: `${protocol}://${host}/functions/streamAudioGemini`
    } }, 200);
  }

  // ⚠️ LEGACY warn — find Smartflo channels still bound here and migrate them
  console.warn(`[${reqId}] ⚠️ LEGACY streamAudioGemini HIT — migrate the Smartflo channel to a dedicated Gemini stream (streamGeminiPersonal / streamGeminiOutgoing / streamGeminiIncoming).`);
  // ─── Upgrade Smartflo WebSocket ───
  let smartfloSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    smartfloSocket = upgraded.socket;
    response = upgraded.response;
  } catch (err) {
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  // ─── Session State ───
  const session = {
    streamSid: null, callSid: null, callLogId: null, clientId: null,
    transcript: [], startTime: Date.now(),
    systemPrompt: 'You are a professional AI voice assistant.',
    greetingMessage: '', voiceType: 'Puck', // Gemini voice: Puck, Charon, Kore, Fenrir, Aoede
    _saved: false, geminiWs: null, geminiReady: false,
    isSpeaking: false, tools: [], hasShopify: false, hasUniCommerce: false,
    humanTransferNumber: '', enableAutoTransfer: true,
    _geminiReconnectAttempts: 0, _callEnded: false,
    _awaitingOwnerDecision: false, _ownerDecisionExecuted: false, _ownerName: '',
    _transferInitiated: false, _agentConfigReady: false,
    calleeNumber: '', callerNumber: '',
    _personalMode: null, _personalClientId: null,
    _isTrustedCaller: false, _trustedContactName: '',
    _midCallTgSent: false, _midCallChecking: false,
    _lastUpsampleValue: 0, _lastDownsampleRemainder: [],
    _minimalSetupSent: false,
    _pendingAiText: '', _pendingCustomerText: '',
    _isScreeningAgent: false,
    _kbChunks: [],            // RAG: KB split into searchable chunks, NOT in prompt
    _kbFileUri: '',           // Reference to KB private file — fetched lazily on first search
    _kbLoadPromise: null,     // Dedupe concurrent fetch requests
    _leadId: null,            // For get_call_history tool
    _toolFlags: {},           // Tool gating from slim cache (has_kb, has_shopify, etc.)
    // ── Filler audio (cold-start hider) ──
    _fillerStarted: false,
    _fillerPlaying: false,
    _fillerAborted: false
  };

  // ─── Play filler audio (real-time paced, interruptible) ───
  // Only plays if first real audio hasn't arrived within 800ms (cold-start hider).
  // Streams 20ms chunks every 20ms = real-time pacing → no buffer pile-up in Smartflo.
  // On stop: aborts the loop AND sends 'clear' event so Smartflo flushes any queued filler.
  async function playFillerAudio() {
    if (session._fillerPlaying || session._fillerStarted) return;
    session._fillerStarted = true;
    await new Promise(r => setTimeout(r, 800));
    if (session._fillerAborted || session.isSpeaking || session._callEnded) return;
    if (smartfloSocket.readyState !== WebSocket.OPEN || !session.streamSid) return;

    session._fillerPlaying = true;
    try {
      const filler = await getFillerAudio();
      if (!filler || session._fillerAborted || session.isSpeaking) { session._fillerPlaying = false; return; }
      console.log(`[${reqId}] 🎙️ FILLER playing: ${filler.length} bytes (~${Math.round(filler.length/8000*1000)}ms) at t=${Date.now()-session.startTime}ms`);
      for (let i = 0; i < filler.length; i += 160) {
        if (session._fillerAborted || session.isSpeaking || session._callEnded) break;
        if (smartfloSocket.readyState !== WebSocket.OPEN) break;
        let chunk = filler.slice(i, Math.min(i + 160, filler.length));
        if (chunk.length < 160) {
          const padded = new Uint8Array(160);
          padded.set(chunk); padded.fill(0xFF, chunk.length);
          chunk = padded;
        }
        smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
        await new Promise(r => setTimeout(r, 20));
      }
    } catch (e) { console.error(`[${reqId}] ❌ Filler playback error: ${e.message}`); }
    finally { session._fillerPlaying = false; }
  }

  function stopFiller() {
    const wasPlaying = session._fillerPlaying;
    session._fillerAborted = true;
    if (wasPlaying && smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
      smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
  }

  // ─── Lazy-load KB from private file on first search ───
  // Downloads the KB file, splits into chunks, and caches in session memory.
  // Returns '' if unavailable. Deduped via _kbLoadPromise so concurrent searches share the same fetch.
  async function loadKBLazy() {
    if (session._kbChunks && session._kbChunks.length > 0) return;
    if (!session._kbFileUri) return;
    if (session._kbLoadPromise) { await session._kbLoadPromise; return; }

    session._kbLoadPromise = (async () => {
      const startT = Date.now();
      try {
        
        const appId = Deno.env.get('BASE44_APP_ID');
        const svc = base44;;
        const signed = await svc.integrations.Core.CreateFileSignedUrl({
          file_uri: session._kbFileUri,
          expires_in: 300
        });
        const url = signed?.signed_url;
        if (!url) { console.log(`[${reqId}] ⚠️ KB signed URL missing`); return; }
        const res = await fetch(url);
        if (!res.ok) { console.log(`[${reqId}] ⚠️ KB fetch failed: ${res.status}`); return; }
        const text = await res.text();
        session._kbChunks = splitKBIntoChunks(text);
        console.log(`[${reqId}] 📚 KB lazy-loaded: ${text.length} chars → ${session._kbChunks.length} chunks in ${Date.now()-startT}ms`);
      } catch (e) {
        console.log(`[${reqId}] ⚠️ KB lazy-load error: ${e.message}`);
      }
    })();
    await session._kbLoadPromise;
  }

  // ─── Split KB content into searchable chunks (RAG) ───
  // Each chunk ~400-600 chars, preserves section boundaries for better retrieval
  function splitKBIntoChunks(kbContent) {
    if (!kbContent || kbContent.length < 100) return [];
    const chunks = [];
    // Split by "---" (doc boundary) first, then by paragraphs for long docs
    const docs = kbContent.split(/\n---\n/);
    for (const doc of docs) {
      const trimmed = doc.trim();
      if (!trimmed) continue;
      if (trimmed.length <= 600) {
        chunks.push(trimmed);
      } else {
        // Split long docs by double newline (paragraphs), group to ~500 chars
        const paragraphs = trimmed.split(/\n\n+/);
        let buffer = '';
        for (const p of paragraphs) {
          if ((buffer + '\n\n' + p).length > 600 && buffer) {
            chunks.push(buffer.trim());
            buffer = p;
          } else {
            buffer = buffer ? buffer + '\n\n' + p : p;
          }
        }
        if (buffer.trim()) chunks.push(buffer.trim());
      }
    }
    return chunks.filter(c => c.length >= 30);  // skip tiny fragments
  }

  // ─── RAG: search KB chunks by keyword scoring ───
  // Returns top 3 matching chunks, joined as a single string
  function searchKBChunks(query) {
    if (!session._kbChunks || session._kbChunks.length === 0) return '';
    const keywords = (query || '').toLowerCase()
      .replace(/[^\w\s\u0900-\u097F]/g, ' ')  // keep Hindi + alphanumeric
      .split(/\s+/)
      .filter(w => w.length >= 3);  // skip tiny words
    if (keywords.length === 0) return session._kbChunks.slice(0, 2).join('\n\n---\n\n');
    const scored = session._kbChunks.map(chunk => {
      const lower = chunk.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        // Count occurrences — more hits = more relevant
        const matches = lower.split(kw).length - 1;
        score += matches;
        // Bonus for title/heading matches (lines starting with [ or #)
        if (/^\[.*\]|^#/.test(chunk) && lower.substring(0, 100).includes(kw)) score += 2;
      }
      return { chunk, score };
    });
    const top = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
    if (top.length === 0) {
      // Fallback: return first 2 chunks (better than nothing)
      return session._kbChunks.slice(0, 2).join('\n\n---\n\n');
    }
    return top.map(t => t.chunk).join('\n\n---\n\n');
  }

  // ─── Build Gemini-compatible tool definitions ───
  function buildGeminiTools() {
    const declarations = [];
    // end_call tool — AI uses this to hang up after conversation naturally ends
    declarations.push({
      name: 'end_call',
      description: 'End/disconnect the call. Use this ONLY after the caller has said goodbye, agreed to end, or the conversation has naturally concluded. Say your final goodbye BEFORE calling this tool.',
      parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Brief reason for ending (e.g. conversation_complete, caller_said_bye, message_taken)' } }, required: ['reason'] }
    });
    if (session.humanTransferNumber) {
      declarations.push({
        name: 'transfer_to_human',
        description: 'Transfer the call to a human agent when customer explicitly requests it or is very frustrated.',
        parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Brief reason for the transfer' } }, required: ['reason'] }
      });
    }
    // RAG: knowledge base search tool — enabled via tool_flags.has_kb OR preloaded chunks (backward compat)
    if (session._toolFlags?.has_kb || (session._kbChunks && session._kbChunks.length > 0) || session._kbFileUri) {
      declarations.push({
        name: 'search_knowledge_base',
        description: 'Search the company knowledge base for product info, pricing, features, policies, FAQs, or any specific business details. USE THIS TOOL WHENEVER the customer asks about specific products, prices, features, timelines, policies, or anything company-specific. Do NOT answer from memory — always search first.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Concise search query (2-6 keywords) — what the customer wants to know' }
          },
          required: ['query']
        }
      });
    }
    // Call history tool — lets AI pull detailed past-call context on demand
    if (session._toolFlags?.has_call_history && session._leadId) {
      declarations.push({
        name: 'get_call_history',
        description: 'Fetch detailed history of previous calls with this lead. USE THIS whenever the customer references past conversations, says "as we discussed", "remember the quote", "last time you said", etc. Returns up to 5 previous call summaries and the lead profile.',
        parameters: { type: 'object', properties: {}, required: [] }
      });
    }
    if (session.hasShopify) {
      declarations.push({
        name: 'shopify_lookup',
        description: 'Look up order status, tracking, products, or refunds from the customer Shopify store.',
        parameters: {
          type: 'object',
          properties: {
            lookup_type: { type: 'string', enum: ['order_by_number', 'order_by_phone', 'order_by_email', 'product_search', 'refund_status', 'tracking'], description: 'Type of lookup' },
            query: { type: 'string', description: 'Search query: order number, phone, email, product name, or order ID' }
          }, required: ['lookup_type', 'query']
        }
      });
    }
    if (session.hasUniCommerce) {
      declarations.push({
        name: 'unicommerce_lookup',
        description: 'Look up order status, tracking, or products from the UniCommerce warehouse management system.',
        parameters: {
          type: 'object', properties: {
            lookup_type: { type: 'string', enum: ['order_by_number', 'order_by_phone', 'tracking', 'product_search'], description: 'Type of lookup' },
            query: { type: 'string', description: 'Search query: order code, phone number, or product name' }
          }, required: ['lookup_type', 'query']
        }
      });
    }
    session.tools = declarations;
    return declarations;
  }

  // ─── Execute tool call (same logic as streamAudio) ───
  async function executeToolCall(functionName, args) {
    console.log(`[${reqId}] 🔧 Tool: ${functionName}(${JSON.stringify(args).substring(0, 200)})`);
    let result = { error: `Unknown tool: ${functionName}` };

    // RAG: knowledge base search (lazy-loads KB file on first call)
    if (functionName === 'search_knowledge_base') {
      const query = args.query || '';
      // Load KB from private file on first use (cached in session for subsequent calls)
      if ((!session._kbChunks || session._kbChunks.length === 0) && session._kbFileUri) {
        await loadKBLazy();
      }
      const results = searchKBChunks(query);
      console.log(`[${reqId}] 📚 KB search: "${query.substring(0, 60)}" → ${results.length} chars returned (chunks=${session._kbChunks?.length || 0})`);
      return { results: results || 'No relevant information found in knowledge base.' };
    }

    // Call history tool — fetch past call summaries for this lead
    if (functionName === 'get_call_history') {
      if (!session._leadId) return { error: 'No lead associated with this call' };
      try {
        
        const svc = base44;;
        const res = await svc.functions.invoke('getLeadCallHistory', { lead_id: session._leadId, limit: 5 });
        console.log(`[${reqId}] 📞 Call history fetched: ${res?.data?.call_count || 0} calls`);
        return res?.data || { error: 'Failed to fetch call history' };
      } catch (e) {
        return { error: e.message };
      }
    }

    // end_call tool — disconnect the call
    if (functionName === 'end_call') {
      const reason = args.reason || 'conversation_complete';
      console.log(`[${reqId}] 📴 AI initiated end_call: ${reason}, callSid=${session.callSid}, caller=${session.callerNumber}, callee=${session.calleeNumber}`);
      session.transcript.push({ speaker: 'System', text: `[Call ended by AI. Reason: ${reason}]` });
      result = { success: true, message: 'Call is being disconnected.' };
      // Fire Smartflo hangup IMMEDIATELY (in parallel) — don't wait 2s, don't wait for save.
      // Pass phone numbers so disconnectCall can look up the live call_id from /v1/live_calls.
      import('npm:@base44/sdk@0.8.31').then(({ createClient: cc }) => {
        const svc = cc({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        svc.functions.invoke('disconnectCall', {
          call_sid: session.callSid,
          caller_number: session.callerNumber,
          callee_number: session.calleeNumber
        }).then(r => console.log(`[${reqId}] 📴 disconnectCall result:`, JSON.stringify(r?.data || {}).substring(0, 200)))
          .catch(e => console.error(`[${reqId}] ❌ disconnectCall failed: ${e.message}`));
      });
      // Give final audio 2s to flush, then close WebSockets + save
      setTimeout(() => {
        session._callEnded = true;
        if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        saveCallRecord(session, reqId, duration).then(() => {
          if (smartfloSocket.readyState === WebSocket.OPEN) {
            console.log(`[${reqId}] 📴 Closing Smartflo WebSocket`);
            smartfloSocket.close();
          }
        });
      }, 2000);
      return result;
    }

    if (functionName === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const reason = args.reason || 'customer requested';
        const sfEmail = Deno.env.get('SMARTFLO_EMAIL');
        const sfPassword = Deno.env.get('SMARTFLO_PASSWORD');
        if (sfEmail && sfPassword) {
          const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ email: sfEmail, password: sfPassword })
          });
          const loginData = await loginResp.json();
          const token = loginData.access_token || loginData.token;
          if (token) {
            const transferResp = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
              method: 'POST',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ type: 4, call_id: session.callSid, intercom: String(session.humanTransferNumber) })
            });
            const transferData = await transferResp.json();
            if (transferResp.ok) {
              result = { success: true, message: 'Call is being transferred to a human agent.' };
              session._transferInitiated = true;
              if (session.callLogId) {
                
                const svc = base44;;
                svc.entities.CallLog.update(session.callLogId, { transferred_to: `Human agent (intercom: ${session.humanTransferNumber}, reason: ${reason})` }).catch(() => {});
              }
              session.transcript.push({ speaker: 'System', text: `[Call transferred to human agent. Reason: ${reason}]` });
            } else { result = { error: `Transfer failed: ${transferData.message || transferResp.status}` }; }
          } else { result = { error: 'Smartflo login failed' }; }
        } else { result = { error: 'Transfer not configured' }; }
      } catch (err) { result = { error: err.message }; }
    }

    if (functionName === 'shopify_lookup' && session.clientId) {
      try {
        
        const svc = base44;;
        const integrations = await svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, platform: 'shopify', status: 'active' });
        if (integrations.length > 0) {
          const shop = integrations[0];
          const storeUrl = shop.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const baseUrl = `https://${storeUrl}/admin/api/${shop.api_version || '2024-01'}`;
          const headers = { 'X-Shopify-Access-Token': shop.api_access_token, 'Content-Type': 'application/json' };
          if (args.lookup_type === 'order_by_number') {
            const orderName = args.query.startsWith('#') ? args.query : `#${args.query}`;
            const res = await fetch(`${baseUrl}/orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=3`, { headers });
            if (res.ok) { const data = await res.json(); result = { orders: (data.orders || []).map(o => ({ order_number: o.name, status: o.fulfillment_status || 'unfulfilled', total: `${o.currency} ${o.total_price}`, items: (o.line_items || []).map(li => `${li.title} x${li.quantity}`).join(', ') })) }; }
          } else if (args.lookup_type === 'order_by_phone') {
            const res = await fetch(`${baseUrl}/orders.json?status=any&limit=20`, { headers });
            if (res.ok) { const data = await res.json(); const cleanQ = args.query.replace(/[^0-9]/g, ''); const filtered = (data.orders || []).filter(o => { const ph = (o.customer?.phone || o.phone || '').replace(/[^0-9]/g, ''); return ph.includes(cleanQ); }); result = { orders: filtered.slice(0, 5).map(o => ({ order_number: o.name, status: o.fulfillment_status || 'unfulfilled', total: `${o.currency} ${o.total_price}` })) }; }
          } else { result = { message: `Lookup type ${args.lookup_type} processed` }; }
        } else { result = { error: 'No active Shopify integration' }; }
      } catch (err) { result = { error: err.message }; }
    }

    if (functionName === 'unicommerce_lookup' && session.clientId) {
      try {
        
        const svc = base44;;
        const res = await svc.functions.invoke('unicommerceLookup', { client_id: session.clientId, lookup_type: args.lookup_type, query: args.query });
        result = res.data?.success ? res.data : { error: res.data?.error || 'UniCommerce lookup failed' };
      } catch (err) { result = { error: err.message }; }
    }

    return result;
  }

  function isQuotaCloseEvt(e){if(!e)return false;if(e.code===1011||e.code===1008)return true;const r=(e.reason||'').toLowerCase();return r.includes('quota')||r.includes('resource_exhausted')||r.includes('429')||r.includes('rate limit');}
  function connectGemini() {
    const freeKey = Deno.env.get('GEMINI_API_KEY');
    const paidKey = Deno.env.get('GEMINI_API_KEY_PAID');
    if (!freeKey && !paidKey) { console.error(`[${reqId}] ❌ Missing GEMINI_API_KEY`); return; }
    if (!freeKey) session._usingPaidKey = true;
    const apiKey = session._usingPaidKey ? paidKey : freeKey;
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    console.log(`[${reqId}] 🔌 Connecting to Gemini Live API (${session._usingPaidKey ? 'PAID' : 'FREE'} key)...`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${reqId}] ✅ Gemini WebSocket connected`);
      session._geminiReconnectAttempts = 0;
      if (session._agentConfigReady) {
        // Config already loaded — send full setup with correct voice
        sendGeminiSetup();
      }
      // Otherwise wait — voice is locked at setup time in Gemini Live,
      // so we must wait for agent config to know the correct voice before sending setup.
    };

    ws.onmessage = async (event) => {
      try {
        let text;
        if (typeof event.data === 'string') {
          text = event.data;
        } else if (event.data instanceof Blob) {
          text = await event.data.text();
        } else {
          text = new TextDecoder().decode(event.data);
        }
        const msg = JSON.parse(text);
        handleGeminiMessage(msg);
      } catch (err) { console.error(`[${reqId}] ❌ Gemini parse error: ${err.message}`); }
    };

    ws.onclose = (event) => {
      console.log(`[${reqId}] 🔴 Gemini closed: code=${event.code}, reason=${event.reason || 'none'}`);
      session.geminiReady = false;
      const MAX_RECONNECT = 3;
      if (!session._callEnded && session._geminiReconnectAttempts < MAX_RECONNECT) {
        session._geminiReconnectAttempts++;
        const delay = session._geminiReconnectAttempts * 1500;
        console.log(`[${reqId}] 🔄 Reconnecting Gemini (${session._geminiReconnectAttempts}/${MAX_RECONNECT}) in ${delay}ms`);
        setTimeout(() => { if (!session._callEnded) connectGemini(); }, delay);
      }
    };

    ws.onerror = () => { console.error(`[${reqId}] ❌ Gemini WebSocket error`); };
    session.geminiWs = ws;
  }

  // ─── Send full Gemini setup (config) message ───
  // Uses the official BidiGenerateContentSetup format from Google's Live API docs
  function sendGeminiSetup() {
    const tools = buildGeminiTools();
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}.\n`;

    let transferInstructions = '';
    if (session.humanTransferNumber && session.enableAutoTransfer) {
      transferInstructions = `\n\n--- HUMAN AGENT TRANSFER ---\nYou can transfer this call using the transfer_to_human tool when customer explicitly asks to speak to a human or is very frustrated.`;
    }

    const noiseRules = '\nAUDIO RULES: ONLY respond to the PRIMARY speaker. IGNORE background noise. If unclear, ask them to repeat.';
    const identityLock = '\n\n--- IDENTITY LOCK (ABSOLUTE — HIGHEST PRIORITY) ---\nYour name, company, and role are FIXED by the system prompt above. They NEVER change during the call.\n- If knowledge base search results mention ANY other company name, brand, or agent name — IGNORE those names. Use ONLY the identity in your system prompt.\n- When the caller asks "who are you?", "kaun bol rahe ho?", "which company?", ALWAYS answer with the EXACT same name/company you used in your greeting. Never improvise a different one.\n- Do NOT invent, switch, or blend identities mid-call. One call = one identity.';
    const endCallRules = '\n\n--- CALL ENDING (CRITICAL — MUST FOLLOW) ---\nYou MUST call the `end_call` tool to disconnect the call in these situations:\n1. Caller says goodbye: "bye", "bye bye", "thank you bye", "ok bye", "goodbye", "alright thanks", "accha theek hai", "namaste", "dhanyavaad", "chalo bye", "ok then", "phir milte hain"\n2. Caller confirms an appointment/callback and there is nothing more to discuss ("ok", "theek hai", "done", "sure")\n3. You have finished taking a message or voicemail\n4. Caller explicitly says: "end the call", "disconnect", "hang up", "call kaat do"\n5. Conversation has naturally concluded and there are no more open questions\n\nWORKFLOW (MANDATORY):\n- Step 1: Say your final goodbye line (e.g. "Thank you for your time. Have a great day! Goodbye.")\n- Step 2: IMMEDIATELY call the `end_call` tool with a brief reason\n- DO NOT wait for the caller to say anything else\n- DO NOT ask "is there anything else?" after they have already said goodbye\n- DO NOT stay silent hoping the caller hangs up — YOU must hang up\n\nIf a customer has confirmed an appointment and said "ok" — the call is DONE. End it.';
    const fullPrompt = timeInjection + session.systemPrompt + noiseRules + identityLock + transferInstructions + endCallRules;

    // Gemini 3.1 Flash Live — raw WebSocket uses "setup" wrapper (BidiGenerateContentSetup)
    // with nested generationConfig. SDK guides show "config" but that's an SDK abstraction.
    // Docs: https://ai.google.dev/api/live#bidigeneratecontentsetup
    const setupMsg = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: session.voiceType }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: fullPrompt }]
        },
        // ── VAD TUNING FOR NOISY PHONE ENVIRONMENTS ────────────────────────────────
        // START_SENSITIVITY_LOW: requires actual human speech energy to trigger,
        // not ambient noise (air conditioning, TV, traffic, background voices).
        // HIGH sensitivity was the root cause of agent silence: any audio triggered
        // barge-in → agent audio cleared → Gemini waited forever for real input.
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            silenceDurationMs: 600,
            prefixPaddingMs: 120
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };

    if (tools.length > 0) {
      setupMsg.setup.tools = [{ functionDeclarations: tools }];
    }

    sendToGemini(setupMsg);
    console.log(`[${reqId}] 📤 Gemini setup sent: tools=${tools.length}, voice=${session.voiceType}, prompt=${fullPrompt.length} chars`);
  }

  // ─── Handle messages FROM Gemini ───
  function handleGeminiMessage(msg) {
    // Setup complete — server responds with "setupComplete" after receiving config
    // v1beta uses "setupComplete", log all keys for debug
    if (msg.setupComplete !== undefined) {
      console.log(`[${reqId}] ✅ Gemini session ready (setupComplete), configReady=${session._agentConfigReady}`);
      session.geminiReady = true;
      // If config is already loaded, trigger greeting immediately
      // Otherwise greeting will be triggered when config finishes loading
      if (session._agentConfigReady) {
        triggerGreeting();
      }
      return;
    }

    // Server content (audio + text + transcription can coexist in same message)
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Model turn — audio/text parts
      if (sc.modelTurn && sc.modelTurn.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData && part.inlineData.mimeType?.includes('audio')) {
            if (!session._firstAudioLogged) {
              session._firstAudioLogged = true;
              const ttft = session._greetingSentAt ? Date.now() - session._greetingSentAt : -1;
              const totalCall = Date.now() - session.startTime;
              console.log(`[${reqId}] 🎵 FIRST AUDIO: ttft=${ttft}ms, totalFromCallStart=${totalCall}ms, promptSize=${session.systemPrompt.length}ch`);
            }
            // Stop filler the moment real Gemini audio arrives
            stopFiller();
            session.isSpeaking = true;
            const mulawBytes = base64PCM16_24kToMulaw(part.inlineData.data, session);
            if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
              sendMulawToSmartflo(mulawBytes);
            }
          }
          // Ignore modelTurn text parts — we use outputTranscription instead for clean full text
        }
      }

      // Input transcription — accumulate chunks, flush on turn boundary
      if (sc.inputTranscription) {
        const text = (sc.inputTranscription.text || '').trim();
        if (text) {
          session._pendingCustomerText += (session._pendingCustomerText ? ' ' : '') + text;
        }
      }

      // Output transcription — accumulate chunks, flush on turnComplete
      if (sc.outputTranscription) {
        const text = (sc.outputTranscription.text || '').trim();
        if (text) {
          session._pendingAiText += (session._pendingAiText ? ' ' : '') + text;
        }
      }

      // Turn complete — flush accumulated transcription as single entries
      if (sc.turnComplete) {
        session.isSpeaking = false;
        // Flush any pending customer text (input transcription sometimes arrives before turnComplete)
        if (session._pendingCustomerText) {
          const custText = session._pendingCustomerText.trim();
          console.log(`[${reqId}] 🗣️ Customer: "${custText.substring(0, 200)}"`);
          session.transcript.push({ speaker: 'Customer', text: custText });
          session._pendingCustomerText = '';
          // Mid-call Telegram check for personal accounts — ONLY when owner is reachable.
          // If DND is on or owner not connected, AI is in message-taking mode and should not
          // try to ping the owner (no one is going to respond).
          // - Unknown caller: greet → name → reason → hold (need ≥2 customer turns for name+reason)
          // - Trusted caller: greet → reason → hold (≥1 customer turn is enough — name already known)
          if (session._personalMode && session._personalClientId && session._ownerReachable && !session._midCallTgSent && !session._midCallChecking) {
            const custCount = session.transcript.filter(t => t.speaker === 'Customer').length;
            const minTurns = session._isTrustedCaller ? 1 : 2;
            if (custCount >= minTurns) checkCallerInfoAndNotify();
          }
          // Live transcript streaming to Telegram
          if (session._personalMode && session._personalClientId && session._midCallTgSent) {
            const custCount = session.transcript.filter(t => t.speaker === 'Customer').length;
            if (custCount % 2 === 0) sendLiveTranscriptUpdate();
          }
        }
        // Flush pending AI text
        if (session._pendingAiText) {
          const aiText = session._pendingAiText.trim();
          console.log(`[${reqId}] 🤖 AI: "${aiText.substring(0, 200)}"`);
          session.transcript.push({ speaker: 'AI', text: aiText });
          session._pendingAiText = '';
        }
      }

      // Interrupted — flush any partial text before clearing
      if (sc.interrupted) {
        // User started speaking — stop filler too
        stopFiller();
        session.isSpeaking = false;
        if (session._pendingAiText) {
          const aiText = session._pendingAiText.trim();
          if (aiText) {
            console.log(`[${reqId}] 🤖 AI (interrupted): "${aiText.substring(0, 200)}"`);
            session.transcript.push({ speaker: 'AI', text: aiText });
          }
          session._pendingAiText = '';
        }
        if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
          smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
        }
      }
      return;
    }

    // Tool call
    if (msg.toolCall) {
      const functionCalls = msg.toolCall.functionCalls || [];
      console.log(`[${reqId}] 🔧 Gemini tool calls: ${functionCalls.length}`);
      handleToolCalls(functionCalls);
      return;
    }

    // Silently ignore sessionResumptionUpdate, goAway, usageMetadata — they fire constantly and don't need handling
    // Only log truly unknown message types for debugging
    if (msg.sessionResumptionUpdate || msg.goAway || msg.usageMetadata) return;
    const knownKeys = ['setupComplete', 'serverContent', 'toolCall', 'inputTranscription', 'outputTranscription', 'sessionResumptionUpdate', 'goAway', 'usageMetadata'];
    const msgKeys = Object.keys(msg);
    const unknownKeys = msgKeys.filter(k => !knownKeys.includes(k));
    if (unknownKeys.length > 0) {
      console.log(`[${reqId}] 📩 Gemini msg keys: ${msgKeys.join(', ')}, data: ${JSON.stringify(msg).substring(0, 300)}`);
    }
  }

  // ─── Handle Gemini tool calls ───
  async function handleToolCalls(functionCalls) {
    const responses = [];
    for (const fc of functionCalls) {
      const result = await executeToolCall(fc.name, fc.args || {});
      responses.push({ id: fc.id, name: fc.name, response: result });
    }
    sendToGemini({
      toolResponse: { functionResponses: responses }
    });
  }

  // ─── Trigger greeting ───
  // Optimized for minimum TTFT: use the shortest possible trigger so Gemini doesn't
  // "think" about composing the greeting — it just speaks.
  function triggerGreeting() {
    const greeting = session.greetingMessage || '';
    const tElapsed = Date.now() - session.startTime;
    if (greeting) {
      console.log(`[${reqId}] 🎙️ Greeting trigger at t=${tElapsed}ms (promptSize=${session.systemPrompt.length}ch, greetingLen=${greeting.length})`);
      session.transcript.push({ speaker: 'AI', text: greeting });
      // Ultra-minimal trigger — the shorter the instruction, the faster Gemini starts speaking.
      // Using "Say:" (2 chars) lets Gemini skip "thinking" and begin TTS immediately.
      sendToGemini({
        realtimeInput: { text: `Say: ${greeting}` }
      });
    } else {
      console.log(`[${reqId}] 🎙️ Greeting trigger (no custom) at t=${tElapsed}ms (promptSize=${session.systemPrompt.length}ch)`);
      sendToGemini({
        realtimeInput: { text: 'Greet briefly.' }
      });
    }
    // Log when first audio arrives
    session._greetingSentAt = Date.now();
  }

  // ─── Send to Gemini ───
  function sendToGemini(msg) {
    if (session.geminiWs && session.geminiWs.readyState === WebSocket.OPEN) {
      session.geminiWs.send(JSON.stringify(msg));
    }
  }

  // ─── Send mu-law to Smartflo (chunked) ───
  // 0x7F is mu-law silence (zero amplitude) — 0xFF produces clicks/pops at chunk boundaries
  function sendMulawToSmartflo(mulawBytes) {
    const CHUNK_SIZE = 960;
    for (let i = 0; i < mulawBytes.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, mulawBytes.length);
      let chunk = mulawBytes.slice(i, end);
      if (chunk.length % 160 !== 0) {
        const paddedLen = Math.ceil(chunk.length / 160) * 160;
        const padded = new Uint8Array(paddedLen);
        padded.set(chunk);
        padded.fill(0x7F, chunk.length);  // mu-law silence, not 0xFF
        chunk = padded;
      }
      smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
    }
  }

  // ─── Load agent config (optimized for <2s startup) ───
  async function loadAgentConfig() {
    const t0 = Date.now();
    try {
      
      const appId = Deno.env.get('BASE44_APP_ID');
      const svc = base44;;

      let callLog = null;
      const cutoff = new Date(Date.now() - 120000).toISOString();

      // FAST PATH 1: call_sid match (outbound calls — cache is pre-built by initiateCall)
      if (session.callSid) {
        try {
          const logs = await svc.entities.CallLog.filter({ call_sid: session.callSid });
          if (logs.length > 0) { callLog = logs[0]; console.log(`[${reqId}] ⚡ call_sid match in ${Date.now()-t0}ms: ${callLog.id}`); }
        } catch (_) {}
        // Digits-only fallback for Smartflo-generated IDs
        if (!callLog) {
          const digitsOnly = session.callSid.replace(/\D/g, '');
          if (digitsOnly && digitsOnly.length > 5 && digitsOnly !== session.callSid) {
            try { const logs = await svc.entities.CallLog.filter({ call_sid: digitsOnly }); if (logs.length > 0) { callLog = logs[0]; console.log(`[${reqId}] ⚡ digits call_sid match: ${callLog.id}`); } } catch (_) {}
          }
        }
      }

      // FAST PATH 2: Recent unclaimed OUTBOUND call matched STRICTLY by phone.
      // CRITICAL: Must require BOTH callee & caller to match — a single-key match or any "latest unclaimed"
      // will hijack another client's outbound call config on inbound calls.
      if (!callLog) {
        const cleanCallee = session.calleeNumber ? session.calleeNumber.replace(/[^0-9]/g, '').slice(-10) : '';
        const cleanCaller = session.callerNumber ? session.callerNumber.replace(/[^0-9]/g, '').slice(-10) : '';
        if (cleanCallee && cleanCaller) {
          try {
            const [ringing, initiated] = await Promise.all([
              svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 10).catch(() => []),
              svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 10).catch(() => [])
            ]);
            const pickMatch = (list) => {
              const unclaimed = (Array.isArray(list) ? list : []).filter(l => !l.stream_sid && l.created_date >= cutoff && l.direction === 'outbound');
              // STRICT: require BOTH callee + caller (DID) to match this specific outbound call
              return unclaimed.find(l =>
                (l.callee_number||'').replace(/\D/g,'').slice(-10) === cleanCallee &&
                (l.caller_id||'').replace(/\D/g,'').slice(-10) === cleanCaller
              ) || null;
            };
            callLog = pickMatch(ringing) || pickMatch(initiated);
            if (callLog) console.log(`[${reqId}] ⚡ Strict outbound match in ${Date.now()-t0}ms: ${callLog.id}`);
          } catch (_) {}
        }
      }

      // INBOUND PATH: DID→Agent (only when no CallLog found — truly inbound call)
      if (!callLog) {
        const didCandidatesForAgent = [session.calleeNumber, session.callerNumber].filter(Boolean);
        let didAgent = null, didClient = null, resolvedDIDNumber = '';

        for (const candidateNum of didCandidatesForAgent) {
          if (didAgent) break;
          const cleanDID = candidateNum.replace(/[^0-9]/g, '').slice(-10);
          if (!cleanDID) continue;

          // Check DID entity table first
          const allDIDs = await svc.entities.DID.list('-created_date', 200);
          const matchedDID = allDIDs.find(d => (d.number || '').replace(/\D/g, '').slice(-10) === cleanDID);
          if (matchedDID?.agent_id) {
            const [agentRes, clientRes] = await Promise.all([
              svc.entities.Agent.get(matchedDID.agent_id).catch(() => null),
              matchedDID.client_id ? svc.entities.Client.get(matchedDID.client_id).catch(() => null) : Promise.resolve(null)
            ]);
            if (agentRes) { didAgent = agentRes; didClient = clientRes; resolvedDIDNumber = candidateNum; break; }
          }

          // Fallback: check Agent.assigned_dids (for demo/trial agents without DID entity records)
          if (!didAgent) {
            const allAgents = await svc.entities.Agent.list('-created_date', 100);
            didAgent = allAgents.find(a => { const dids = a.assigned_dids || (a.assigned_did ? [a.assigned_did] : []); return dids.some(d => (d || '').replace(/\D/g, '').slice(-10) === cleanDID); });
            if (didAgent) {
              resolvedDIDNumber = candidateNum;
              if (!didClient && didAgent.client_id) { try { didClient = await svc.entities.Client.get(didAgent.client_id); } catch (_) {} }
              break;
            }
          }
        }

        if (didAgent) {
          session.clientId = didClient?.id || didAgent.client_id;

          // ── Trial gate (inbound): block if trial expired or call cap reached ──
          if (didClient && (didClient.account_status === 'trial' || didClient.account_status === 'expired')) {
            const _now = new Date();
            const _tEnd = didClient.trial_end_date ? new Date(didClient.trial_end_date) : null;
            const _uUntil = didClient.trial_topup_unlimited_until ? new Date(didClient.trial_topup_unlimited_until) : null;
            const _isUnlimited = _uUntil && _uUntil > _now;
            const _callsUsed = Number(didClient.trial_calls_used || 0);
            const _callLimit = Number(didClient.trial_call_limit ?? 10);
            const _expired = didClient.account_status === 'expired' || (_tEnd && _tEnd <= _now && !_isUnlimited);
            const _capHit = !_isUnlimited && _callsUsed >= _callLimit;
            if (_expired || _capHit) {
              console.log(`[${reqId}] 🚫 Trial gate blocked inbound call: ${_expired ? 'trial_expired' : 'cap_reached'} (client=${didClient.id})`);
              try { smartfloSocket.close(); } catch (_) {}
              session._callEnded = true;
              return;
            }
            if (!_isUnlimited) {
              svc.entities.Client.update(didClient.id, { trial_calls_used: _callsUsed + 1 }).catch(() => {});
            }
          }

          // Apply sync config immediately (no DB)
          if (didAgent.greeting_message) session.greetingMessage = didAgent.greeting_message;
          if (didAgent.human_transfer_number) session.humanTransferNumber = didAgent.human_transfer_number;
          else if (didClient?.account_type === 'personal' && didClient?.phone) session.humanTransferNumber = didClient.phone;
          if (didAgent.enable_auto_transfer === false) session.enableAutoTransfer = false;

          // Map voice — Gemini voices: Puck, Charon, Kore, Fenrir, Aoede
          if (didAgent.persona?.voice_type) {
            const geminiVoices = ['puck', 'charon', 'kore', 'fenrir', 'aoede'];
            const v = didAgent.persona.voice_type.toLowerCase();
            if (geminiVoices.includes(v)) session.voiceType = v.charAt(0).toUpperCase() + v.slice(1);
            else {
              const voiceMap = { 'alloy': 'Puck', 'shimmer': 'Kore', 'echo': 'Charon', 'ash': 'Fenrir', 'coral': 'Aoede', 'sage': 'Kore', 'ballad': 'Aoede', 'verse': 'Puck', 'marin': 'Kore', 'cedar': 'Charon' };
              const azureFemale = ['neerja', 'ananya', 'swara', 'jenny', 'aria', 'sonia', 'ava', 'emma'];
              const lv = v.toLowerCase();
              if (voiceMap[lv]) session.voiceType = voiceMap[lv];
              else if (azureFemale.some(n => lv.includes(n))) session.voiceType = 'Kore';
              else if (lv.includes('neural') || lv.includes('dragon')) session.voiceType = lv.includes('female') ? 'Kore' : 'Charon';
              else session.voiceType = 'Puck';
            }
          }

          // Detect if this is a screening agent
          if (didAgent.system_prompt && (didAgent.system_prompt.toLowerCase().includes('screening') || didAgent.system_prompt.toLowerCase().includes('interview'))) {
            session._isScreeningAgent = true;
          }

          // PARALLELIZE all inbound DB work: KB, Lead match, Marketplace integrations, Personal mode
          const kbIds = didAgent.knowledge_base_ids || [];
          const cleanCaller = session.callerNumber ? session.callerNumber.replace(/\D/g,'').slice(-10) : '';
          const isPersonal = didClient?.account_type === 'personal';

          const [kbDocs, leads, marketplaceInts] = await Promise.all([
            kbIds.length > 0 ? Promise.all(kbIds.map(id => svc.entities.KnowledgeBase.get(id).catch(()=>null))) : Promise.resolve([]),
            cleanCaller && didClient ? svc.entities.Lead.filter({ client_id: didClient.id }).catch(()=>[]) : Promise.resolve([]),
            session.clientId ? svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, status: 'active' }).catch(()=>[]) : Promise.resolve([])
          ]);

          // Assemble KB content
          let kbContent = '';
          (Array.isArray(kbDocs)?kbDocs:[]).filter(Boolean).forEach(d => { if (d.content) kbContent += `[${d.title}]\n${d.content}\n\n---\n\n`; });

          // Match lead by phone
          let callerContext = '';
          if (cleanCaller && Array.isArray(leads)) {
            const ml = leads.find(l=>l.phone&&l.phone.replace(/\D/g,'').slice(-10)===cleanCaller);
            if (ml) {
              session._inboundLeadId = ml.id;
              session._leadId = ml.id;  // enable get_call_history tool for inbound too
              callerContext = `\n\n--- INBOUND - RETURNING LEAD ---\n- Name: ${ml.name || 'Unknown'}\n- Status: ${ml.status || 'new'}\n- Score: ${ml.score || 0}/100`;
              if (ml.sentiment) callerContext += `\n- Sentiment: ${ml.sentiment}`;
              if (ml.qualification_tier) callerContext += `\n- Tier: ${ml.qualification_tier}`;
              callerContext += `\nCRITICAL: Address by name "${ml.name || 'Sir/Madam'}". If customer references past chats, call get_call_history tool.`;
            }
          }

          // RAG: also strip any KB section embedded in the agent's own system_prompt.
          // Only strips explicit "KNOWLEDGE BASE" sections — never cuts behavioral rules.
          let agentPrompt = didAgent.system_prompt || 'You are a helpful AI voice assistant.';
          let extraKB = kbContent;
          const inbKbRegex = /(\n+(?:[-=]{2,}\s*)?KNOWLEDGE BASE[^\n]*\n)([\s\S]*?)(?=\n[-=]{2,}\s*[A-Z]|\n\n[A-Z][A-Z\s]{5,}(?:\(|:|\n)|$)/i;
          const inbKbMatch = agentPrompt.match(inbKbRegex);
          if (inbKbMatch) {
            extraKB += '\n\n---\n\n' + inbKbMatch[2].trim();
            agentPrompt = agentPrompt.replace(inbKbMatch[0], '\n').trim();
            console.log(`[${reqId}] ✂️ Inbound KB section stripped from agent prompt: ${inbKbMatch[2].length} chars → chunks`);
          }

          // HARD 5KB CAP: if agent prompt is still >5KB after KB strip, force overflow into KB chunks.
          // Prevents a misconfigured agent (huge prompt saved via API) from killing TTFT.
          const HARD_CAP = 5000;
          if (agentPrompt.length > HARD_CAP) {
            const overflow = agentPrompt.substring(HARD_CAP);
            agentPrompt = agentPrompt.substring(0, HARD_CAP) + '\n\n[Additional details available via search_knowledge_base tool]';
            extraKB += '\n\n---\n[Agent Prompt Overflow]\n' + overflow;
            console.warn(`[${reqId}] ⚠️ Agent prompt exceeded 5KB cap — ${overflow.length} chars moved to KB chunks. Trim the prompt in the UI for faster responses.`);
          }

          session._kbChunks = splitKBIntoChunks(extraKB);
          // For inbound calls, prefer lazy loading via kb_file_uri if available on the agent
          if (didAgent.kb_file_uri) session._kbFileUri = didAgent.kb_file_uri;
          const hasKBAccess = session._kbChunks.length > 0 || !!session._kbFileUri;
          const kbInstruction = hasKBAccess
            ? `\n\n--- KNOWLEDGE BASE ACCESS ---\nYou have access to a knowledge base via the \`search_knowledge_base\` tool. Whenever the customer asks about products, pricing, features, policies, or any company-specific details — CALL THIS TOOL FIRST with a concise query (2-6 keywords). Do NOT answer from memory for specific facts. After getting results, answer naturally based on them.`
            : '';
          // Set tool flags for inbound calls (enables get_call_history if lead matched)
          session._toolFlags = {
            has_kb: hasKBAccess,
            has_shopify: false,  // set below based on marketplaceInts
            has_unicommerce: false,
            has_call_history: !!session._leadId,
            has_transfer: !!(didAgent.human_transfer_number || (didClient?.account_type === 'personal' && didClient?.phone)),
            has_end_call: true
          };

          // Build system prompt (KB moved to tool — NOT in prompt)
          session.systemPrompt = agentPrompt + callerContext + kbInstruction;
          console.log(`[${reqId}] 📚 RAG: ${session._kbChunks.length} KB chunks indexed, prompt size=${session.systemPrompt.length}ch (was ${(didAgent.system_prompt||'').length + kbContent.length}ch)`);

          // E-commerce integrations (prose kept short — tool descriptions carry the details)
          if (Array.isArray(marketplaceInts)) {
            if (marketplaceInts.some(i => i.platform === 'shopify')) {
              session.hasShopify = true;
              session._toolFlags.has_shopify = true;
              session.systemPrompt += `\n\n[SHOPIFY ACTIVE] Use shopify_lookup tool for real-time order/product data. Never invent statuses.`;
            }
            if (marketplaceInts.some(i => i.platform === 'unicommerce')) {
              session.hasUniCommerce = true;
              session._toolFlags.has_unicommerce = true;
              session.systemPrompt += `\n\n[UNICOMMERCE ACTIVE] Use unicommerce_lookup tool for real-time data.`;
            }
          }

          // Personal mode (awaited — modifies systemPrompt)
          if (isPersonal) {
            await applyPersonalMode(svc, didClient, session.callerNumber);
          }

          // CRITICAL: AWAIT CallLog create — sendMidCallTgButtons needs session.callLogId
          // to attach to inline button callbacks. Without this, Telegram action buttons
          // would be silently dropped (early-return on missing callLogId).
          try {
            const newLog = await svc.entities.CallLog.create({
              client_id: session.clientId, agent_id: didAgent.id, lead_id: session._inboundLeadId || null,
              call_sid: session.callSid || `inbound_${Date.now()}`,
              stream_sid: session.streamSid || null, caller_id: session.callerNumber || '', callee_number: session.calleeNumber,
              direction: 'inbound', status: 'answered', call_start_time: new Date().toISOString(),
              agent_config_cache: {
                agent_name: didAgent.name, system_prompt: session.systemPrompt, persona: didAgent.persona || {},
                knowledge_base_content: kbContent.substring(0, 2000), greeting_message: didAgent.greeting_message || '',
                is_screening_call: session._isScreeningAgent || false
              }
            });
            if (newLog) session.callLogId = newLog.id;
            console.log(`[${reqId}] ✅ CallLog created: ${session.callLogId}`);
          } catch (e) { console.error(`[${reqId}] ⚠️ CallLog create failed: ${e.message}`); }

          // Initial Telegram heads-up — short ping so owner knows a call is being screened
          // (full action buttons come via sendMidCallTgButtons once name+reason are known)
          if (isPersonal && didClient.telegram_connected && didClient.telegram_chat_id && !didClient.dnd_enabled && didClient.owner_notification_channel === 'telegram') {
            const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
            if (tgToken) {
              const nameDisplay = session._trustedContactName || session.callerNumber || 'Unknown';
              fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: didClient.telegram_chat_id, text: `📞 <b>Incoming Call</b>\n\n📱 From: <b>${nameDisplay}</b>\n\n💬 AI is screening — actions will appear shortly...`, parse_mode: 'HTML' }) }).catch(() => {});
            }
          }

          console.log(`[${reqId}] ✅ INBOUND ready in ${Date.now()-t0}ms: Agent="${didAgent.name}", voice=${session.voiceType}, DID=${resolvedDIDNumber}`);
          return;
        }
      }

      if (!callLog) { console.log(`[${reqId}] ⚠️ No call log found in ${Date.now()-t0}ms — default prompt`); return; }

      // Apply config from pre-cached CallLog (fast path for outbound calls)
      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      const cache = callLog.agent_config_cache || {};

      // ═══ NEW SLIM CACHE PATH ═══
      // core_prompt is already ≤1.5KB, KB is referenced by kb_file_uri, flags are explicit.
      // Legacy path (system_prompt without core_prompt) is still handled below for old CallLogs.
      if (cache.core_prompt) {
        session.systemPrompt = cache.core_prompt;
        session._kbFileUri = cache.kb_file_uri || '';
        session._leadId = cache.lead_id || callLog.lead_id || null;
        session._toolFlags = cache.tool_flags || {};
        session.hasShopify = !!cache.tool_flags?.has_shopify;
        session.hasUniCommerce = !!cache.tool_flags?.has_unicommerce;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (cache.is_screening_call) session._isScreeningAgent = true;
        console.log(`[${reqId}] ✅ SLIM cache: prompt=${session.systemPrompt.length}ch, kb_uri=${session._kbFileUri ? 'yes' : 'no'}, lead=${session._leadId ? 'yes' : 'no'}, flags=${JSON.stringify(session._toolFlags)}`);
      }
      // ═══ LEGACY CACHE PATH (backward compat for CallLogs created before slim migration) ═══
      else if (cache.system_prompt) {
        let prompt = cache.system_prompt;
        let kbSource = cache.knowledge_base_content || '';

        const kbHeaderRegex = /(\n+(?:[-=]{2,}\s*)?KNOWLEDGE BASE[^\n]*\n)([\s\S]*?)(?=\n[-=]{2,}\s*[A-Z]|\n\n[A-Z][A-Z\s]{5,}(?:\(|:|\n)|$)/i;
        const kbMatch = prompt.match(kbHeaderRegex);
        if (kbMatch) {
          if (!kbSource || kbSource.length < kbMatch[2].length) kbSource = kbMatch[2].trim();
          prompt = prompt.replace(kbMatch[0], '\n').trim();
        }

        const HARD_CAP = 5000;
        if (prompt.length > HARD_CAP) {
          const overflow = prompt.substring(HARD_CAP);
          prompt = prompt.substring(0, HARD_CAP) + '\n\n[Additional details available via search_knowledge_base tool]';
          kbSource += '\n\n---\n[Prompt Overflow]\n' + overflow;
        }

        session._kbChunks = splitKBIntoChunks(kbSource);
        session._leadId = callLog.lead_id || null;
        const kbInstruction = session._kbChunks.length > 0
          ? `\n\n--- KNOWLEDGE BASE ACCESS ---\nUse the \`search_knowledge_base\` tool for company-specific details.`
          : '';
        session.systemPrompt = prompt + kbInstruction;

        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (session.systemPrompt.includes('SHOPIFY')) session.hasShopify = true;
        if (session.systemPrompt.includes('UNICOMMERCE')) session.hasUniCommerce = true;
        console.log(`[${reqId}] 📚 LEGACY cache: ${session._kbChunks.length} KB chunks, prompt=${session.systemPrompt.length}ch`);
      }

      // Map voice for Gemini
      if (cache?.persona?.voice_type) {
        const geminiVoices = ['puck', 'charon', 'kore', 'fenrir', 'aoede'];
        const v = cache.persona.voice_type.toLowerCase();
        if (geminiVoices.includes(v)) session.voiceType = v.charAt(0).toUpperCase() + v.slice(1);
        else {
          const voiceMap = { 'alloy': 'Puck', 'shimmer': 'Kore', 'echo': 'Charon', 'ash': 'Fenrir', 'coral': 'Aoede', 'sage': 'Kore', 'ballad': 'Aoede', 'verse': 'Puck', 'marin': 'Kore', 'cedar': 'Charon' };
          const azureFemale = ['neerja', 'ananya', 'swara', 'jenny', 'aria', 'sonia', 'ava', 'emma'];
          const lv = v.toLowerCase();
          if (voiceMap[lv]) session.voiceType = voiceMap[lv];
          else if (azureFemale.some(n => lv.includes(n))) session.voiceType = 'Kore';
          else if (lv.includes('neural') || lv.includes('dragon')) session.voiceType = lv.includes('female') ? 'Kore' : 'Charon';
          else session.voiceType = 'Puck';
        }
      }

      console.log(`[${reqId}] ✅ Config ready in ${Date.now()-t0}ms: voice=${session.voiceType}, prompt=${session.systemPrompt.length}ch`);

      // Claim CallLog (fire-and-forget)
      const updateFields = {};
      if (session.streamSid) updateFields.stream_sid = session.streamSid;
      if (session.callSid && callLog.call_sid !== session.callSid) updateFields.call_sid = session.callSid;
      if (Object.keys(updateFields).length > 0) svc.entities.CallLog.update(callLog.id, updateFields).catch(() => {});
    } catch (e) { console.error(`[${reqId}] ❌ Agent config failed: ${e.message}`); }
  }

  // ─── Resolve caller identity. Returns { name, source }. opts: { transcript, baseUrl, deployment, apiKey } for AI fallback. ───
  async function resolveCallerName(svc, clientId, phone, opts) {
    const cp = (phone || '').replace(/\D/g, '').slice(-10);
    try {
      if (cp && clientId) {
        const contacts = await svc.entities.TrustedContact.filter({ client_id: clientId });
        const m = contacts.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === cp);
        if (m?.name) return { name: m.name, source: 'Saved Contact' };
        const leads = await svc.entities.Lead.filter({ client_id: clientId });
        const lm = leads.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === cp);
        if (lm?.name) return { name: lm.name, source: 'Known Contact' };
      }
    } catch (_) {}
    if (opts?.transcript?.length > 30 && opts.baseUrl && opts.deployment && opts.apiKey) {
      try {
        const r = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", { method: 'POST', headers: { 'api-key': opts.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'system', content: 'Extract the caller\'s own name if they stated it. Return JSON {"name":"<name or empty>"}. Do NOT extract assistant or owner name. No guessing.' }, { role: 'user', content: opts.transcript }], max_completion_tokens: 30, response_format: { type: 'json_object' } }) });
        if (r.ok) { const j = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}'); if (j.name && String(j.name).trim()) return { name: String(j.name).trim(), source: 'Said on call' }; }
      } catch (_) {}
    }
    return { name: '', source: '' };
  }

  // ─── Apply personal account mode (screening, trusted contacts, owner status) ───
  async function applyPersonalMode(svc, ownerClient, callerPhone) {
    const aiMode = ownerClient.ai_response_mode || 'screen_all';
    const dndEnabled = ownerClient.dnd_enabled || false;
    const callerClean = (callerPhone || '').replace(/\D/g, '').slice(-10);

    // Owner is "reachable" on Telegram only if: connected, has chat_id, channel=telegram, AND DND is OFF.
    // When DND is ON or owner is not connected, the AI must NEVER tell the caller to hold —
    // there is no human on the other end to give instructions, so the AI would be stuck waiting forever
    // and end up hallucinating answers (e.g. "Sir is in a meeting"). Instead, AI should directly take a
    // message and politely end the call.
    const ownerReachable = !!(
      ownerClient.telegram_connected &&
      ownerClient.telegram_chat_id &&
      ownerClient.owner_notification_channel === 'telegram' &&
      !dndEnabled
    );
    session._ownerReachable = ownerReachable;

    // Fetch TrustedContacts + OwnerStatuses in parallel for speed
    const [trustedContacts, ownerStatuses] = await Promise.all([
      callerClean ? svc.entities.TrustedContact.filter({ client_id: ownerClient.id }).catch(() => []) : Promise.resolve([]),
      svc.entities.OwnerStatus.filter({ client_id: ownerClient.id, is_active: true }).catch(() => [])
    ]);

    let isTrusted = false, trustedName = '', trustedRelationship = '', trustedFamilyRelation = '';
    if (callerClean) {
      const match = trustedContacts.find(tc => tc.phone && tc.phone.replace(/\D/g, '').slice(-10) === callerClean);
      if (match) { isTrusted = true; trustedName = match.name || ''; trustedRelationship = match.relationship || 'other'; trustedFamilyRelation = match.family_relation || ''; }
    }

    const ownerLabel = ownerClient.company_name || 'Sir';
    let pi = '\n\n--- PERSONAL AI ASSISTANT MODE ---';
    if (aiMode === 'block_all') pi += '\nMODE: BLOCK ALL. Politely tell the caller the owner is unavailable. End quickly.';
    else if (aiMode === 'take_messages') pi += `\nMODE: TAKE MESSAGES. Take a message from every caller.`;
    else if (aiMode === 'allow_contacts' && isTrusted) pi += `\nMODE: ALLOW CONTACTS. "${trustedName}" is TRUSTED (${trustedRelationship}). Be warm.`;
    else if (aiMode === 'allow_contacts' && !isTrusted) pi += '\nMODE: ALLOW CONTACTS (unknown). Screen carefully.';
    else if (isTrusted) pi += `\nMODE: SCREEN ALL. Caller "${trustedName}" is a KNOWN TRUSTED CONTACT — do NOT ask for their name. Greet them warmly by name.`;
    else pi += `\nMODE: SCREEN ALL. Classify as family/business/promotional/spam.`;

    // ═══════════════════════════════════════════════════════════════════
    // SCREENING SCRIPT — has TWO modes:
    //  A) Owner reachable on Telegram → collect (name + reason), hold, wait for owner's decision.
    //  B) Owner NOT reachable (DND on / Telegram not connected) → take a message and end the call.
    //     Never tell the caller "main confirm karke aati hoon" because no one is going to confirm.
    // ═══════════════════════════════════════════════════════════════════
    if (!isTrusted && aiMode !== 'block_all') {
      if (ownerReachable) {
        pi += `\n\n--- MANDATORY SCREENING SCRIPT (FOLLOW IN ORDER) ---
You are ${ownerLabel} ji's personal AI assistant. NEVER pretend to be ${ownerLabel} ji.

GENDER & GRAMMAR (CRITICAL):
You are a FEMALE assistant. ALWAYS use feminine Hindi verb forms when referring to yourself:
- "kar rahi hoon" (NOT "kar raha hoon")
- "bol rahi hoon" (NOT "bol raha hoon")
- "aati hoon" (NOT "aata hoon")
- "jaati hoon" (NOT "jaata hoon")
Never use masculine forms (raha/aata/jaata/bola) for yourself.

STEP 1 — GREET (turn 1, your opening message):
"Namaste! Main ${ownerLabel} ji ki personal AI assistant hoon. ${ownerLabel} ji abhi available nahi hain — main aapki call screen kar rahi hoon."

STEP 2 — ASK NAME (turn 2):
"Aap apna naam bata sakte hain please?"
Wait for the caller to answer. Do NOT ask anything else in this turn.

STEP 3 — ASK PURPOSE (turn 3, after you have the name):
"<Name> ji, aap kis silsile mein call kar rahe hain? Kripya batayein ki kya kaam hai."
Wait for the caller to answer. Do NOT skip this step.

STEP 4 — PARK ON HOLD (turn 4, after you have BOTH name AND reason):
Say EXACTLY this and then STOP TALKING:
"Theek hai <Name> ji, ek minute line par rahiye — main ${ownerLabel} ji se confirm karke abhi aati hoon. Kripya hold kariye."

STEP 5 — SILENT WAIT:
After Step 4, STAY SILENT. Do NOT speak again. Do NOT ask more questions.
The owner will receive your information on Telegram and will reply with one of:
"transfer the call" / "tell them I'll call back at <time>" / "take a message" / "end the call".
You will receive an [OWNER INSTRUCTION] system message — ONLY THEN should you speak again and follow that instruction exactly.

If the caller speaks during the silent wait (Step 5), respond briefly:
"Bas ek minute aur, ${ownerLabel} ji se confirm ho raha hai." Then go silent again.

CRITICAL RULES:
- Do NOT promise transfers, callbacks, or anything specific until you receive an [OWNER INSTRUCTION].
- Do NOT make decisions on behalf of ${ownerLabel} ji.
- Do NOT skip any step. Always: greet → name → reason → hold → wait.
- If caller refuses to give name OR reason after 2 polite attempts, politely take a message instead.`;
      } else {
        pi += `\n\n--- MESSAGE-TAKING SCRIPT (OWNER UNREACHABLE — DND OR NOT CONNECTED) ---
You are ${ownerLabel} ji's personal AI assistant. NEVER pretend to be ${ownerLabel} ji.
${ownerLabel} ji is currently NOT reachable for live confirmation — your job is to politely take a message and end the call.

GENDER: You are FEMALE. Use feminine Hindi forms (rahi hoon, aati hoon, leti hoon). Never use masculine forms for yourself.

STEP 1 — GREET (turn 1):
"Namaste! Main ${ownerLabel} ji ki personal AI assistant hoon. ${ownerLabel} ji abhi available nahi hain. Main aapka message le sakti hoon."

STEP 2 — ASK NAME (turn 2):
"Aap apna naam bata sakte hain please?"

STEP 3 — ASK MESSAGE (turn 3, after you have the name):
"<Name> ji, aap apna message bata dijiye — main ${ownerLabel} ji ko de dungi. Wo free hote hi aapko call back karenge."
Listen carefully and acknowledge the message.

STEP 4 — CONFIRM & END (turn 4):
"Theek hai <Name> ji, maine aapka message note kar liya hai. ${ownerLabel} ji ko bata dungi. Dhanyavaad, namaste."
IMMEDIATELY after this, call the end_call tool with reason="message_taken".

ABSOLUTE RULES:
- NEVER say "main confirm karke aati hoon", "ek minute hold kariye", "${ownerLabel} ji se baat kar rahi hoon" — there is no live confirmation possible.
- NEVER promise a transfer or specific callback time.
- NEVER fabricate that ${ownerLabel} ji is "in a meeting" / "driving" / "busy" — you do NOT know.
- If caller insists on speaking to ${ownerLabel} ji, politely repeat: "Abhi unse baat possible nahi hai — main message le leti hoon, wo aapko khud call karenge."
- Keep the call SHORT (under 60 seconds). Take message → confirm → end.`;
      }
    }

    if (isTrusted && ['family', 'friend'].includes(trustedRelationship)) {
      const rel = trustedFamilyRelation || trustedRelationship;
      const greetMap = { wife: 'Bhabhiji', mother: 'Mummy ji', father: 'Papa ji', brother: `${trustedName} Bhaiya`, sister: `${trustedName} Didi`, son: `${trustedName} Beta`, daughter: `${trustedName} Beta`, uncle: 'Uncle ji', aunt: 'Aunty ji', cousin: `${trustedName} ji`, in_law: `${trustedName} ji` };
      const honorific = greetMap[rel] || `${trustedName} ji`;
      if (ownerReachable) {
        pi += `\n\n--- TRUSTED FAMILY/FRIEND CALLER: ${trustedName} (${rel}) — OWNER REACHABLE ---
You are ${ownerLabel} ji's FEMALE personal AI assistant. Use feminine Hindi forms (rahi hoon, aati hoon).

STEP 1 — WARM GREETING (turn 1):
"Namaste ${honorific}! Main ${ownerLabel} ji ki personal assistant hoon. ${ownerLabel} ji abhi available nahi hain — main aapki call le rahi hoon."

STEP 2 — ASK PURPOSE (turn 2, gently):
"${honorific}, koi urgent kaam hai ya main message le lun?"
Wait for their answer.

STEP 3 — PARK ON HOLD (turn 3, after you understand the reason):
Say EXACTLY: "Theek hai ${honorific}, ek minute hold kariye — main ${ownerLabel} ji se confirm karke abhi bataati hoon."
Then STOP TALKING and wait for the [OWNER INSTRUCTION] message.

STEP 4 — SILENT WAIT (CRITICAL):
Do NOT speak again until you receive an [OWNER INSTRUCTION] system message.
Do NOT make up answers like "${ownerLabel} ji free honge" or "wo abhi busy hain" — you do NOT know that.
If the caller speaks during the wait, say: "Bas ek minute aur, ${honorific}, ${ownerLabel} ji se baat ho rahi hai." Then go silent.

ABSOLUTE RULE: NEVER fabricate ${ownerLabel} ji's response, schedule, availability, or message. ALWAYS wait for the [OWNER INSTRUCTION].`;
      } else {
        pi += `\n\n--- TRUSTED FAMILY/FRIEND CALLER: ${trustedName} (${rel}) — OWNER UNREACHABLE (DND/not connected) ---
You are ${ownerLabel} ji's FEMALE personal AI assistant. Use feminine Hindi forms (rahi hoon, aati hoon, leti hoon).
${ownerLabel} ji is currently NOT reachable for live confirmation. Your job is to take a message warmly and end the call.

STEP 1 — WARM GREETING (turn 1):
"Namaste ${honorific}! Main ${ownerLabel} ji ki personal assistant hoon. ${ownerLabel} ji abhi available nahi hain. Aap mujhe bata dijiye, main unhe message pahuncha dungi."

STEP 2 — TAKE MESSAGE (turn 2):
Listen to their message warmly. If they don't have a specific message, say:
"${honorific}, koi message hai ya bas haal-chal poochne ke liye call kiya tha? Jo bhi hai, mujhe bata dijiye main ${ownerLabel} ji ko de dungi."

STEP 3 — CONFIRM & END (turn 3):
"Theek hai ${honorific}, maine note kar liya hai. ${ownerLabel} ji ko bata dungi — wo free hote hi aapko call kar lenge. Dhanyavaad, namaste."
IMMEDIATELY call the end_call tool with reason="message_taken".

ABSOLUTE RULES:
- NEVER say "ek minute hold kariye", "main ${ownerLabel} ji se baat kar rahi hoon", "main confirm karke aati hoon" — owner is NOT reachable.
- NEVER fabricate ${ownerLabel} ji's location, activity, or schedule (no "meeting mein hain", "driving kar rahe hain", etc.).
- If caller insists on speaking to ${ownerLabel} ji, gently repeat: "${honorific}, abhi unse baat nahi ho sakti — main message le leti hoon, wo khud call karenge."
- Keep the call SHORT and warm. Take message → confirm → end.`;
      }
    }
    if (dndEnabled) pi += '\nDND IS ON: Handle silently.';
    pi += '\nClassify in summary as family/business/promotional/spam/unknown.';

    // Owner status — check end_time and auto-deactivate expired ones (already fetched in parallel)
    try {
      const _as = ownerStatuses;
      const now = new Date();
      for (const _s of _as) {
        if (_s.end_time) {
          let endDate = null;
          const isoTest = new Date(_s.end_time);
          if (!isNaN(isoTest.getTime()) && _s.end_time.includes('-')) { endDate = isoTest; }
          else {
            const todayIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const timeParts = _s.end_time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
            if (timeParts) {
              let h = parseInt(timeParts[1]), m = parseInt(timeParts[2]);
              if (timeParts[3]?.toUpperCase() === 'PM' && h < 12) h += 12;
              if (timeParts[3]?.toUpperCase() === 'AM' && h === 12) h = 0;
              todayIST.setHours(h, m, 0, 0);
              endDate = todayIST;
            }
          }
          if (endDate && now > endDate) {
            console.log(`[${reqId}] ⏰ OwnerStatus "${_s.title}" expired (end_time=${_s.end_time}), deactivating`);
            svc.entities.OwnerStatus.update(_s.id, { is_active: false }).catch(() => {});
            continue;
          }
        }
        pi += `\n\n--- OWNER STATUS: ${_s.icon} ${_s.title} ---\nTell callers in Hindi: "${_s.caller_message_hindi}"`;
        break;
      }
    } catch (_) {}

    session.systemPrompt += pi;
    session._personalMode = aiMode;
    session._isTrustedCaller = isTrusted;
    session._trustedContactName = trustedName;
    session._personalClientId = ownerClient.id;
    session._ownerName = ownerClient.company_name || '';
    console.log(`[${reqId}] 🛡️ Personal: mode=${aiMode}, dnd=${dndEnabled}, trusted=${isTrusted}${trustedName ? ' (' + trustedName + ')' : ''}`);
  }

  // ─── Mid-call: check caller info → send Telegram buttons ───
  async function checkCallerInfoAndNotify() {
    session._midCallChecking = true;

    // If caller is a trusted contact, we already know their name — skip LLM name extraction, send buttons immediately
    if (session._isTrustedCaller && session._trustedContactName) {
      session._midCallTgSent = true;
      const bUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, ''), dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT'), ak = Deno.env.get('AZURE_OPENAI_KEY');
      let reason = '';
      if (bUrl && dep && ak) {
        try {
          const convo = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
          const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
            method: 'POST', headers: { 'api-key': ak, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [
              { role: 'system', content: 'Extract the reason for this call in 5-10 words. Return JSON: {"reason":"brief reason"}' },
              { role: 'user', content: convo }
            ], max_completion_tokens: 40, response_format: { type: "json_object" } })
          });
          if (res.ok) {
            const r = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');
            reason = r.reason || '';
          }
        } catch (_) {}
      }
      sendMidCallTgButtons(session._trustedContactName, reason || 'Trusted contact calling');
      return;
    }

    const bUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, ''), dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT'), ak = Deno.env.get('AZURE_OPENAI_KEY');
    if (!bUrl || !dep || !ak) { session._midCallChecking = false; return; }
    try {
      const convo = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
      const res = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
        method: 'POST', headers: { 'api-key': ak, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: 'Extract caller name and reason from this live call. Return JSON: {"caller_name":"name if said, else empty","reason":"why calling, else empty","ready":true/false}. ready=true ONLY when BOTH name AND reason are known.' },
          { role: 'user', content: convo }
        ], max_completion_tokens: 80, response_format: { type: "json_object" } })
      });
      if (!res.ok) { session._midCallChecking = false; return; }
      const r = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');
      if (r.ready && (r.caller_name || r.reason)) {
        session._midCallTgSent = true;
        sendMidCallTgButtons(r.caller_name || '', r.reason || '');
      } else {
        // If we have 3+ customer turns and still not ready, send with whatever we have
        const custTurns = session.transcript.filter(t => t.speaker === 'Customer').length;
        if (custTurns >= 3 && (r.caller_name || r.reason)) {
          session._midCallTgSent = true;
          sendMidCallTgButtons(r.caller_name || '', r.reason || 'Not yet identified');
        } else {
          session._midCallChecking = false;
        }
      }
    } catch (e) { session._midCallChecking = false; }
  }

  async function sendMidCallTgButtons(aiName, aiReason) {
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!tgT) { console.error(`[${reqId}] ⚠️ Mid-call TG: missing TELEGRAM_BOT_TOKEN`); return; }
    if (!session.callLogId) { console.error(`[${reqId}] ⚠️ Mid-call TG: callLogId not set yet — buttons would be unclickable`); return; }
    try {
      const { createClient: cc } = await import('npm:@base44/sdk@0.8.31');
      const svc = cc({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      const cl = await svc.entities.Client.get(session._personalClientId);
      if (!cl?.telegram_connected || !cl?.telegram_chat_id || cl.dnd_enabled || cl.owner_notification_channel !== 'telegram') {
        console.log(`[${reqId}] ⚠️ Mid-call TG skipped: connected=${cl?.telegram_connected}, chat=${!!cl?.telegram_chat_id}, dnd=${cl?.dnd_enabled}, channel=${cl?.owner_notification_channel}`);
        return;
      }
      let callerLabel = '', callerType = '';
      if (session._isTrustedCaller && session._trustedContactName) { callerLabel = session._trustedContactName; callerType = '👤 Saved Contact'; }
      else { const rn = await resolveCallerName(svc, session._personalClientId, session.callerNumber); if (rn?.name) { callerLabel = rn.name; callerType = `📋 ${rn.source}`; } else if (aiName) { callerLabel = aiName; callerType = '🗣️ Said on call'; } }
      callerLabel = callerLabel || session.callerNumber || 'Unknown';
      const clId = session.callLogId;
      const ph = callerLabel !== session.callerNumber && session.callerNumber ? `\n📞 ${session.callerNumber}` : '';
      const tp = callerType ? `\n🏷️ ${callerType}` : '';
      const m = `📞 <b>Live Call — What should I do?</b>\n\n👤 Caller: <b>${callerLabel}</b>${ph}${tp}\n\n📋 Reason: <b>${aiReason || 'Not specified'}</b>\n\n👇 <b>Choose action:</b>`;
      const kb = { inline_keyboard: [[{ text: '📞 Transfer to Me', callback_data: `decision:${clId}:transfer` }, { text: '⏰ Call Back', callback_data: `decision:${clId}:callback` }], [{ text: '📝 Take Message', callback_data: `decision:${clId}:take_message` }, { text: '🚫 Block/End', callback_data: `decision:${clId}:block` }]] };
      const tgRes = await fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: m, parse_mode: 'HTML', reply_markup: kb }) });
      const tgJson = await tgRes.json();
      if (tgJson.ok) {
        console.log(`[${reqId}] ✅ Mid-call TG buttons sent (caller=${callerLabel}, callLogId=${clId})`);
        session._awaitingOwnerDecision = true;
        pollOwnerDecision(svc);
      } else {
        console.error(`[${reqId}] ❌ Mid-call TG failed: ${JSON.stringify(tgJson).substring(0, 300)}`);
      }
    } catch (e) { console.error(`[${reqId}] ⚠️ Mid-call TG error: ${e.message}`); }
  }

  // ─── Poll CallDecision for owner's Telegram response (continuous — handles multiple instructions) ───
  async function pollOwnerDecision(svc) {
    if (!session.callLogId || !session._personalClientId) return;
    let polls = 0;
    let reassurancesSent = 0;
    let fallbackTriggered = false;
    const startedAt = Date.now();
    const iv = setInterval(async () => {
      polls++;
      if (polls > 120 || session._callEnded) { clearInterval(iv); return; }
      try {
        const decs = await svc.entities.CallDecision.filter({ call_log_id: session.callLogId, status: 'pending' });
        const readyDecs = decs.filter(d => d.custom_message !== '__AWAITING_TIME__' && d.custom_message !== '__AWAITING_MESSAGE__');
        if (readyDecs.length > 0) {
          for (const dec of readyDecs) {
            await svc.entities.CallDecision.update(dec.id, { status: 'delivered' });
            executeOwnerDecision(dec);
          }
          clearInterval(iv);  // owner replied — stop reassurance loop
          return;
        }
        // No owner reply yet — send gentle reassurance every ~15s, fallback at 60s
        const elapsed = Date.now() - startedAt;
        if (!fallbackTriggered && elapsed >= 60000) {
          fallbackTriggered = true;
          sendWaitingFallback();
          clearInterval(iv);
        } else if (elapsed >= (reassurancesSent + 1) * 15000 && reassurancesSent < 3) {
          reassurancesSent++;
          sendWaitingReassurance();
        }
      } catch (_) {}
    }, 2000);
  }

  // ─── Reassure the caller while we're still waiting for owner's Telegram reply ───
  function sendWaitingReassurance() {
    const ownerName = session._ownerName || 'Sir';
    const inst = `[WAITING UPDATE] Owner ne abhi tak reply nahi diya. Caller ko gently reassure karo: "Abhi ${ownerName} ji se koi update nahi aaya hai, aap line par rahiye — main phir se pooch rahi hoon." Sirf 1 line bolo, phir wapas chup ho jao.`;
    sendToGemini({ realtimeInput: { text: inst } });
  }

  // ─── After 60s of owner silence — politely take a message and end ───
  function sendWaitingFallback() {
    const ownerName = session._ownerName || 'Sir';
    const inst = `[WAITING TIMEOUT] Owner ne kaafi der se reply nahi diya. Caller ko boliye: "Lagta hai ${ownerName} ji abhi busy hain — wo mujhe bhi jawab nahi de rahe. Maine aapka message unhe pahuncha diya hai. Jab wo free honge to khud hi aapko call kar lenge. Aap thodi der mein phir se try kar sakte hain. Dhanyavaad, namaste." Yeh bolne ke baad end_call tool use karo with reason="owner_unresponsive".`;
    sendToGemini({ realtimeInput: { text: inst } });
  }

  // ─── Send live transcript snippet to Telegram ───
  async function sendLiveTranscriptUpdate() {
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!tgT || !session._personalClientId) return;
    try {
      const { createClient: cc } = await import('npm:@base44/sdk@0.8.31');
      const svc = cc({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      const cl = await svc.entities.Client.get(session._personalClientId);
      if (!cl?.telegram_connected || !cl?.telegram_chat_id || cl.owner_notification_channel !== 'telegram') return;
      // Send last 4 transcript lines
      const recent = session.transcript.slice(-4).map(t => `${t.speaker === 'Customer' ? '🗣️' : '🤖'} <b>${t.speaker}:</b> ${t.text.substring(0, 200)}`).join('\n');
      const msg = `📞 <b>Live Call Update</b>\n\n${recent}\n\n💬 <i>Type any message to instruct the AI</i>`;
      fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: msg, parse_mode: 'HTML' })
      }).catch(() => {});
    } catch (_) {}
  }

  function executeOwnerDecision(dec) {
    const ownerName = session._ownerName || 'Sir';
    let inst = '';
    if (dec.decision === 'transfer') {
      inst = session.humanTransferNumber
        ? `[OWNER INSTRUCTION] ${ownerName} ji ne call transfer karne bola hai. Caller ko boliye: "Sir, ${ownerName} ji aapka call apne paas transfer kar rahe hain." Phir transfer_to_human tool use karo.`
        : `[OWNER INSTRUCTION] ${ownerName} ji aapko jald call back karenge.`;
    } else if (dec.decision === 'callback') {
      const t = dec.callback_time || dec.custom_message || 'kuch der mein';
      inst = `[OWNER INSTRUCTION] ${ownerName} ji ne kaha ki wo ${t} mein call back karenge. Caller ko batao.`;
    } else if (dec.decision === 'take_message') {
      inst = `[OWNER INSTRUCTION] ${ownerName} ji busy hain. Caller ka message lo — naam, purpose, details.`;
    } else if (dec.decision === 'block') {
      inst = `[OWNER INSTRUCTION] Politely end: "${ownerName} ji abhi available nahi hain. Dhanyavaad. Namaste."`;
    } else if (dec.custom_message) {
      inst = `[OWNER INSTRUCTION] ${ownerName} ji ka message: "${dec.custom_message}". Relay naturally.`;
    }
    if (!inst) return;
    console.log(`[${reqId}] 📨 Owner instruction → AI: "${inst.substring(0, 150)}"`);
    // Stop any current AI speech so the new owner instruction takes priority
    if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
      smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    session.isSpeaking = false;
    // Send owner instruction to Gemini via realtimeInput.text
    sendToGemini({
      realtimeInput: {
        text: inst
      }
    });
  }

  // ─── Pre-warm Gemini ───
  connectGemini();

  // ─── Smartflo WebSocket Handlers ───
  smartfloSocket.onopen = () => { console.log(`[${reqId}] 🟢 Smartflo socket opened`); };

  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.event === 'connected') { console.log(`[${reqId}] ✅ Smartflo connected`); return; }

      if (msg.event === 'start') {
        const sd = msg.start || {};
        session.streamSid = sd.streamSid;
        session.callSid = sd.callSid;
        // Smartflo semantics:
        //  - sd.to / sd.customParameters.called_number = DID (your number) — the CALLEE for inbound
        //  - sd.from = the caller (customer's number) for inbound
        //  - sd.customParameters.customer_number = the customer (ambiguous — could be either side)
        // Resolve using the most reliable Smartflo fields: from→caller, to→callee (standard telephony)
        const rawFrom = sd.from || sd.customParameters?.caller_number || sd.customParameters?.from || '';
        const rawTo = sd.to || sd.customParameters?.called_number || sd.customParameters?.did || '';
        const customerNum = sd.customParameters?.customer_number || '';
        session.callerNumber = rawFrom || customerNum || '';
        session.calleeNumber = rawTo || '';
        console.log(`[${reqId}] 📞 START raw: from=${rawFrom}, to=${rawTo}, customer_number=${customerNum}`);
        console.log(`[${reqId}] 📞 START resolved: callee(DID)=${session.calleeNumber}, caller(customer)=${session.callerNumber}`);
        session._lastUpsampleValue = 0; session._lastDownsampleRemainder = [];

        // 🚀 FIRE FILLER AUDIO IMMEDIATELY (don't await) — hides Gemini setup latency
        playFillerAudio();

        loadAgentConfig().then(() => {
          session._agentConfigReady = true;
          console.log(`[${reqId}] 🚀 Agent config ready: voice=${session.voiceType}`);
          if (session.geminiWs && session.geminiWs.readyState === WebSocket.OPEN) {
            if (!session.geminiReady) {
              // Gemini WS connected but no setup sent yet — send full setup with correct voice
              sendGeminiSetup();
            }
            // If geminiReady is already true (reconnect scenario), greeting is triggered from handleGeminiMessage
          }
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        if (!session.geminiReady) return;
        const raw = atob(msg.media.payload);
        const mulawBytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) mulawBytes[i] = raw.charCodeAt(i);

        // Convert mu-law 8kHz → PCM16 16kHz base64 for Gemini
        // Gemini 3.1 Live: realtimeInput.audio with mimeType 'audio/pcm;rate=16000'
        // Docs: https://ai.google.dev/api/live#realtimeinput — rate must be in mimeType for input audio
        const pcm16Base64 = mulawToBase64PCM16_16k(mulawBytes, session);
        sendToGemini({
          realtimeInput: {
            audio: { data: pcm16Base64, mimeType: 'audio/pcm;rate=16000' }
          }
        });
        return;
      }

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Smartflo stop (transferred=${session._transferInitiated})`);
        session._callEnded = true;
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
        await saveCallRecord(session, reqId, duration);
        if (session.callSid && !session._transferInitiated) {
          const { createClient: cc } = await import('npm:@base44/sdk@0.8.31');
          const svc = cc({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
          svc.functions.invoke('disconnectCall', {
            call_sid: session.callSid,
            caller_number: session.callerNumber,
            callee_number: session.calleeNumber
          }).catch(() => {});
        }
        return;
      }
    } catch (err) { console.error(`[${reqId}] ❌ Smartflo msg error: ${err.message}`); }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Smartflo closed, ${duration}s`);
    if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
    if (session.callLogId) await saveCallRecord(session, reqId, duration);
    if (session.callSid && !session._transferInitiated) {
      const { createClient: cc } = await import('npm:@base44/sdk@0.8.31');
      const svc = cc({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      svc.functions.invoke('disconnectCall', {
        call_sid: session.callSid,
        caller_number: session.callerNumber,
        callee_number: session.calleeNumber
      }).catch(() => {});
    }
  };

  smartfloSocket.onerror = () => {
    console.error(`[${reqId}] ❌ Smartflo error`);
    if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
  };

  return response;

};