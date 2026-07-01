import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// streamGeminiIncoming — Business INBOUND calls only (Gemini Live)
// ═══════════════════════════════════════════════════════════════════════
// Phase 2 — handles inbound calls to BUSINESS-account DIDs.
// Personal inbound goes to streamGeminiPersonal. Business outbound goes
// to streamGeminiOutgoing. Smartflo binds each business inbound DID to
// this channel; routing is automatic at the telephony layer.
//
// Inbound flow:
//   1. Resolve DID → Agent → Client (business account)
//   2. Look up matching Lead by caller phone (returning lead vs new)
//   3. Build personalized prompt (lead context + KB tools)
//   4. Create CallLog inbound record
//   5. Stream conversation; saveCallRecord on stop
// ═══════════════════════════════════════════════════════════════════════

// ─── Audio helpers ───
function decodeMulaw(b) {
  const BIAS = 33; let mu = ~b & 0xFF;
  const sign = (mu & 0x80) ? -1 : 1, exp = (mu >> 4) & 0x07, mant = mu & 0x0F;
  let s = ((mant << 3) + BIAS) << exp; s -= BIAS;
  return sign * s;
}
function encodeMulaw(s) {
  const MAX = 32635, BIAS = 33;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s; if (s > MAX) s = MAX;
  s += BIAS; let exp = 7;
  for (; exp > 0; exp--) { if (s & 0x4000) break; s <<= 1; }
  const mant = (s >> 10) & 0x0F;
  return ~(sign | (exp << 4) | mant) & 0xFF;
}
function mulawToBase64PCM16_16k(mulawBytes, session) {
  // 8kHz mu-law → 16kHz PCM16 with PROPER band-limited interpolation (Catmull-Rom).
  // Replaces the crude duplicate+2-tap-average upsampler that injected HF imaging
  // noise and degraded Gemini's transcription. Neighbours carried across batches
  // via session state keep the seam continuous → smooth, low-pass result.
  const n = mulawBytes.length;
  const pcm8k = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm8k[i] = decodeMulaw(mulawBytes[i]);
  const pm2 = session._upPrev2 ?? (pcm8k[0] || 0);
  const pm1 = session._upPrev1 ?? (pcm8k[0] || 0);
  const at = (idx) => (idx < 0 ? (idx === -2 ? pm2 : pm1) : (idx < n ? pcm8k[idx] : pcm8k[n - 1] ?? pm1));
  const pcm16k = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s0 = at(i - 1), s1 = at(i), s2 = at(i + 1), s3 = at(i + 2);
    pcm16k[i * 2] = s1;
    const mid = (-s0 + 9 * s1 + 9 * s2 - s3) / 16;
    pcm16k[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(mid)));
  }
  session._upPrev2 = n >= 2 ? pcm8k[n - 2] : pm1;
  session._upPrev1 = n >= 1 ? pcm8k[n - 1] : pm1;
  if (n > 0) session._lastUpsampleValue = pcm8k[n - 1];
  const buf = new Uint8Array(pcm16k.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < pcm16k.length; i++) view.setInt16(i * 2, pcm16k[i], true);
  return uint8ToBase64(buf);
}
function base64PCM16_24kToMulaw(b64, session) {
  // 3:1 downsample (24kHz → 8kHz) with a GENTLE triangular low-pass [0.25,0.5,0.25]
  // — a smooth anti-alias filter with NO negative side-lobes, so it removes aliasing
  // WITHOUT the ringing/distortion a sharp sinc FIR adds on loud speech.
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const num = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rem = session._lastDownsampleRemainder;
  const all = new Int16Array(rem.length + num);
  for (let i = 0; i < rem.length; i++) all[i] = rem[i];
  for (let i = 0; i < num; i++) all[rem.length + i] = view.getInt16(i * 2, true);
  const total = all.length, dl = Math.floor(total / 3);
  const mulaw = new Uint8Array(dl);
  for (let i = 0; i < dl; i++) {
    const idx = i * 3;
    const f = Math.round(all[idx] * 0.25 + all[idx + 1] * 0.5 + all[idx + 2] * 0.25);
    mulaw[i] = encodeMulaw(Math.max(-32768, Math.min(32767, f)));
  }
  const consumed = dl * 3;
  session._lastDownsampleRemainder = [];
  for (let i = consumed; i < total; i++) session._lastDownsampleRemainder.push(all[i]);
  return mulaw;
}
function uint8ToBase64(bytes) {
  // Chunked btoa — avoids huge string concat that stalls the event loop on every frame
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(bin);
}

// ─── SDK pre-warm + filler ───
let _sdkModulePromise = null;
function getSDKModule() {
  if (!_sdkModulePromise) _sdkModulePromise = import('npm:@base44/sdk@0.8.31');
  return _sdkModulePromise;
}
getSDKModule().catch(() => {});

// Azure Blob URI for filler audio (Phase 3 — moved off Base44 storage to avoid integration credits).
const FILLER_URI = 'azblob://vaani-private/filler/filler_hello_1778132145341.mulaw';
let _fillerCache = null;
let _fillerLoadPromise = null;
async function loadFiller() {
  try {
    const { BlobServiceClient } = await import('npm:@azure/storage-blob@12.17.0');
    const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    if (!conn) return null;
    const path = FILLER_URI.replace('azblob://', '');
    const slash = path.indexOf('/');
    const container = path.substring(0, slash);
    const blobName = path.substring(slash + 1);
    const svc = BlobServiceClient.fromConnectionString(conn);
    const blob = svc.getContainerClient(container).getBlockBlobClient(blobName);
    const buf = await blob.downloadToBuffer();
    return new Uint8Array(buf);
  } catch (_) { return null; }
}
async function getFillerAudio() {
  if (_fillerCache) return _fillerCache;
  if (!_fillerLoadPromise) _fillerLoadPromise = loadFiller();
  _fillerCache = await _fillerLoadPromise;
  return _fillerCache;
}
// NOTE: NO module-load pre-warm — wastes integration credits on cold starts.

// ─── Noise + hallucinated-script filter ───
// Gemini's transcriber hallucinates Korean/Japanese/Chinese/Arabic/Thai/Cyrillic/Hangul
// phrases on silence or noisy Indian-language audio. Drop those entirely so the
// AI never reacts to imaginary foreign speech.
function isNoiseTranscription(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length <= 4 && /^(uh|um|mhm|hmm|eh|oh|ah)\.?$/i.test(t)) return true;
  if (/[\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u0600-\u06FF\u0E00-\u0E7F\u0400-\u04FF]/.test(t)) return true;
  if (!/[a-zA-Z\u0900-\u097F]/.test(t)) return true;
  if (/[¿¡]/.test(t)) return true;
  if (t.length < 80 && /[àâäçéèêëîïôöûùüÿñõãáíóú]/i.test(t)) return true;
  return false;
}

// ─── KB chunking ───
function splitKBIntoChunks(content) {
  if (!content || content.length < 100) return [];
  const chunks = [];
  const docs = content.split(/\n---\n/);
  for (const doc of docs) {
    const t = doc.trim();
    if (!t) continue;
    if (t.length <= 600) chunks.push(t);
    else {
      const paras = t.split(/\n\n+/);
      let buf = '';
      for (const p of paras) {
        if ((buf + '\n\n' + p).length > 600 && buf) { chunks.push(buf.trim()); buf = p; }
        else buf = buf ? buf + '\n\n' + p : p;
      }
      if (buf.trim()) chunks.push(buf.trim());
    }
  }
  return chunks.filter(c => c.length >= 30);
}

// ═══════════════════════════════════════════════════════════════════════
// UNIVERSAL BEHAVIOR PREAMBLE (Phase 3) — shared across all Gemini streams.
// Centralizes language-mirroring, anti-hallucination/KB-first, voice-lock,
// human warmth, gender-by-voice addressing, and call-ending rules so quality
// no longer depends on each client's prompt wording. Keep this LEAN — every
// char is re-processed per turn. NOTE: enableAffectiveDialog is NOT used —
// it only works on native-audio-dialog models and throws 1007 on 3.1-flash-live.
// ═══════════════════════════════════════════════════════════════════════
const GEMINI_FEMALE_VOICES = new Set(['aoede','kore','leda','autonoe','callirrhoe','despina','erinome','laomedeia','pulcherrima','vindemiatrix','achernar','gacrux','sulafat','zephyr']);
// Accent/language lock — fixes "agent speaks US English while set to Indian English".
// persona.language was loaded but never passed to Gemini → defaulted to US accent.
const LANG_LABEL = {
  'en-in': 'Indian English (Indian accent)',
  'hi-in': 'Hindi (natural Indian pronunciation)',
  'en-us': 'US English (American accent)',
  'en-gb': 'British English (UK accent)',
  'bilingual': 'natural Hinglish — mix Hindi + Indian-accent English the way Indians speak',
  'mr-in': 'Marathi (natural Indian pronunciation)',
};
function buildGeminiPreamble({ hasKB, hasTransfer, voiceType, nowIST, persona }) {
  const isFemale = GEMINI_FEMALE_VOICES.has((voiceType || '').toLowerCase());
  const addr = isFemale
    ? `• You have a FEMALE voice. Use feminine Hindi verb forms (kar rahi hoon, bol rahi hoon).`
    : `• You have a MALE voice. Use masculine Hindi verb forms (kar raha hoon, bol raha hoon).`;
  const lang = String(persona?.language || 'en-in').toLowerCase();
  const accent = `• ACCENT/LANGUAGE: Speak in ${LANG_LABEL[lang] || LANG_LABEL['en-in']}. This accent is FIXED — never drift to a US/American accent. Keep your Indian accent even when mirroring the caller's language.`;
  const tone = persona?.tone ? `• TONE: Stay ${persona.tone} throughout.` : '';
  const lines = [
    `[RULES]`,
    accent,
    `• Speak ONLY Hindi (Devanagari/Roman) + English. Marathi OK. NEVER use Korean/Japanese/Chinese/Arabic/Thai/Spanish/Portuguese/French.`,
    `• MIRROR the caller: reply in the SAME language/script they use. If they switch, you switch — but always keep your Indian accent.`,
    tone,
    `• If transcription looks foreign, it is noise — IGNORE it, do NOT respond.`,
    `• Sound warm, natural and human — vary your tone, never robotic or monotone.`,
    `• On unclear audio: ask them to repeat ONCE, then WAIT. Ignore background chatter — respond ONLY to clear directed speech.`,
    `• If you don't fully understand a question, ask ONE short clarifying question and WAIT. NEVER disconnect or end the call just because you didn't understand.`,
    `• Use the caller's name SPARINGLY — at most once or twice in the whole call. Do NOT repeat their name in every sentence.`,
    `• Identity (name/company) is FIXED — never change.`,
    addr,
    hasKB ? `• For any price/product/feature/policy/location fact: CALL search_knowledge_base FIRST. Never guess. Never say "tool/database/AI". If KB has nothing or you can't answer: say "Iske exact details WhatsApp pe bhej deti hoon" and CONTINUE — never hang up just because you don't know an answer.` : '',
    hasTransfer ? `• Customer asks for a human → call transfer_to_human.` : '',
    `• end_call when the OTHER PERSON signals they want to end: bye/thanks/namaste/dhanyavaad, OR Indian hang-up cues like "phone kaat do", "rakh do", "abhi baat nahi karni", "baad mein", "nahi chahiye", "call mat karo". Say a quick polite goodbye, THEN call end_call. Your own goodbye alone doesn't count. On silence → ask next question, never end.`,
    `• Now: ${nowIST} IST.`,
    ``, ``
  ];
  return lines.filter(l => l !== '').join('\n') + '\n';
}

// ─── Disposition → client Blueprint pipeline stage ───
// Map a resolved lead_status → the client's Blueprint pipeline stage key.
// Keyword-matched against ordered Blueprint stages so it works for ANY vertical.
function _leadStatusToStage(leadStatus, blueprint) {
  if (!blueprint || !Array.isArray(blueprint.pipeline_stages) || blueprint.pipeline_stages.length === 0) return null;
  const stages = blueprint.pipeline_stages.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const find = (...pats) => {
    for (const p of pats) {
      const hit = stages.find(s => `${s.key || ''} ${s.label || ''}`.toLowerCase().includes(p));
      if (hit) return hit.key;
    }
    return null;
  };
  switch (leadStatus) {
    case 'converted': return find('won', 'closed', 'convert', 'enrol', 'booked', 'success') || stages[stages.length - 1]?.key || null;
    case 'interested': return find('interest', 'qualif', 'demo', 'meeting', 'site visit', 'proposal', 'negotiat', 'hot');
    case 'callback': case 'voicemail': return find('follow', 'callback', 'nurtur', 'contact');
    case 'contacted': case 'neutral': return find('contact', 'connect', 'engaged', 'nurtur');
    case 'not_interested': case 'do_not_call': return find('lost', 'disqualif', 'drop', 'dead');
    default: return null;
  }
}
// Load the client's active IndustryBlueprint (by blueprint_key or industry/aliases).
async function _resolveBlueprint(svc, clientId) {
  if (!clientId) return null;
  try {
    const c = await svc.entities.Client.get(clientId).catch(() => null);
    if (!c) return null;
    const key = c.blueprint_key || (c.industry ? String(c.industry).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : null);
    if (key) {
      let bps = await svc.entities.IndustryBlueprint.filter({ industry_key: key, status: 'active' }).catch(() => []);
      if (!bps?.length) {
        const raw = String(c.industry || '').trim().toLowerCase();
        const all = await svc.entities.IndustryBlueprint.filter({ status: 'active' }).catch(() => []);
        bps = (all || []).filter(b => (b.aliases || []).some(a => String(a).trim().toLowerCase() === raw));
      }
      return bps?.[0] || null;
    }
  } catch (_) {}
  return null;
}
// Convenience: resolve the pipeline stage key for a disposition in one call.
async function resolvePipelineStage(svc, clientId, leadStatus) {
  const bp = await _resolveBlueprint(svc, clientId);
  return _leadStatusToStage(leadStatus, bp);
}

// ═══════════════════════════════════════════════════════════════════════
// SAVE CALL RECORD — full business analysis + auto-create lead + screening
// ═══════════════════════════════════════════════════════════════════════
async function saveCallRecord(session, reqId, duration) {
  if (!session.callLogId || session._saved) return;
  session._saved = true;
  try {
    if (session._pendingCustomerText) { session.transcript.push({ speaker: 'Customer', text: session._pendingCustomerText.trim() }); session._pendingCustomerText = ''; }
    if (session._pendingAiText) { session.transcript.push({ speaker: 'AI', text: session._pendingAiText.trim() }); session._pendingAiText = ''; }
    const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
    const { createClient } = await getSDKModule();
    const svc = base44;;

    let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const _oi = baseUrl.indexOf('/openai/'); if (_oi > 0) baseUrl = baseUrl.substring(0, _oi);
    const _pi = baseUrl.indexOf('/api/projects'); if (_pi > 0) baseUrl = baseUrl.substring(0, _pi);
    const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

    let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0, intentSignals = [], scoreBreakdown = {}, keyTopics = [], summaryHindi = '';
    if (transcript.trim().length > 30 && baseUrl && deployment && apiKey) {
      try {
        const r = await fetch(`${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`, {
          method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'Expert call analyst. Score 0-100. Respond ONLY in valid JSON.' },
              { role: 'user', content: `Transcript:\n${transcript}\n\nClassify lead_status accurately. Use "voicemail" ONLY when the call hit an answering machine / carrier voicemail — the AI spoke into dead air with NO genuine two-way human conversation. Do NOT use it for a short real conversation.\n\nReturn JSON: {"summary":"2-3 sentences","summary_hindi":"Devanagari","lead_status":"interested|not_interested|callback|voicemail|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":[],"objections":[],"recommended_next_action":"..."}` }
            ], max_completion_tokens: 800, response_format: { type: 'json_object' }
          })
        });
        if (r.ok) {
          const a = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
          summary = a.summary || ''; summaryHindi = a.summary_hindi || '';
          leadStatus = a.lead_status || 'contacted'; sentiment = a.sentiment || 'neutral';
          leadScore = Math.min(100, Math.max(0, a.lead_score || 0));
          intentSignals = a.intent_signals || [];
          scoreBreakdown = { ...(a.score_breakdown || {}), objections: a.objections || [], recommended_next_action: a.recommended_next_action || '', key_topics: a.key_topics || [], summary_hindi: summaryHindi };
          keyTopics = a.key_topics || [];
        }
      } catch (e) { console.error(`[${reqId}] AI err: ${e.message}`); }
    } else { summary = 'Call ended with minimal conversation.'; }

    const custLines = session.transcript.filter(t => t.speaker === 'Customer');
    const custWords = custLines.reduce((a, t) => a + t.text.split(/\s+/).length, 0);
    // Guard against the LLM over-penalising a near-silent call: if the customer
    // barely spoke on a very short call, don't let it be marked negatively —
    // treat as a light "contacted" touch instead.
    if (custWords <= 5 && duration < 30 && (leadStatus === 'do_not_call' || leadStatus === 'not_interested')) {
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
    }
    // Voicemail is now classified by the LLM itself (it's an allowed lead_status),
    // gated on duration to avoid false positives on genuine short conversations.
    if (leadStatus === 'voicemail') {
      sentiment = 'neutral';
      leadScore = Math.max(leadScore, 15);
      console.log(`[${reqId}] 📭 Voicemail classified by LLM (custWords=${custWords}, dur=${duration}s)`);
    }

    let qTier = 'cold', qReason = '';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) { qTier = 'hot'; qReason = `${leadScore}/100, ${sentiment}`; }
    else if (leadScore >= 50) { qTier = 'warm'; qReason = `${leadScore}/100`; }
    else if (leadScore >= 25) { qTier = 'nurture'; qReason = `${leadScore}/100`; }
    else if (['negative', 'very_negative'].includes(sentiment)) qTier = 'disqualified';
    if (leadStatus === 'converted') qTier = 'hot';
    if (leadStatus === 'do_not_call') qTier = 'disqualified';

    const enriched = summary ? `${summary}${summaryHindi ? '\n\n🇮🇳 ' + summaryHindi : ''}\n\n---\nScore: ${leadScore}/100 | ${sentiment} | ${qTier} | ${intentSignals.join(', ')}` : '';

    const currentLog = await svc.entities.CallLog.get(session.callLogId);
    const wasTerminal = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);
    const callLogUpdate = {
      ...(wasTerminal ? {} : { status: 'completed', call_end_time: new Date().toISOString() }),
      transcript: transcript || '', duration,
      lead_status_updated: leadStatus,
      ...(enriched ? { conversation_summary: enriched } : {})
    };
    // ── POSTGRES-PRIMARY WRITE ── transcript + summary survive a Base44 429.
    try { await svc.functions.invoke('pgLeadSync', { call_log: { ...currentLog, ...callLogUpdate } }); }
    catch (pgErr) { console.error(`[${reqId}] ⚠️ PG-primary write failed: ${pgErr.message}`); }
    await svc.entities.CallLog.update(session.callLogId, callLogUpdate);
    console.log(`[${reqId}] 💾 Inbound saved: ${session.callLogId}, score=${leadScore}`);

    // Update Lead
    const leadId = currentLog.lead_id || session._inboundLeadId;
    if (leadId) {
      try {
        const ex = await svc.entities.Lead.get(leadId);
        const merged = [...new Set([...(ex.tags || []), ...keyTopics.slice(0, 10)])];
        const leadUpdate = {
          status: leadStatus, score: leadScore, sentiment, intent_signals: intentSignals, score_breakdown: scoreBreakdown,
          qualification_tier: qTier, qualification_reason: qReason, tags: merged,
          last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString(),
          engagement_count: (ex.engagement_count || 0) + 1,
          notes: `[Score: ${leadScore}/100 | ${sentiment} | ${qTier}] ${summary.substring(0, 300)}`
        };
        // Move the lead along the client's industry pipeline based on the disposition.
        const stageKey = await resolvePipelineStage(svc, session.clientId, leadStatus);
        if (stageKey) leadUpdate.custom_fields = { ...(ex.custom_fields || {}), pipeline_stage: stageKey };
        await svc.entities.Lead.update(leadId, leadUpdate);
      } catch (e) { console.error(`[${reqId}] Lead err: ${e.message}`); }
    }

    setTimeout(() => svc.functions.invoke('fetchCallRecording', { call_log_id: session.callLogId }).catch(() => {}), 20000);
    if (transcript.length > 50) svc.functions.invoke('postCallActionExtractor', { call_log_id: session.callLogId }).catch(() => {});

    // Auto-create Lead from inbound (if no lead matched and there's transcript)
    if (currentLog?.direction === 'inbound' && !currentLog?.lead_id && !session._inboundLeadId && transcript.length > 50 && !session._isScreeningAgent && !currentLog?.agent_config_cache?.is_screening_call) {
      svc.functions.invoke('autoCreateLeadFromInbound', { call_log_id: session.callLogId })
        .then(r => console.log(`[${reqId}] 🆕 autoCreate: ${JSON.stringify(r?.data || {}).substring(0, 150)}`))
        .catch(e => console.error(`[${reqId}] autoCreate err: ${e.message}`));
    }

    // Screening result handoff (inbound screening callback scenario)
    if (currentLog?.agent_config_cache?.is_screening_call) {
      svc.functions.invoke('processScreeningResult', { call_log_id: session.callLogId }).catch(() => {});
    }
  } catch (err) { console.error(`[${reqId}] ❌ Save: ${err.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════
export default async function streamGeminiIncoming(c: any) {
  const req = c.req.raw || c.req;
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWS = upgrade === 'websocket';
  console.log(`[${reqId}] 📨 ${req.method} (incoming-business), ws=${isWS}`);

  if (!isWS) {
    const host = req.headers.get('host') || 'localhost';
    const proto = req.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
    return c.json({ data: {
      status: 'ready', flow: 'business-incoming', version: 'v1.0-gemini-incoming',
      wss_url: `${proto}://${host}/functions/streamGeminiIncoming`
    } }, 200);
  }

  let smartfloSocket, response;
  try { const u = Deno.upgradeWebSocket(req); smartfloSocket = u.socket; response = u.response; }
  catch (_) { return new Response('WS upgrade failed', { status: 500 }); }

  const session = {
    streamSid: null, callSid: null, callLogId: null, clientId: null,
    transcript: [], startTime: Date.now(),
    systemPrompt: 'You are a professional AI voice assistant.',
    greetingMessage: '', voiceType: 'Puck',
    _saved: false, geminiWs: null, geminiReady: false,
    isSpeaking: false, tools: [], hasShopify: false, hasUniCommerce: false,
    humanTransferNumber: '', enableAutoTransfer: true,
    persona: {},  // agent persona (language/accent + tone) — drives the accent lock
    _geminiReconnectAttempts: 0, _callEnded: false,
    _transferInitiated: false, _agentConfigReady: false,
    calleeNumber: '', callerNumber: '',
    _lastUpsampleValue: 0, _lastDownsampleRemainder: [],
    _pendingAiText: '', _pendingCustomerText: '',
    _isScreeningAgent: false,
    _kbChunks: [], _kbFileUri: '', _kbLoadPromise: null,
    _leadId: null, _inboundLeadId: null, _agentId: null, _toolFlags: {},
    _fillerStarted: false, _fillerPlaying: false, _fillerAborted: false,
    _audioBuffer: [],  // P0: queue customer audio during Gemini handshake
    _greeted: false,   // true once greeted — prevents re-greeting when Gemini's
                       // socket recycles mid-call (~8-10 min). Fixes "call restarts".
  };

  let _cachedSvc = null;
  async function getSvc() {
    if (_cachedSvc) return _cachedSvc;
    const { createClient } = await getSDKModule();
    _cachedSvc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    return _cachedSvc;
  }

  // ─── Filler audio ───
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
      for (let i = 0; i < filler.length; i += 160) {
        if (session._fillerAborted || session.isSpeaking || session._callEnded) break;
        if (smartfloSocket.readyState !== WebSocket.OPEN) break;
        let chunk = filler.slice(i, Math.min(i + 160, filler.length));
        if (chunk.length < 160) { const p = new Uint8Array(160); p.set(chunk); p.fill(0xFF, chunk.length); chunk = p; }
        smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
        await new Promise(r => setTimeout(r, 20));
      }
    } catch (_) {} finally { session._fillerPlaying = false; }
  }
  function stopFiller() {
    const wp = session._fillerPlaying;
    session._fillerAborted = true;
    if (wp && smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
      smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
  }

  // ─── KB lazy-load: blob → agent docs → client-wide fallback ───
  async function loadKBLazy() {
    if (session._kbChunks.length > 0) return;
    if (session._kbLoadPromise) { await session._kbLoadPromise; return; }
    session._kbLoadPromise = (async () => {
      console.log(`[${reqId}] 📚 KB load start: uri=${session._kbFileUri ? 'yes' : 'no'}, agentId=${session._agentId || 'null'}, clientId=${session.clientId || 'null'}`);
      // Path A: blob URI
      if (session._kbFileUri && session._kbFileUri.startsWith('azblob://')) {
        try {
          const { BlobServiceClient } = await import('npm:@azure/storage-blob@12.17.0');
          const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
          if (!conn) throw new Error('No Azure conn');
          const path = session._kbFileUri.replace('azblob://', '');
          const slash = path.indexOf('/');
          const container = path.substring(0, slash);
          const blobName = path.substring(slash + 1);
          const svcCli = BlobServiceClient.fromConnectionString(conn);
          const blob = svcCli.getContainerClient(container).getBlockBlobClient(blobName);
          const buf = await blob.downloadToBuffer();
          const text = new TextDecoder().decode(buf);
          session._kbChunks = splitKBIntoChunks(text);
          console.log(`[${reqId}] 📚 KB blob: ${text.length}ch → ${session._kbChunks.length} chunks`);
          if (session._kbChunks.length > 0) return;
        } catch (e) { console.error(`[${reqId}] ⚠️ Blob KB load failed: ${e.message}`); }
      }
      // Path B: Agent.knowledge_base_ids
      if (session._agentId) {
        try {
          const svc = await getSvc();
          const ag = await svc.entities.Agent.get(session._agentId);
          const kbIds = ag?.knowledge_base_ids || [];
          console.log(`[${reqId}] 📚 Agent kb_ids: ${kbIds.length}`);
          if (kbIds.length) {
            const docs = await Promise.all(kbIds.map(id => svc.entities.KnowledgeBase.get(id).catch(() => null)));
            const valid = docs.filter(d => d && d.content);
            let text = '';
            valid.forEach(d => { text += `[${d.title}]\n${d.content}\n\n---\n\n`; });
            console.log(`[${reqId}] 📚 KB docs from agent: ${valid.length}/${kbIds.length}, total=${text.length}ch`);
            if (text.length >= 100) {
              session._kbChunks = splitKBIntoChunks(text);
              console.log(`[${reqId}] 📚 KB DB load (agent): ${session._kbChunks.length} chunks`);
              if (!session._kbFileUri || !session._kbFileUri.startsWith('azblob://')) {
                svc.functions.invoke('uploadKBToStorage', { agent_id: session._agentId }).catch(() => {});
              }
              return;
            }
          }
        } catch (e) { console.error(`[${reqId}] DB KB load err: ${e.message}`); }
      }
      // Path C: client-wide fallback (handles orphan KBs not attached to any agent)
      if (session.clientId) {
        try {
          const svc = await getSvc();
          const clientDocs = await svc.entities.KnowledgeBase.filter({ client_id: session.clientId, status: 'ready' }).catch(() => []);
          console.log(`[${reqId}] 📚 Client-wide KB fallback: ${clientDocs.length} docs`);
          if (clientDocs.length) {
            let text = '';
            clientDocs.forEach(d => { if (d.content) text += `[${d.title}]\n${d.content}\n\n---\n\n`; });
            if (text.length >= 100) {
              session._kbChunks = splitKBIntoChunks(text);
              console.log(`[${reqId}] 📚 KB DB load (client fallback): ${session._kbChunks.length} chunks`);
            }
          }
        } catch (e) { console.error(`[${reqId}] Client KB fallback err: ${e.message}`); }
      }
    })();
    await session._kbLoadPromise;
  }

  function searchKBChunks(query) {
    if (!session._kbChunks?.length) return '';
    const kws = (query || '').toLowerCase().replace(/[^\w\s\u0900-\u097F]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
    if (!kws.length) return session._kbChunks.slice(0, 2).join('\n\n---\n\n');
    const scored = session._kbChunks.map(c => {
      const lo = c.toLowerCase(); let s = 0;
      for (const k of kws) {
        s += lo.split(k).length - 1;
        if (/^\[.*\]|^#/.test(c) && lo.substring(0, 100).includes(k)) s += 2;
      }
      return { c, s };
    });
    const top = scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
    return top.length ? top.map(x => x.c).join('\n\n---\n\n') : session._kbChunks.slice(0, 2).join('\n\n---\n\n');
  }

  function buildGeminiTools() {
    const decls = [
      { name: 'end_call', description: 'End the call after caller said goodbye or conversation concluded.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } }
    ];
    if (session.humanTransferNumber) {
      decls.push({ name: 'transfer_to_human', description: 'Transfer to human when customer requests it.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } });
    }
    // P2: declare KB tool whenever ANY KB source is reachable — flag, blob URI, chunks, OR an agent_id to self-heal from DB
    if (session._toolFlags?.has_kb || session._kbChunks.length > 0 || session._kbFileUri || session._agentId) {
      decls.push({ name: 'search_knowledge_base', description: 'Search KB for product/pricing/feature/policy info. ALWAYS use for company-specific facts.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } });
    }
    if (session._toolFlags?.has_call_history && session._leadId) {
      decls.push({ name: 'get_call_history', description: 'Fetch past calls with this lead.', parameters: { type: 'object', properties: {}, required: [] } });
    }
    if (session.hasShopify) {
      decls.push({ name: 'shopify_lookup', description: 'Look up Shopify orders/products.', parameters: { type: 'object', properties: { lookup_type: { type: 'string', enum: ['order_by_number', 'order_by_phone', 'order_by_email', 'product_search', 'refund_status', 'tracking'] }, query: { type: 'string' } }, required: ['lookup_type', 'query'] } });
    }
    if (session.hasUniCommerce) {
      decls.push({ name: 'unicommerce_lookup', description: 'Look up UniCommerce orders.', parameters: { type: 'object', properties: { lookup_type: { type: 'string', enum: ['order_by_number', 'order_by_phone', 'tracking', 'product_search'] }, query: { type: 'string' } }, required: ['lookup_type', 'query'] } });
    }
    session.tools = decls;
    return decls;
  }

  async function executeToolCall(name, args) {
    console.log(`[${reqId}] 🔧 ${name}`);

    if (name === 'search_knowledge_base') {
      if (!session._kbChunks.length) await loadKBLazy();
      const results = searchKBChunks(args.query || '');
      console.log(`[${reqId}] 📚 KB search: query="${(args.query||'').substring(0,80)}" chunks=${session._kbChunks.length} hit=${results.length>0?'yes':'no'}`);
      return { results: results || 'No relevant info.' };
    }
    if (name === 'get_call_history') {
      if (!session._leadId) return { error: 'No lead' };
      try { const svc = await getSvc(); const r = await svc.functions.invoke('getLeadCallHistory', { lead_id: session._leadId, limit: 5 }); return r?.data || { error: 'fetch failed' }; }
      catch (e) { return { error: e.message }; }
    }
    if (name === 'end_call') {
      // P1: prevent premature end_call — require minimum call duration
      const elapsed = (Date.now() - session.startTime) / 1000;
      if (elapsed < 10) {
        console.log(`[${reqId}] 🛑 end_call rejected — too early (${elapsed.toFixed(1)}s)`);
        return { error: 'Call just started. Continue the conversation naturally.' };
      }
      // P1.5: require explicit goodbye phrase from the CALLER in the last few turns.
      // Without this, Gemini auto-ends mid-conversation on its own questions.
      const recentCustomer = session.transcript
        .filter(t => t.speaker === 'Customer')
        .slice(-3)
        .map(t => (t.text || '').toLowerCase())
        .join(' ');
      const goodbyeRegex = /(bye|goodbye|alvida|namaste|namaskar|dhanyav[aā]d|thank\s*you|thanks|shukriya|theek\s*hai\s*bye|ok\s*bye|fir\s*milte|chalo\s*bye|phone\s*(kaat|kat|rakh)|kaat\s*do|kat\s*do|rakh\s*do|rakhta\s*hoon|rakhti\s*hoon|abhi\s*baat\s*nahi|baat\s*nahi\s*karni|busy\s*hoon|baad\s*mein|nahi\s*chahiye|mat\s*karo\s*call|call\s*mat|pareshan\s*mat|already\s*(le|liya)|le\s*chuka|le\s*chuki|subscription\s*le|बाय|अलविदा|धन्यवाद|शुक्रिया|नमस्ते|नमस्कार|फिर मिलते|फ़ोन\s*(काट|रख)|काट\s*दो|रख\s*दो|अभी\s*बात\s*नहीं|बात\s*नहीं\s*करनी|बाद\s*में|नहीं\s*चाहिए|परेशान\s*मत)/i;
      if (!goodbyeRegex.test(recentCustomer)) {
        console.log(`[${reqId}] 🛑 end_call rejected — caller hasn't signalled end. Last caller: "${recentCustomer.substring(0, 120)}"`);
        return { error: 'Caller has NOT signalled they want to end yet. Continue the conversation. Only call end_call after the caller says bye/thanks/namaste/dhanyavaad OR a hang-up cue like "phone kaat do", "rakh do", "abhi baat nahi karni", "baad mein", "nahi chahiye". Ask your next question.' };
      }
      const reason = args.reason || 'conversation_complete';
      session.transcript.push({ speaker: 'System', text: `[Ended: ${reason}]` });
      getSvc().then(svc => svc.functions.invoke('disconnectCall', { call_sid: session.callSid, caller_number: session.callerNumber, callee_number: session.calleeNumber }).catch(() => {}));
      setTimeout(() => {
        session._callEnded = true;
        if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
        const d = Math.round((Date.now() - session.startTime) / 1000);
        saveCallRecord(session, reqId, d).then(() => { if (smartfloSocket.readyState === WebSocket.OPEN) smartfloSocket.close(); });
      }, 2000);
      return { success: true };
    }
    if (name === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
        if (!sfE || !sfP) return { error: 'Not configured' };
        const lr = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sfE, password: sfP }) });
        const token = (await lr.json()).access_token;
        if (!token) return { error: 'auth failed' };
        const tr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ type: 4, call_id: session.callSid, intercom: String(session.humanTransferNumber) }) });
        if (!tr.ok) return { error: `Transfer failed: ${tr.status}` };
        session._transferInitiated = true;
        session.transcript.push({ speaker: 'System', text: `[Transferred: ${args.reason || ''}]` });
        if (session.callLogId) { const svc = await getSvc(); svc.entities.CallLog.update(session.callLogId, { transferred_to: `Intercom ${session.humanTransferNumber}` }).catch(() => {}); }
        return { success: true };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'shopify_lookup' && session.clientId) {
      try {
        const svc = await getSvc();
        const ints = await svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, platform: 'shopify', status: 'active' });
        if (!ints.length) return { error: 'No Shopify' };
        const sh = ints[0];
        const url = `https://${sh.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}/admin/api/${sh.api_version || '2024-01'}`;
        const h = { 'X-Shopify-Access-Token': sh.api_access_token, 'Content-Type': 'application/json' };
        if (args.lookup_type === 'order_by_number') {
          const oN = args.query.startsWith('#') ? args.query : `#${args.query}`;
          const r = await fetch(`${url}/orders.json?name=${encodeURIComponent(oN)}&status=any&limit=3`, { headers: h });
          if (r.ok) { const d = await r.json(); return { orders: (d.orders || []).map(o => ({ order_number: o.name, status: o.fulfillment_status || 'unfulfilled', total: `${o.currency} ${o.total_price}` })) }; }
        }
        return { message: 'processed' };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'unicommerce_lookup' && session.clientId) {
      try {
        const svc = await getSvc();
        const r = await svc.functions.invoke('unicommerceLookup', { client_id: session.clientId, lookup_type: args.lookup_type, query: args.query });
        return r.data?.success ? r.data : { error: r.data?.error || 'failed' };
      } catch (e) { return { error: e.message }; }
    }
    return { error: `Unknown: ${name}` };
  }

  function isQuotaCloseEvt(e) {
    if (!e) return false;
    if (e.code === 1011 || e.code === 1008) return true;
    const r = (e.reason || '').toLowerCase();
    return r.includes('quota') || r.includes('resource_exhausted') || r.includes('429') || r.includes('rate limit');
  }
  function connectGemini() {
    const freeKey = Deno.env.get('GEMINI_API_KEY');
    const paidKey = Deno.env.get('GEMINI_API_KEY_PAID');
    if (!freeKey && !paidKey) return;
    if (!freeKey) session._usingPaidKey = true;
    const key = session._usingPaidKey ? paidKey : freeKey;
    console.log(`[${reqId}] 🔑 Gemini key=${session._usingPaidKey ? 'PAID' : 'FREE'}`);
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
    const ws = new WebSocket(wsUrl);
    // Do NOT reset the reconnect counter here — an open that immediately closes
    // (FREE-key quota 1011) is NOT success. We reset it only on setupComplete.
    ws.onopen = () => { if (session._agentConfigReady) sendGeminiSetup(); };
    ws.onmessage = async (e) => {
      try {
        let t;
        if (typeof e.data === 'string') t = e.data;
        else if (e.data instanceof Blob) t = await e.data.text();
        else t = new TextDecoder().decode(e.data);
        handleGeminiMessage(JSON.parse(t));
      } catch (err) { console.error(`[${reqId}] parse: ${err.message}`); }
    };
    ws.onclose = (ev) => {
      session.geminiReady = false;
      console.error(`[${reqId}] ❌ Gemini WS closed: code=${ev?.code}, reason="${ev?.reason || 'none'}", clean=${ev?.wasClean}, attempt=${session._geminiReconnectAttempts || 0}`);
      // Auto-fallback: FREE → PAID on quota close. Trigger whenever we're still on
      // the FREE key and never completed a handshake — even after backoff started.
      if (!session._usingPaidKey && paidKey && isQuotaCloseEvt(ev) && !session._callEnded) {
        session._usingPaidKey = true;
        console.log(`[${reqId}] ⚠️ FREE Gemini key hit quota → switching to PAID key`);
        connectGemini();
        return;
      }
      // Exponential backoff with jitter, capped at 5 attempts and 15s delay.
      // Prevents runaway reconnect storms if Gemini API has an outage.
      if (!session._callEnded && session._geminiReconnectAttempts < 5) {
        session._geminiReconnectAttempts++;
        const base = Math.min(15000, 1000 * Math.pow(2, session._geminiReconnectAttempts - 1));
        const jitter = Math.floor(Math.random() * 500);
        const delay = base + jitter;
        console.log(`[${reqId}] 🔄 Gemini reconnect attempt ${session._geminiReconnectAttempts}/5 in ${delay}ms`);
        setTimeout(() => { if (!session._callEnded) connectGemini(); }, delay);
      } else if (!session._callEnded) {
        console.error(`[${reqId}] ❌ Gemini reconnect exhausted — ending call gracefully`);
        session._callEnded = true;
        const d = Math.round((Date.now() - session.startTime) / 1000);
        saveCallRecord(session, reqId, d).then(() => {
          if (smartfloSocket.readyState === WebSocket.OPEN) smartfloSocket.close();
        });
      }
    };
    ws.onerror = (e) => { console.error(`[${reqId}] ❌ Gemini WS error: ${e?.message || JSON.stringify(e?.error || e) || 'unknown'}`); };
    session.geminiWs = ws;
  }

  function sendToGemini(msg) { if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.send(JSON.stringify(msg)); }

  function sendGeminiSetup() {
    // (preamble builder defined at module scope — see buildGeminiPreamble)
    const tools = buildGeminiTools();
    const hasKB = session._toolFlags?.has_kb || session._kbFileUri || session._kbChunks.length > 0 || !!session._agentId;
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
    // RECONNECT RESUME: if we already greeted, Gemini's socket recycled mid-call
    // (~8-10 min limit). Same phone call is still live — seed the new Gemini brain
    // with the recent conversation + a brief "as I was saying" bridge so it continues
    // seamlessly instead of restarting from the greeting.
    let resumeBlock = '';
    if (session._greeted) {
      const recap = session.transcript
        .filter(t => t.speaker === 'Customer' || t.speaker === 'AI')
        .slice(-20)
        .map(t => `${t.speaker === 'AI' ? 'You' : 'Customer'}: ${t.text}`)
        .join('\n');
      resumeBlock = `[CALL IN PROGRESS — DO NOT GREET]\nThis call is already ongoing. Do NOT introduce yourself or greet again. Open with a brief natural bridge like "Haan ji, jaisa main keh rahi thi..." / "As I was saying..." then CONTINUE seamlessly from where the conversation left off. You CAN reference what was discussed earlier — it is in the transcript below.\n${recap ? `\nConversation so far:\n${recap}\n` : ''}\n`;
    }

    const fullPrompt = resumeBlock + buildGeminiPreamble({
      hasKB,
      hasTransfer: session.humanTransferNumber && session.enableAutoTransfer,
      voiceType: session.voiceType,
      nowIST,
      persona: session.persona
    }) + session.systemPrompt;

    const setup = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceType } } } },
        systemInstruction: { parts: [{ text: fullPrompt }] },
        // ── TURN-TAKING LATENCY FIX ── See streamGeminiOutgoing: tune server-side
        // VAD to reply faster after the caller stops, instead of the slow default.
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            silenceDurationMs: 400,
            prefixPaddingMs: 60
          }
        },
        inputAudioTranscription: {}, outputAudioTranscription: {}
      }
    };
    if (tools.length) {
      setup.setup.tools = [{ functionDeclarations: tools }];
    }
    sendToGemini(setup);
    console.log(`[${reqId}] 📤 Setup: tools=${tools.length}, voice=${session.voiceType}, kb=${hasKB}`);
  }

  function handleGeminiMessage(msg) {
    if (msg.setupComplete !== undefined) {
      session.geminiReady = true;
      session._geminiReconnectAttempts = 0; // handshake succeeded → safe to reset
      // Greet ONLY on the FIRST setup of this call. On a mid-call Gemini reconnect
      // (_greeted already true) the resume block handles continuity — do NOT re-greet.
      if (session._agentConfigReady && !session._greeted) triggerGreeting();
      // FLUSH handshake-buffered caller audio. On INBOUND the caller frequently starts
      // speaking during the ~1-2s Gemini handshake; discarding it made the AI "not
      // listen clearly" at the start. We replay it now (capped) so Gemini hears the
      // opening words. The greeting was already triggered above, so this is the
      // caller's real speech, not hiss.
      if (session._audioBuffer.length) {
        const buffered = session._audioBuffer;
        session._audioBuffer = [];
        for (const b64 of buffered) {
          sendToGemini({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
        }
      }
      return;
    }
    if (msg.serverContent) {
      const sc = msg.serverContent;
      if (sc.modelTurn?.parts) {
        // 3.1-flash-live packs MULTIPLE parts per event (audio + text together).
        // Process EVERY part: audio → Smartflo, text → AI transcript buffer.
        for (const p of sc.modelTurn.parts) {
          if (p.inlineData?.mimeType?.includes('audio')) {
            stopFiller();
            session.isSpeaking = true;
            const m = base64PCM16_24kToMulaw(p.inlineData.data, session);
            if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) sendMulawToSmartflo(m);
          }
          if (p.text) {
            session._pendingAiText += (session._pendingAiText ? ' ' : '') + p.text.trim();
          }
        }
      }
      if (sc.inputTranscription) {
        const t = (sc.inputTranscription.text || '').trim();
        if (t && !isNoiseTranscription(t)) session._pendingCustomerText += (session._pendingCustomerText ? ' ' : '') + t;
      }
      if (sc.outputTranscription) {
        const t = (sc.outputTranscription.text || '').trim();
        if (t) session._pendingAiText += (session._pendingAiText ? ' ' : '') + t;
      }
      if (sc.turnComplete) {
        session.isSpeaking = false;
        // Flush the carried mu-law tail (pad ONLY this final frame) at utterance end.
        if (session._outTail && session._outTail.length) {
          const f = new Uint8Array(160); f.set(session._outTail); f.fill(0x7F, session._outTail.length);
          session._outQueue.push(f); session._outTail = null; startOutPump();
        }
        if (session._pendingCustomerText) {
          const t = session._pendingCustomerText.trim();
          console.log(`[${reqId}] 🗣️ "${t.substring(0, 200)}"`);
          session.transcript.push({ speaker: 'Customer', text: t });
          session._pendingCustomerText = '';
        }
        if (session._pendingAiText) {
          const t = session._pendingAiText.trim();
          console.log(`[${reqId}] 🤖 "${t.substring(0, 200)}"`);
          session.transcript.push({ speaker: 'AI', text: t });
          session._pendingAiText = '';
        }
      }
      if (sc.interrupted) {
        stopFiller();
        session.isSpeaking = false;
        session._outQueue = [];
        session._outTail = null;
        if (session._pendingAiText) {
          const t = session._pendingAiText.trim();
          if (t) session.transcript.push({ speaker: 'AI', text: t });
          session._pendingAiText = '';
        }
        if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
          smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
        }
      }
      return;
    }
    if (msg.toolCall) handleToolCalls(msg.toolCall.functionCalls || []);
  }

  async function handleToolCalls(fcs) {
    const responses = [];
    for (const fc of fcs) {
      const r = await executeToolCall(fc.name, fc.args || {});
      responses.push({ id: fc.id, name: fc.name, response: r });
    }
    sendToGemini({ toolResponse: { functionResponses: responses } });
  }

  function triggerGreeting() {
    if (session._greeted) return;  // guard against re-greeting on reconnect
    session._greeted = true;
    const g = session.greetingMessage || '';
    if (g) {
      session.transcript.push({ speaker: 'AI', text: g });
      sendToGemini({ realtimeInput: { text: `Say: ${g}` } });
    } else {
      sendToGemini({ realtimeInput: { text: 'Greet briefly.' } });
    }
  }

  // ─── PACED mu-law sender to Smartflo (jitter-buffer-safe) ───
  // ROOT-CAUSE FIX for voice breaking + high ROS: bursting every frame floods
  // Smartflo's jitter buffer → dropped frames → choppy voice. We enqueue 20ms
  // (160-byte) frames and drain on a 20ms metronome = real-time pacing.
  session._outQueue = [];
  session._outPumping = false;
  function startOutPump() {
    if (session._outPumping) return;
    session._outPumping = true;
    // Drift-corrected pacing: setTimeout always fires LATE, so draining exactly 1
    // frame per tick feeds Smartflo SLOWER than real-time → jitter buffer starves →
    // underrun gaps = crackle/noise. Track a virtual playback clock and release every
    // 20ms frame whose play-time has passed (catch up if late) → average rate is exact.
    session._nextFrameDue = Date.now();
    const FRAME_MS = 20;
    const pump = () => {
      if (session._callEnded || smartfloSocket.readyState !== WebSocket.OPEN || !session.streamSid) {
        session._outPumping = false;
        return;
      }
      const now = Date.now();
      let sent = 0;
      while (session._outQueue.length > 0 && session._nextFrameDue <= now && sent < 50) {
        const frame = session._outQueue.shift();
        try {
          smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(frame) } }));
        } catch (_) {}
        session._nextFrameDue += FRAME_MS;
        sent++;
      }
      if (session._outQueue.length > 0) {
        const wait = Math.max(0, session._nextFrameDue - Date.now());
        setTimeout(pump, wait);
      } else {
        session._nextFrameDue = Date.now();
        session._outPumping = false;
      }
    };
    pump();
  }
  function sendMulawToSmartflo(mulawBytes) {
    if (smartfloSocket.readyState !== WebSocket.OPEN || !session.streamSid) return;
    // SPEC FIX (Smartflo §3.1): carry the <160-byte remainder to the FRONT of the next
    // part instead of padding it with 0x7F silence (which injected a gap between every
    // part = the breaking/noisy voice). Only true 160-byte real-audio frames are sent.
    const FRAME = 160;
    let buf = session._outTail && session._outTail.length
      ? (() => { const m = new Uint8Array(session._outTail.length + mulawBytes.length); m.set(session._outTail, 0); m.set(mulawBytes, session._outTail.length); return m; })()
      : mulawBytes;
    let i = 0;
    for (; i + FRAME <= buf.length; i += FRAME) session._outQueue.push(buf.slice(i, i + FRAME));
    session._outTail = i < buf.length ? buf.slice(i) : null;
    startOutPump();
  }

  function mapVoice(vRaw, fallback = 'Puck') {
    // All 30 prebuilt Gemini Live voices (case-insensitive match)
    const gem = [
      'achernar','achird','aoede','autonoe','callirrhoe','despina','erinome','kore','laomedeia','leda','pulcherrima','vindemiatrix','zephyr',
      'algenib','algieba','alnilam','charon','enceladus','fenrir','gacrux','iapetus','orus','puck','rasalgethi','sadachbia','sadaltager','schedar','sulafat','umbriel','zubenelgenubi'
    ];
    const v = (vRaw || '').toLowerCase();
    if (gem.includes(v)) return v.charAt(0).toUpperCase() + v.slice(1);
    const map = { 'alloy': 'Puck', 'shimmer': 'Kore', 'echo': 'Charon', 'ash': 'Fenrir', 'coral': 'Aoede' };
    if (map[v]) return map[v];
    return fallback;
  }

  // ─── Inbound config: DID → Agent → Client (BUSINESS only) ───
  async function loadAgentConfig() {
    const t0 = Date.now();
    try {
      const svc = await getSvc();
      const cands = [session.calleeNumber, session.callerNumber].filter(Boolean);
      let didAgent = null, didClient = null, resolvedDID = '';

      for (const cand of cands) {
        if (didAgent) break;
        const cleanDID = cand.replace(/[^0-9]/g, '').slice(-10);
        if (!cleanDID) continue;
        const allDIDs = await svc.entities.DID.list('-created_date', 200);
        const m = allDIDs.find(d => (d.number || '').replace(/\D/g, '').slice(-10) === cleanDID);
        if (m?.agent_id) {
          const [a, c] = await Promise.all([
            svc.entities.Agent.get(m.agent_id).catch(() => null),
            m.client_id ? svc.entities.Client.get(m.client_id).catch(() => null) : Promise.resolve(null)
          ]);
          if (a) { didAgent = a; didClient = c; resolvedDID = cand; break; }
        }
        // Fallback: agent.assigned_dids
        if (!didAgent) {
          const allAgents = await svc.entities.Agent.list('-created_date', 100);
          didAgent = allAgents.find(a => {
            const dids = a.assigned_dids || (a.assigned_did ? [a.assigned_did] : []);
            return dids.some(d => (d || '').replace(/\D/g, '').slice(-10) === cleanDID);
          });
          if (didAgent) {
            resolvedDID = cand;
            if (!didClient && didAgent.client_id) try { didClient = await svc.entities.Client.get(didAgent.client_id); } catch (_) {}
            break;
          }
        }
      }

      if (!didAgent) { console.log(`[${reqId}] ⚠️ No agent matched`); return; }

      // Refuse personal accounts — they belong on streamGeminiPersonal
      if (didClient?.account_type === 'personal') {
        console.log(`[${reqId}] ⚠️ Personal-account DID landed on incoming-business channel — check Smartflo binding`);
        return;
      }

      session.clientId = didClient?.id || didAgent.client_id;

      // Trial gate
      if (didClient && (didClient.account_status === 'trial' || didClient.account_status === 'expired')) {
        const now = new Date();
        const tEnd = didClient.trial_end_date ? new Date(didClient.trial_end_date) : null;
        const uUntil = didClient.trial_topup_unlimited_until ? new Date(didClient.trial_topup_unlimited_until) : null;
        const isUnlim = uUntil && uUntil > now;
        const used = Number(didClient.trial_calls_used || 0);
        const lim = Number(didClient.trial_call_limit ?? 10);
        const expired = didClient.account_status === 'expired' || (tEnd && tEnd <= now && !isUnlim);
        const capHit = !isUnlim && used >= lim;
        if (expired || capHit) {
          console.log(`[${reqId}] 🚫 Trial gate blocked: ${expired ? 'expired' : 'cap'}`);
          try { smartfloSocket.close(); } catch (_) {}
          session._callEnded = true;
          return;
        }
        if (!isUnlim) svc.entities.Client.update(didClient.id, { trial_calls_used: used + 1 }).catch(() => {});
      }

      if (didAgent.greeting_message) session.greetingMessage = didAgent.greeting_message;
      if (didAgent.human_transfer_number) session.humanTransferNumber = didAgent.human_transfer_number;
      if (didAgent.enable_auto_transfer === false) session.enableAutoTransfer = false;

      session.voiceType = mapVoice(didAgent.persona?.voice_type, 'Puck');
      // Capture FULL persona (language/accent + tone) for the accent lock.
      session.persona = didAgent.persona || {};

      if (didAgent.system_prompt && (didAgent.system_prompt.toLowerCase().includes('screening') || didAgent.system_prompt.toLowerCase().includes('interview'))) {
        session._isScreeningAgent = true;
      }

      // Parallel fetch: KB, leads, marketplace integrations
      const kbIds = didAgent.knowledge_base_ids || [];
      const cleanCaller = session.callerNumber?.replace(/\D/g, '').slice(-10) || '';
      const [kbDocs, leads, mInts] = await Promise.all([
        kbIds.length ? Promise.all(kbIds.map(id => svc.entities.KnowledgeBase.get(id).catch(() => null))) : Promise.resolve([]),
        cleanCaller && didClient ? svc.entities.Lead.filter({ client_id: didClient.id }).catch(() => []) : Promise.resolve([]),
        session.clientId ? svc.entities.MarketplaceIntegration.filter({ client_id: session.clientId, status: 'active' }).catch(() => []) : Promise.resolve([])
      ]);

      let kbContent = '';
      (Array.isArray(kbDocs) ? kbDocs : []).filter(Boolean).forEach(d => { if (d.content) kbContent += `[${d.title}]\n${d.content}\n\n---\n\n`; });

      // Match lead
      let callerContext = '';
      if (cleanCaller && Array.isArray(leads)) {
        const ml = leads.find(l => l.phone && l.phone.replace(/\D/g, '').slice(-10) === cleanCaller);
        if (ml) {
          session._inboundLeadId = ml.id;
          session._leadId = ml.id;
          callerContext = `\n\n--- INBOUND - RETURNING LEAD ---\n- Name: ${ml.name || 'Unknown'}\n- Status: ${ml.status || 'new'}\n- Score: ${ml.score || 0}/100`;
          if (ml.sentiment) callerContext += `\n- Sentiment: ${ml.sentiment}`;
          if (ml.qualification_tier) callerContext += `\n- Tier: ${ml.qualification_tier}`;
          callerContext += `\nAddress by name "${ml.name || 'Sir/Madam'}". For past chat references, call get_call_history.`;
        }
      }

      // FIX: Strip ANY embedded "KNOWLEDGE BASE" section from the agent prompt — KB content
      // lives in session._kbChunks and is fetched via search_knowledge_base tool. Inlining
      // it into the prompt causes the AI to answer from a stale copy and skip the tool.
      let agentPrompt = didAgent.system_prompt || 'You are a helpful AI voice assistant.';
      const kbR = /\n+(?:[-=]{2,}\s*)?KNOWLEDGE BASE[^\n]*[\s\S]*?(?=\n\n---|\n\n##|$)/i;
      agentPrompt = agentPrompt.replace(kbR, '').trim();

      // Seed KB chunks from the full kbContent (single source of truth)
      if (kbContent && kbContent.length >= 100) session._kbChunks = splitKBIntoChunks(kbContent);
      if (didAgent.kb_file_uri) session._kbFileUri = didAgent.kb_file_uri;
      // Capture agent_id so loadKBLazy can self-heal from DB if blob is missing
      session._agentId = didAgent.id;
      const hasKB = session._kbChunks.length > 0 || !!session._kbFileUri || !!session._agentId;

      session._toolFlags = {
        has_kb: hasKB, has_shopify: false, has_unicommerce: false,
        has_call_history: !!session._leadId,
        has_transfer: !!didAgent.human_transfer_number,
        has_end_call: true
      };

      // No inline KB hint — the [MANDATORY TOOL USE] header in sendGeminiSetup handles it.
      session.systemPrompt = agentPrompt + callerContext;

      if (Array.isArray(mInts)) {
        if (mInts.some(i => i.platform === 'shopify')) {
          session.hasShopify = true;
          session._toolFlags.has_shopify = true;
          session.systemPrompt += `\n\n[SHOPIFY ACTIVE] Use shopify_lookup tool for real-time order data.`;
        }
        if (mInts.some(i => i.platform === 'unicommerce')) {
          session.hasUniCommerce = true;
          session._toolFlags.has_unicommerce = true;
          session.systemPrompt += `\n\n[UNICOMMERCE ACTIVE] Use unicommerce_lookup tool.`;
        }
      }

      // Create CallLog
      try {
        const newLog = await svc.entities.CallLog.create({
          client_id: session.clientId, agent_id: didAgent.id,
          lead_id: session._inboundLeadId || null,
          call_sid: session.callSid || `inbound_${Date.now()}`,
          stream_sid: session.streamSid || null,
          caller_id: session.callerNumber || '', callee_number: session.calleeNumber,
          direction: 'inbound', status: 'answered', call_start_time: new Date().toISOString(),
          agent_config_cache: {
            agent_name: didAgent.name, system_prompt: session.systemPrompt,
            persona: didAgent.persona || {}, knowledge_base_content: kbContent.substring(0, 2000),
            greeting_message: didAgent.greeting_message || '',
            is_screening_call: session._isScreeningAgent || false,
            flow_type: 'business-incoming'
          }
        });
        if (newLog) session.callLogId = newLog.id;
      } catch (e) { console.error(`[${reqId}] CallLog err: ${e.message}`); }

      console.log(`[${reqId}] ✅ INBOUND business ready in ${Date.now() - t0}ms: agent="${didAgent.name}", DID=${resolvedDID}, lead=${session._inboundLeadId ? 'yes' : 'no'}`);
    } catch (e) { console.error(`[${reqId}] ❌ Config err: ${e.message}`); }
  }

  connectGemini();

  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.event === 'connected') return;

      if (msg.event === 'start') {
        const sd = msg.start || {};
        session.streamSid = sd.streamSid;
        session.callSid = sd.callSid;
        session.callerNumber = sd.from || sd.customParameters?.caller_number || sd.customParameters?.customer_number || '';
        session.calleeNumber = sd.to || sd.customParameters?.called_number || sd.customParameters?.did || '';
        console.log(`[${reqId}] 📞 START inbound: callee(DID)=${session.calleeNumber}, caller=${session.callerNumber}`);
        session._lastUpsampleValue = 0; session._lastDownsampleRemainder = [];
        session._upPrev1 = null; session._upPrev2 = null;

        // NOTE: robotic pre-recorded filler removed — Gemini's own natural greeting
        // fills the brief config-load gap (same approach as streamGeminiOutgoing).
        loadAgentConfig().then(() => {
          session._agentConfigReady = true;
          if (session.geminiWs?.readyState === WebSocket.OPEN && !session.geminiReady) sendGeminiSetup();
          // If Gemini already finished its handshake while config was loading, the
          // greeting was deferred (setupComplete fired before _agentConfigReady) —
          // fire it now that config is ready. triggerGreeting is _greeted-guarded.
          else if (session.geminiReady && !session._greeted) triggerGreeting();
          // Eagerly pre-warm KB whenever ANY KB source is reachable so the FIRST tool call is instant
          if (session._toolFlags?.has_kb || session._kbFileUri || session._agentId) loadKBLazy().catch(() => {});
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        const raw = atob(msg.media.payload);
        const m = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) m[i] = raw.charCodeAt(i);
        const b64 = mulawToBase64PCM16_16k(m, session);
        // P0: buffer audio during Gemini handshake instead of dropping it
        if (!session.geminiReady) {
          if (session._audioBuffer.length < 150) session._audioBuffer.push(b64); // ~3s cap
          return;
        }
        sendToGemini({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
        return;
      }

      if (msg.event === 'stop') {
        session._callEnded = true;
        const d = Math.round((Date.now() - session.startTime) / 1000);
        if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
        await saveCallRecord(session, reqId, d);
        return;
      }
    } catch (err) { console.error(`[${reqId}] msg err: ${err.message}`); }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    const d = Math.round((Date.now() - session.startTime) / 1000);
    if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
    if (session.callLogId) await saveCallRecord(session, reqId, d);
  };
  smartfloSocket.onerror = () => { if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close(); };

  return response;

};