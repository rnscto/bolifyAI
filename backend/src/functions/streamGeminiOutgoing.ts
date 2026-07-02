import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";
// ═══════════════════════════════════════════════════════════════════════
// streamGeminiOutgoing — Business OUTBOUND calls only (Gemini Live)
// ═══════════════════════════════════════════════════════════════════════
// Phase 2 — handles outbound business calls placed by initiateCall,
// initiateScreeningCall, retentionCall, campaign poller, and sequence runner.
// Inbound calls go to streamGeminiIncoming. Personal calls go to streamGeminiPersonal.
// ═══════════════════════════════════════════════════════════════════════

// ─── Audio helpers (mu-law 8kHz ↔ PCM16 16/24kHz) ───
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
// ─── Inbound mu-law accumulator (size-based, raw mu-law, pre-upsample) ───
// Smartflo delivers 8kHz mu-law frames with HIGHLY VARIABLE cadence
// (measured: min=20ms, avg=60ms, max=260ms — variable-size framing, not a
// fixed frame duration). Instead of upsampling + base64-encoding on EVERY
// media event, we batch raw mu-law bytes and flush when accumulated ≥ 120ms
// (≈2 average frames). A single oversized frame (≥120ms) simply flushes on the
// next check — no special seam-prone path, so every batch goes through the
// SAME upsample code path and audio stays seamless. Encode runs ONCE per
// flush → ~50% fewer Gemini messages + btoa calls.
const ACCUM_TARGET_BYTES = 960; // 120ms @ 8kHz mu-law (1 byte/sample)
// Returns a raw mu-law Uint8Array to upsample+send, or null while still buffering.
function addInboundMulaw(session, bytes) {
  if (!session._inAccum) { session._inAccum = []; session._inAccumLen = 0; }
  session._inAccum.push(bytes);
  session._inAccumLen += bytes.length;
  if (session._inAccumLen >= ACCUM_TARGET_BYTES) return drainInboundMulaw(session);
  return null;
}
function drainInboundMulaw(session) {
  if (!session._inAccum || session._inAccumLen === 0) return null;
  const merged = new Uint8Array(session._inAccumLen);
  let off = 0;
  for (const b of session._inAccum) { merged.set(b, off); off += b.length; }
  session._inAccum = []; session._inAccumLen = 0;
  return merged;
}

function mulawToBase64PCM16_16k(mulawBytes, session) {
  // 8kHz mu-law → 16kHz PCM16 with PROPER band-limited interpolation.
  // The old code duplicated each sample + crude 2-tap average (zero-order hold),
  // which injects high-frequency imaging noise → Gemini "hears" an aliased/noisy
  // signal → degraded transcription + foreign-language hallucinations. We now
  // insert each original sample and compute the in-between sample with a small
  // symmetric FIR (Catmull-Rom style) using the previous/next neighbours carried
  // across batches via session state, giving a smooth, low-pass result.
  const n = mulawBytes.length;
  const pcm8k = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm8k[i] = decodeMulaw(mulawBytes[i]);
  // Carry the last 2 samples of the previous batch so the seam stays continuous.
  const pm2 = session._upPrev2 ?? (pcm8k[0] || 0);
  const pm1 = session._upPrev1 ?? (pcm8k[0] || 0);
  const at = (idx) => (idx < 0 ? (idx === -2 ? pm2 : pm1) : (idx < n ? pcm8k[idx] : pcm8k[n - 1] ?? pm1));
  const pcm16k = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s0 = at(i - 1), s1 = at(i), s2 = at(i + 1), s3 = at(i + 2);
    pcm16k[i * 2] = s1;
    // Catmull-Rom interpolation at the midpoint (t=0.5) → smooth band-limited tween.
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
  // 3:1 downsample (24kHz → 8kHz) with a GENTLE triangular low-pass [0.25,0.5,0.25].
  // This is a smooth anti-alias filter with NO negative side-lobes, so it removes
  // high-frequency aliasing WITHOUT the ringing/distortion a sharp sinc FIR adds on
  // loud speech. (A sharp FIR overshoots on Gemini's high-energy output → audible
  // "garbled" voice.) Uses every sample and carries a 1-sample tail across chunks.
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
    const a = all[idx], b = all[idx + 1], c = all[idx + 2];
    const f = Math.round(a * 0.25 + b * 0.5 + c * 0.25);
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

// ─── SDK pre-warm ───
let _sdkModulePromise = null;
function getSDKModule() {
  if (!_sdkModulePromise) _sdkModulePromise = import('npm:@base44/sdk@0.8.31');
  return _sdkModulePromise;
}
getSDKModule().catch(() => {});

// ─── Postgres CallLog read (Option A: zero-Base44 dial path) ───
// campaignPoller now writes the dial CallLog (incl. agent_config_cache) DIRECTLY
// to Postgres; the Base44 mirror is async and may lag under load. So when the
// Base44 CallLog.get for custom_identifier misses, we read the same row from PG
// — guaranteeing the live call always gets the right agent config + prompt.
// ─── Warm-connection cache (per isolate) ───
// The O(1) CallLog lookup is on the critical path to the greeting. Opening a
// fresh PG connection costs ~600ms (TLS handshake). We open ONE connection
// during the idle gap before Smartflo's `start` frame and reuse it for the
// lookup, so the lookup itself is ~20ms instead of ~660ms.
let _warmPgPromise = null;
function getWarmPg() {
  if (_warmPgPromise) return _warmPgPromise;
  _warmPgPromise = (async () => {
    const { Client: PgClient } = await import('jsr:@db/postgres@0.19.4');
    const pg = new PgClient({
      hostname: Deno.env.get('AZURE_PG_HOST'),
      port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
      database: Deno.env.get('AZURE_PG_DATABASE'),
      user: Deno.env.get('AZURE_PG_USER'),
      password: Deno.env.get('AZURE_PG_PASSWORD'),
      tls: { enabled: true, enforce: true },
      connection: { attempts: 1 },
    });
    ; /* pg.connect() not needed */
    return pg;
  })();
  // If the warm connect fails, reset so a later call can retry with a fresh one.
  _warmPgPromise.catch(() => { _warmPgPromise = null; });
  return _warmPgPromise;
}

// ─── MODULE-LEVEL PG WARM-UP ───
// Deno reuses isolates across calls. Opening the PG connection at module-load
// (not per-request) means the TLS handshake completes during the IDLE GAP
// BETWEEN calls — so by the time the next call's `start` frame arrives, the
// connection is already warm and the O(1) CallLog lookup returns in ~20ms
// instead of ~600ms. This is the real fix for the cold-lookup latency that
// gated the greeting. Fire-and-forget — never blocks module init.
getWarmPg().catch(() => {});

async function pgGetCallLogById(callLogId) {
  if (!callLogId) return null;
  // Use the warm connection (opened during the idle gap) — falls back to a
  // one-shot connection if the warm one isn't ready or has dropped.
  try {
    const pg = await getWarmPg();
    const res = await pg.queryObject`
      SELECT id, client_id, agent_id, lead_id, call_sid, caller_id, callee_number,
             direction, status, agent_config_cache
      FROM call_logs WHERE id = ${callLogId} LIMIT 1`;
    return res.rows[0] || null;
  } catch (_) {
    // Warm connection unusable — reset it and do a one-shot fallback.
    _warmPgPromise = null;
    let PgClient;
    try { ({ Client: PgClient } = await import('jsr:@db/postgres@0.19.4')); }
    catch (_2) { return null; }
    const pg = new PgClient({
      hostname: Deno.env.get('AZURE_PG_HOST'),
      port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
      database: Deno.env.get('AZURE_PG_DATABASE'),
      user: Deno.env.get('AZURE_PG_USER'),
      password: Deno.env.get('AZURE_PG_PASSWORD'),
      tls: { enabled: true, enforce: true },
      connection: { attempts: 1 },
    });
    try {
      ; /* pg.connect() not needed */
      const res = await pg.queryObject`
        SELECT id, client_id, agent_id, lead_id, call_sid, caller_id, callee_number,
               direction, status, agent_config_cache
        FROM call_logs WHERE id = ${callLogId} LIMIT 1`;
      return res.rows[0] || null;
    } catch (_3) {
      return null;
    } finally {
      try { ; /* pg.end() not needed */ } catch (_3) {}
    }
  }
}

// ─── Postgres CallLog finalize (Option A: campaign CallLogs live only in PG) ───
// Campaign dials create the CallLog DIRECTLY in Postgres and never mirror it to
// Base44. So when saveCallRecord can't find/update the row in Base44 (404), we
// persist the terminal result (status, transcript, summary, duration) to PG so
// campaignPoller sees the call complete and campaign progress advances. Also
// updates campaign_leads to completed with the resolved outcome.
function _openPg() {
  return import('jsr:@db/postgres@0.19.4').then(({ Client }) => {
    const pg = new Client({
      hostname: Deno.env.get('AZURE_PG_HOST'),
      port: parseInt(Deno.env.get('AZURE_PG_PORT') || '5432', 10),
      database: Deno.env.get('AZURE_PG_DATABASE'),
      user: Deno.env.get('AZURE_PG_USER'),
      password: Deno.env.get('AZURE_PG_PASSWORD'),
      tls: { enabled: true, enforce: true },
      connection: { attempts: 1 },
    });
    return pg.connect().then(() => pg);
  });
}
// Maps the AI lead_status to a campaign_leads outcome bucket.
function _statusToOutcome(leadStatus) {
  const map = {
    interested: 'interested', not_interested: 'not_interested', callback: 'callback',
    voicemail: 'voicemail', converted: 'converted', do_not_call: 'do_not_call',
    no_answer: 'not_answered', contacted: 'neutral', neutral: 'neutral',
  };
  return map[leadStatus] || 'neutral';
}
// Resolve the campaign_leads.call_status from the AI lead_status.
function _statusToCallStatus(leadStatus) {
  if (leadStatus === 'voicemail') return 'voicemail';
  if (leadStatus === 'no_answer') return 'not_answered';
  return 'answered';
}
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
async function pgFinalizeCallLog(callLogId, update, leadStatus, leadScore) {
  let pg;
  try {
    pg = await _openPg();
    // Finalize the call_logs row.
    await pg.queryObject`
      UPDATE call_logs SET
        status = ${update.status || 'completed'},
        transcript = ${update.transcript || ''},
        conversation_summary = ${update.conversation_summary || ''},
        duration = ${update.duration || 0},
        lead_status_updated = ${update.lead_status_updated || ''},
        call_end_time = ${update.call_end_time || new Date().toISOString()}::timestamptz,
        updated_at = now()
      WHERE id = ${callLogId}`;
    // Advance the campaign lead (if this CallLog belongs to one) so the poller
    // counts it as completed and the campaign progresses.
    const outcome = _statusToOutcome(leadStatus);
    const callStatus = _statusToCallStatus(leadStatus);
    await pg.queryObject`
      UPDATE campaign_leads SET
        status = 'completed',
        outcome = ${outcome},
        conversation_summary = ${update.conversation_summary || ''},
        transcript = ${update.transcript || ''},
        call_duration = ${update.duration || 0},
        call_status = ${callStatus},
        updated_at = now()
      WHERE call_log_id = ${callLogId} AND status IN ('calling', 'processing', 'pending')`;
    return true;
  } catch (e) {
    console.error(`[pgFinalizeCallLog] ${e.message}`);
    return false;
  } finally {
    try { if (pg) ; /* pg.end() not needed */ } catch (_) {}
  }
}

// ─── Noise + hallucinated-script filter ───
// Gemini's transcriber hallucinates Korean/Japanese/Chinese/Arabic/Thai/Cyrillic/Hangul
// phrases on silence or noisy Indian-language audio. Drop those entirely so the
// AI never reacts to imaginary foreign speech.
// Also catches common ambient-noise transcription artifacts from TV, radio, traffic:
//   [music], (background noise), pure DTMF digits, ambient single-word responses.
function isNoiseTranscription(text) {
  const t = (text || '').trim();
  if (!t) return true;
  // Micro-filler sounds — never real speech turns
  if (t.length <= 4 && /^(uh|um|mhm|hmm|eh|oh|ah|hm|uh-huh)\.?$/i.test(t)) return true;
  // Forbidden scripts → always drop (Korean, Japanese, CJK, Arabic, Thai, Cyrillic)
  if (/[\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u0600-\u06FF\u0E00-\u0E7F\u0400-\u04FF]/.test(t)) return true;
  // Must contain at least one Latin or Devanagari character
  if (!/[a-zA-Z\u0900-\u097F]/.test(t)) return true;
  // Spanish-only punctuation (¿ ¡) → always hallucination on Indian call audio
  if (/[¿¡]/.test(t)) return true;
  // Drop short diacritic-heavy strings (Spanish/Portuguese/French hallucinations from background noise)
  if (t.length < 80 && /[àâäçéèêëîïôöûùüÿñõãáíóú]/i.test(t)) return true;
  // TV/radio/ambient pattern: Bracketed or parenthetical sound descriptions
  //   [music playing], [applause], [background noise], (laughter), (crowd noise)
  if (/^[\[(].*[\])]$/.test(t)) return true;
  if (/\[(?:music|applause|laughter|noise|crowd|background|sound|beep|ring|click|static|tone|silence|inaudible)\b/i.test(t)) return true;
  if (/\((?:music|applause|laughter|noise|crowd|background|sound|beep|ring|static|inaudible)\b/i.test(t)) return true;
  // Pure DTMF / digits-only (touch-tone artifacts picked up as "speech")
  if (/^[\d\s\+\-\*#]+$/.test(t)) return true;
  // Ambient background voice: very short responses typical of background conversations
  // Only suppress if ≤ 2 words AND they are very common ambient words
  if (/^(yeah|yep|nope|okay|ok|sure|right|alright|fine|yes|no|mhm|ahh|ohh|hmm)[\.!,]?$/i.test(t)) return true;
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
// PERSONA LOCK — translate the agent's persona (language/accent + tone) into a
// hard instruction. THIS is the fix for "agent speaks US-accent English even
// though it's set to Indian English": persona.language was loaded but never
// passed to Gemini, so it defaulted to a US accent. We now lock it explicitly.
// Shared identically across outgoing / incoming / personal streams.
// ═══════════════════════════════════════════════════════════════════════
const GEMINI_FEMALE_VOICES = new Set(['aoede','kore','leda','autonoe','callirrhoe','despina','erinome','laomedeia','pulcherrima','vindemiatrix','achernar','gacrux','sulafat','zephyr']);
const LANG_LABEL = {
  'en-in': 'Indian English (Indian accent)',
  'hi-in': 'Hindi (natural Indian pronunciation)',
  'en-us': 'US English (American accent)',
  'en-gb': 'British English (UK accent)',
  'bilingual': 'natural Hinglish — mix Hindi + Indian-accent English the way Indians speak',
  'mr-in': 'Marathi (natural Indian pronunciation)',
};
function buildPersonaLock(persona) {
  const p = persona || {};
  const lang = String(p.language || 'en-in').toLowerCase();
  const label = LANG_LABEL[lang] || LANG_LABEL['en-in'];
  const voice = String(p.voice_type || '').toLowerCase();
  const isFemale = GEMINI_FEMALE_VOICES.has(voice);
  const lines = [];
  // Accent/language is the headline fix.
  lines.push(`• ACCENT/LANGUAGE: Speak in ${label}. This accent is FIXED — never drift to a US/American accent. Mirror the customer if they switch language, but keep your Indian accent.`);
  // Gender-correct Hindi verb forms by voice.
  lines.push(isFemale
    ? `• You have a FEMALE voice — use feminine Hindi verb forms (kar rahi hoon, bol rahi hoon).`
    : `• You have a MALE voice — use masculine Hindi verb forms (kar raha hoon, bol raha hoon).`);
  if (p.tone) lines.push(`• TONE: Stay ${p.tone} throughout — warm and human, never robotic or monotone.`);
  return lines.join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════════════════════
// SAVE CALL RECORD — full business analysis (lead score, sentiment)
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

                        let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0, intentSignals = [], scoreBreakdown = {}, keyTopics = [], summaryHindi = '';

    if (transcript.trim().length > 30 && baseUrl && deployment && apiKey) {
      try {
        const r = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
          method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'Expert sales call analyst. Score 0-100. Respond ONLY in valid JSON.' },
              { role: 'user', content: `Transcript:\n${transcript}\n\nClassify lead_status accurately:\n- "interested": customer engaged & showed interest / asked about pricing / agreed to demo.\n- "callback": customer (a real human) asked to be called back later.\n- "voicemail": the call hit an answering machine / voicemail — the AI spoke into dead air and there was NO genuine two-way human conversation (e.g. only an automated greeting, beep, or carrier voicemail prompt). Use this ONLY for true voicemail, NOT for a short real conversation.\n- "not_interested": customer declined.\n- "converted": customer agreed to buy/sign up.\n- "do_not_call": customer asked to never be called.\n- "contacted": a real conversation happened but no clear interest/rejection.\n\nReturn JSON: {"summary":"2-3 sentences","summary_hindi":"Devanagari","lead_status":"interested|not_interested|callback|voicemail|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":[],"objections":[],"recommended_next_action":"..."}` }
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
          console.log(`[${reqId}] 🧠 Score=${leadScore}, status=${leadStatus}`);
        }
      } catch (e) { console.error(`[${reqId}] AI err: ${e.message}`); }
    } else { summary = 'Call ended with minimal conversation.'; }

    const custLines = session.transcript.filter(t => t.speaker === 'Customer');
    const custWords = custLines.reduce((a, t) => a + t.text.split(/\s+/).length, 0);
    const aiLines = session.transcript.filter(t => t.speaker === 'AI');
    // Guard against the LLM over-classifying a very short snippet as a hard negative.
    if (custWords <= 5 && duration < 30 && (leadStatus === 'do_not_call' || leadStatus === 'not_interested')) {
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
    }
    // ── VOICEMAIL: the LLM decides (see prompt). We only normalize its label here.
    //    The previous custWords<=2 heuristic mislabeled almost every ANSWERED call
    //    as 'callback' because the live transcript routinely drops customer speech.
    //    We now TRUST the LLM's 'voicemail' classification and only apply a
    //    deterministic safety-net when there was genuinely NO usable transcript at all
    //    (AI talked, zero customer words, short call) — and even then mark it
    //    'voicemail' (its own status), never 'callback'.
    if (leadStatus === 'voicemail') {
      sentiment = 'neutral';
      leadScore = Math.max(leadScore, 10);
      console.log(`[${reqId}] 📭 Voicemail (LLM-classified)`);
    } else if (custWords === 0 && aiLines.length >= 1 && duration < 20 && leadStatus !== 'converted') {
      // No customer words at all + AI monologue + short call = almost certainly voicemail.
      leadStatus = 'voicemail';
      sentiment = 'neutral';
      leadScore = Math.max(leadScore, 10);
      console.log(`[${reqId}] 📭 Voicemail (deterministic safety-net: 0 customer words, ${duration}s)`);
    }

    let qTier = 'cold', qReason = '';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) { qTier = 'hot'; qReason = `${leadScore}/100, ${sentiment}`; }
    else if (leadScore >= 50) { qTier = 'warm'; qReason = `${leadScore}/100`; }
    else if (leadScore >= 25) { qTier = 'nurture'; qReason = `${leadScore}/100`; }
    else if (['negative', 'very_negative'].includes(sentiment)) qTier = 'disqualified';
    if (leadStatus === 'converted') qTier = 'hot';
    if (leadStatus === 'do_not_call') qTier = 'disqualified';

    const enriched = summary ? `${summary}${summaryHindi ? '\n\n🇮🇳 ' + summaryHindi : ''}\n\n---\nScore: ${leadScore}/100 | ${sentiment} | ${qTier} | ${intentSignals.join(', ')}` : '';

    // The CallLog may live ONLY in Postgres (Option A campaign dials never mirror
    // to Base44). Try Base44 first; if absent, finalize directly in Postgres so
    // campaign progress advances instead of silently 404-failing.
    let currentLog = null;
    // Skip the Base44 .get() entirely for PG-only campaign CallLogs (resolved via
    // Postgres in loadAgentConfig) — it would always 404 and spam the error log.
    if (!session._pgOnlyCallLog) {
      try { currentLog = await svc.entities.CallLog.get(session.callLogId); }
      catch (_) { currentLog = null; }
    }
    const isPgOnly = !currentLog;
    if (isPgOnly) {
      // Pull the PG row so we keep lead_id/agent_config_cache for downstream steps.
      currentLog = await pgGetCallLogById(session.callLogId) || {};
    }

    const wasTerminal = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);
    const callLogUpdate = {
      ...(wasTerminal ? {} : { status: 'completed', call_end_time: new Date().toISOString() }),
      transcript: transcript || '', duration,
      lead_status_updated: leadStatus,
      ...(enriched ? { conversation_summary: enriched } : {})
    };

    if (isPgOnly) {
      // PG-only campaign CallLog → finalize in Postgres + advance campaign_leads.
      const ok = await pgFinalizeCallLog(session.callLogId, callLogUpdate, leadStatus, leadScore);
      console.log(`[${reqId}] 💾 PG-finalized: ${session.callLogId}, score=${leadScore}, ok=${ok}`);
    } else {
      // ── POSTGRES-PRIMARY WRITE ── transcript + summary survive a Base44 429.
      try { await svc.functions.invoke('pgLeadSync', { call_log: { ...currentLog, ...callLogUpdate } }); }
      catch (pgErr) { console.error(`[${reqId}] ⚠️ PG-primary write failed: ${pgErr.message}`); }
      await svc.entities.CallLog.update(session.callLogId, callLogUpdate);
      console.log(`[${reqId}] 💾 Saved: ${session.callLogId}, score=${leadScore}`);
    }

    // Update Lead
    const leadId = currentLog.lead_id || session._leadId;
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
        // ── Fix #5: move the lead along the client's Blueprint pipeline by disposition ──
        const bp = await _resolveBlueprint(svc, currentLog.client_id || session.clientId);
        const stage = _leadStatusToStage(leadStatus, bp);
        if (stage) {
          leadUpdate.custom_fields = { ...(ex.custom_fields || {}), pipeline_stage: stage };
          console.log(`[${reqId}] 🪜 Pipeline stage → ${stage} (status=${leadStatus})`);
        }
        await svc.entities.Lead.update(leadId, leadUpdate);
      } catch (e) { console.error(`[${reqId}] Lead err: ${e.message}`); }
    }

    // Post-call fan-out → single idempotent orchestrator (replaces the
    // unreliable setTimeout recording fetch + direct action-extractor invoke).
    // Runs in a fresh function isolate that is NOT torn down with this WS,
    // so recording fetch is no longer lost when the call socket closes.
    svc.functions.invoke('postCallOrchestrator', { call_log_id: session.callLogId }).catch(() => {});

    if (currentLog?.agent_config_cache?.is_screening_call) {
      svc.functions.invoke('processScreeningResult', { call_log_id: session.callLogId }).catch(() => {});
    }
  } catch (err) { console.error(`[${reqId}] ❌ Save: ${err.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════
export default async function streamGeminiOutgoing(c: any) {
  const req = c.req.raw || c.req;
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWS = upgrade === 'websocket';
  const _wsOpenTs = Date.now();
  console.log(`[${reqId}] 📨 ${req.method} (outgoing-business), ws=${isWS} @ ${new Date().toISOString()}`);

  if (!isWS) {
    const host = req.headers.get('host') || 'localhost';
    const proto = req.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
    return c.json({ data: {
      status: 'ready', flow: 'business-outgoing', version: 'v1.0-gemini-outgoing',
      wss_url: `${proto}://${host}/functions/streamGeminiOutgoing`
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
    _leadId: null, _agentId: null, _toolFlags: {},
    _mediaAssets: [],  // WhatsApp-sendable files (loaded from MediaAsset)
    _audioBuffer: [],  // P0: queue customer audio during Gemini handshake
    _greeted: false,   // true once the opening greeting has been spoken — prevents
                       // re-greeting when Gemini's socket recycles mid-call (~5 min).
  };

  let _cachedSvc = null;
  let _svcWarmPromise = null;
  async function getSvc() {
    if (_cachedSvc) return _cachedSvc;
    const { createClient } = await getSDKModule();
    _cachedSvc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    return _cachedSvc;
  }
  // PRE-WARM: build the SDK client AND complete the first auth/TLS round-trip to the
  // Base44 data API during the idle gap between WS-connect and the Smartflo `start`
  // frame (~1s). Without this, the very first real query (the phone lookup) eats the
  // entire cold-start cost (~1s). A tiny indexed query primes the connection so the
  // real lookup later returns in ~50ms. Fire-and-forget — never blocks anything.
  function warmSvc() {
    if (_svcWarmPromise) return _svcWarmPromise;
    _svcWarmPromise = (async () => {
      try {
        const svc = await getSvc();
        await svc.entities.CallLog.filter({ direction: 'outbound' }, '-created_date', 1).catch(() => {});
      } catch (_) {}
    })();
    return _svcWarmPromise;
  }
  // Cache the agent record fetched during config load so loadKBLazy reuses it
  // instead of issuing a second identical Agent.get round-trip.
  let _agentRecord = null;

  async function loadKBLazy() {
    if (session._kbChunks.length > 0) return;
    if (session._kbLoadPromise) { await session._kbLoadPromise; return; }
    session._kbLoadPromise = (async () => {
      console.log(`[${reqId}] 📚 KB load start: uri=${session._kbFileUri ? 'yes' : 'no'}, agentId=${session._agentId || 'null'}, clientId=${session.clientId || 'null'}`);
      // Path A: blob URI available — direct Azure Blob read
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
          console.log(`[${reqId}] 📚 KB blob: ${text.length}ch → ${session._kbChunks.length} chunks (uri=${session._kbFileUri})`);
          if (session._kbChunks.length > 0) return;
        } catch (e) { console.error(`[${reqId}] ⚠️ Blob KB load failed: ${e.message} — falling back to DB`); }
      }
      // Path B: load from Agent.knowledge_base_ids
      if (session._agentId) {
        try {
          const svc = await getSvc();
          // Reuse the agent record already fetched in loadAgentConfig when available
          // (avoids a duplicate Agent.get round-trip). Fall back to a fresh fetch only
          // if loadKBLazy somehow runs before config (e.g. mid-call tool invocation).
          const ag = _agentRecord || await svc.entities.Agent.get(session._agentId);
          const kbIds = ag?.knowledge_base_ids || [];
          console.log(`[${reqId}] 📚 Agent kb_ids: ${kbIds.length}`);
          if (kbIds.length) {
            const docs = await Promise.all(kbIds.map(id => svc.entities.KnowledgeBase.get(id).catch(() => null)));
            const valid = docs.filter(d => d && d.content);
            let text = '';
            valid.forEach(d => { text += `[${d.title}]\n${d.content}\n\n---\n\n`; });
            console.log(`[${reqId}] 📚 KB docs from agent: ${valid.length}/${kbIds.length} have content, total=${text.length}ch`);
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
      // Path C: LAST RESORT — agent has no KB attached, fall back to client-wide KB docs.
      // Solves the orphan case where docs exist for the client but aren't attached to the agent.
      if (session.clientId) {
        try {
          const svc = await getSvc();
          const clientDocs = await svc.entities.KnowledgeBase.filter({ client_id: session.clientId, status: 'ready' }).catch(() => []);
          console.log(`[${reqId}] 📚 Client-wide KB fallback: ${clientDocs.length} docs found`);
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
    // Sales agents only: allow booking a Vaani demo mid-call.
    if (session._toolFlags?.can_book_demo) {
      decls.push({
        name: 'book_demo',
        description: 'Book a Vaani AI product demo for the prospect during the call. Use ONLY after the customer has explicitly agreed to a specific date and time. Confirm the slot back to them before calling this. Returns a booking code and a room URL that will be emailed/WhatsApped automatically.',
        parameters: {
          type: 'object',
          properties: {
            scheduled_at: { type: 'string', description: 'ISO 8601 UTC datetime. Convert IST → UTC by subtracting 5h30m. E.g. 10:30 AM IST = 05:00 UTC.' },
            lead_name: { type: 'string' },
            lead_email: { type: 'string' },
            lead_phone: { type: 'string', description: 'E.164 without +. Defaults to the called number.' },
            company_name: { type: 'string' },
            focus_area: { type: 'string', description: 'What the prospect wants to see, e.g. "voice agents", "CRM", "campaigns"' },
            language: { type: 'string', enum: ['en', 'hi', 'bilingual'], description: 'Preferred demo language' }
          },
          required: ['scheduled_at', 'lead_email']
        }
      });
    }
    // P2: declare KB tool whenever ANY KB source is reachable — flag, blob URI, chunks, OR an agent_id to self-heal from DB
    if (session._toolFlags?.has_kb || session._kbChunks.length > 0 || session._kbFileUri || session._agentId) {
      decls.push({ name: 'search_knowledge_base', description: 'Search KB for product/pricing/feature/policy info. ALWAYS use for company facts.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } });
    }
    if (session._toolFlags?.has_call_history && session._leadId) {
      decls.push({ name: 'get_call_history', description: 'Fetch past calls with this lead.', parameters: { type: 'object', properties: {}, required: [] } });
    }
    // Real-time WhatsApp media: register when the client has sendable files.
    if (session._mediaAssets.length > 0) {
      const intents = session._mediaAssets.map(a => a.intent).filter(Boolean);
      decls.push({
        name: 'send_whatsapp_media',
        description: `Send a PDF/image to the customer on WhatsApp instantly during the call when they ask for it (e.g. "send me the pricing/brochure on WhatsApp"). Available files: ${intents.join(', ')}.`,
        parameters: { type: 'object', properties: { intent: { type: 'string', description: `Which file to send. One of: ${intents.join(', ')}` } }, required: ['intent'] }
      });
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
    if (name === 'send_whatsapp_media') {
      // Match the requested intent to a MediaAsset and send it via WhatsApp now.
      const wanted = String(args.intent || '').toLowerCase().trim();
      const asset = session._mediaAssets.find(a => (a.intent || '').toLowerCase() === wanted)
        || session._mediaAssets.find(a => (a.intent || '').toLowerCase().includes(wanted) || (a.name || '').toLowerCase().includes(wanted))
        || session._mediaAssets[0];
      if (!asset) return { error: 'No matching file' };
      if (!session.clientId) return { error: 'No client context' };
      try {
        const svc = await getSvc();
        const r = await svc.functions.invoke('sendWhatsAppMedia', {
          client_id: session.clientId, to: session.calleeNumber || '', media_asset_id: asset.id,
          lead_id: session._leadId || null, call_log_id: session.callLogId || null, outreach_type: 'lead_followup'
        });
        const d = r?.data || {};
        console.log(`[${reqId}] 📎 send_whatsapp_media intent="${wanted}" → ${asset.name}: ${d.success ? 'sent' : d.error}`);
        return d.success ? { success: true, sent: asset.name } : { error: d.error || 'send failed' };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'end_call') {
      // P1: prevent premature end_call — require minimum call duration
      const elapsed = (Date.now() - session.startTime) / 1000;
      if (elapsed < 10) {
        console.log(`[${reqId}] 🛑 end_call rejected — too early (${elapsed.toFixed(1)}s)`);
        return { error: 'Call just started. Continue the conversation naturally.' };
      }
      // P1.5: require explicit goodbye phrase from the CUSTOMER in the last few turns.
      // Without this, Gemini auto-ends mid-conversation on its own questions.
      const recentCustomer = session.transcript
        .filter(t => t.speaker === 'Customer')
        .slice(-3)
        .map(t => (t.text || '').toLowerCase())
        .join(' ');
      const goodbyeRegex = /(bye|goodbye|alvida|namaste|namaskar|dhanyav[aā]d|thank\s*you|thanks|shukriya|theek\s*hai\s*bye|ok\s*bye|fir\s*milte|chalo\s*bye|phone\s*(kaat|kat|rakh)|kaat\s*do|kat\s*do|rakh\s*do|rakhta\s*hoon|rakhti\s*hoon|abhi\s*baat\s*nahi|baat\s*nahi\s*karni|busy\s*hoon|baad\s*mein|nahi\s*chahiye|mat\s*karo\s*call|call\s*mat|pareshan\s*mat|already\s*(le|liya)|le\s*chuka|le\s*chuki|subscription\s*le|बाय|अलविदा|धन्यवाद|शुक्रिया|नमस्ते|नमस्कार|फिर मिलते|फ़ोन\s*(काट|रख)|काट\s*दो|रख\s*दो|अभी\s*बात\s*नहीं|बात\s*नहीं\s*करनी|बाद\s*में|नहीं\s*चाहिए|परेशान\s*मत)/i;
      if (!goodbyeRegex.test(recentCustomer)) {
        console.log(`[${reqId}] 🛑 end_call rejected — customer hasn't said goodbye. Last customer: "${recentCustomer.substring(0, 120)}"`);
        return { error: 'Customer has NOT said goodbye yet. Continue the conversation. Do NOT call end_call until the customer explicitly says bye/thank you/namaste/dhanyavaad. Ask your next question.' };
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
        } else if (args.lookup_type === 'order_by_phone') {
          const r = await fetch(`${url}/orders.json?status=any&limit=20`, { headers: h });
          if (r.ok) { const d = await r.json(); const cq = args.query.replace(/[^0-9]/g, ''); const f = (d.orders || []).filter(o => { const ph = (o.customer?.phone || o.phone || '').replace(/[^0-9]/g, ''); return ph.includes(cq); }); return { orders: f.slice(0, 5).map(o => ({ order_number: o.name, status: o.fulfillment_status || 'unfulfilled', total: `${o.currency} ${o.total_price}` })) }; }
        }
        return { message: 'processed' };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'book_demo' && session._toolFlags?.can_book_demo) {
      try {
        const svc = await getSvc();
        const r = await svc.functions.invoke('bookDemoFromCall', {
          lead_id: session._leadId || '',
          lead_name: args.lead_name || '',
          lead_email: args.lead_email,
          lead_phone: args.lead_phone || session.calleeNumber || '',
          company_name: args.company_name || '',
          focus_area: args.focus_area || '',
          language: args.language || 'bilingual',
          scheduled_at: args.scheduled_at,
          duration_minutes: 30
        });
        const d = r?.data || {};
        if (d.error) return { error: d.error };
        // Mark that we booked from the call — extractor fallback will skip
        session._demoBookedFromCall = true;
        return {
          success: true,
          booking_code: d.booking?.booking_code || d.booking_code,
          room_url: d.room_url,
          message: 'Demo booked. Confirmation will be sent via email and WhatsApp.'
        };
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
      // Auto-fallback: FREE → PAID on quota close. Trigger whenever we're still
      // on the FREE key and never completed a handshake — even if a prior backoff
      // reconnect already started. Previously _triedKeyFallback was consumed on the
      // FIRST close, so subsequent FREE-key quota closes never switched to PAID and
      // looped forever (the 6s+ silence). PAID is the lowest-latency first try.
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
    ws.onerror = () => {};
    session.geminiWs = ws;
  }

  function sendToGemini(msg) { if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.send(JSON.stringify(msg)); }

  function sendGeminiSetup() {
    const tools = buildGeminiTools();
    const hasKB = session._toolFlags?.has_kb || session._kbFileUri || session._kbChunks.length > 0 || !!session._agentId;
    // COMPRESSED PROMPT — every char re-processed per turn, so keep this lean.
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
    const langLock = `[RULES]\n${buildPersonaLock(session.persona)}• Speak ONLY Hindi (Devanagari/Roman) + English. Marathi OK. NEVER use Korean/Japanese/Chinese/Arabic/Thai/Spanish/Portuguese/French.\n• MIRROR the customer: reply in the SAME language they use. If they switch, you switch — but always keep your Indian accent.\n• If transcription looks foreign, it is noise — IGNORE it, do NOT respond.\n• ONLY if the customer has ALREADY spoken at least once AND their words were genuinely unclear, say: "Aapki voice clear nahi hai, can you repeat it?" then WAIT. NEVER say this on opening silence or before the customer has spoken.\n• Identity (name/company) is FIXED — never change.\n`;
    const kbHeader = hasKB ? `• For any price/product/feature/policy/location fact: CALL search_knowledge_base FIRST. Never guess. Never say "tool/database/AI".\n• If KB has nothing or you cannot answer: politely say "Iske exact details WhatsApp pe bhej deti hoon" and CONTINUE the conversation. NEVER hang up or call end_call just because you don't know an answer.\n` : '';
    const nameRule = `• Use the customer's name SPARINGLY — at most once or twice in the whole call (a greeting and maybe one more time). Do NOT repeat their name in every sentence.\n• If you don't fully understand a question, ask ONE short clarifying question and WAIT. Never disconnect because you didn't understand.\n`;
    const transferI = session.humanTransferNumber && session.enableAutoTransfer ? `• Customer asks for human → call transfer_to_human.\n` : '';
    const endR = `• end_call when CUSTOMER signals they want to end: bye/thanks/namaste/dhanyavaad, OR Indian hang-up cues like "phone kaat do", "rakh do", "abhi baat nahi karni", "baad mein", "nahi chahiye", "already subscription le liya", "call mat karo". Say a quick polite goodbye, THEN call end_call. Your own goodbye alone doesn't count. On silence → ask next question, never end.\n`;
    const time = `• Now: ${nowIST} IST.\n\n`;
    // RECONNECT RESUME: if we already greeted, Gemini's socket recycled mid-call.
    // The SAME phone call + SAME session is still live — seed the new Gemini brain
    // with the recent conversation so it continues seamlessly (NO re-greeting).
    let resumeBlock = '';
    if (session._greeted) {
      const recap = session.transcript
        .filter(t => t.speaker === 'Customer' || t.speaker === 'AI')
        .slice(-20)
        .map(t => `${t.speaker === 'AI' ? 'You' : 'Customer'}: ${t.text}`)
        .join('\n');
      resumeBlock = `[CALL IN PROGRESS — DO NOT GREET]\nThis call is already ongoing. Do NOT introduce yourself or greet again. Open with a brief natural bridge like "Haan ji, jaisa main keh rahi thi..." / "As I was saying..." then CONTINUE seamlessly from where the conversation left off below. You CAN reference what was discussed earlier — it is in the transcript below.\n${recap ? `\nConversation so far:\n${recap}\n` : ''}\n`;
    }
    const fullPrompt = resumeBlock + langLock + kbHeader + nameRule + transferI + endR + time + session.systemPrompt;

    const setup = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceType } } } },
        systemInstruction: { parts: [{ text: fullPrompt }] },
        // ── TURN-TAKING LATENCY FIX ── Tune the server-side VAD so Gemini replies
        // quickly after the caller stops talking instead of waiting out the default
        // (long) end-of-speech silence. HIGH end-sensitivity = detects end-of-turn
        // sooner; 400ms silence is natural for phone speech without clipping the
        // caller mid-sentence. This is the documented lever for mid-call response lag.
        realtimeInputConfig: {
          automaticActivityDetection: {
            // ── VAD TUNING FOR NOISY PHONE ENVIRONMENTS ──
            // LOW start-sensitivity = requires actual human speech energy to trigger,
            // NOT ambient noise (air conditioning, TV, traffic, background voices).
            // HIGH was the root cause: ANY audio triggered barge-in → agent silenced.
            startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
            // Keep HIGH end-sensitivity — we still want to respond quickly once real
            // speech finishes, so the agent doesn't feel laggy.
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            // 600ms debounce (was 400ms). A brief noise burst or inter-word pause in
            // background audio must sustain for 600ms of silence before being counted
            // as end-of-speech. Phone-quality noise rarely crosses 600ms of true silence.
            silenceDurationMs: 600,
            // 120ms onset padding (was 60ms). Buffers the start of the speech window
            // to avoid clipping word-initial consonants when real speech begins.
            prefixPaddingMs: 120
          }
        },
        inputAudioTranscription: {}, outputAudioTranscription: {}
      }
    };
    if (tools.length) {
      setup.setup.tools = [{ functionDeclarations: tools }];
    }
    sendToGemini(setup);
    console.log(`[${reqId}] 📤 Setup: tools=${tools.length}, voice=${session.voiceType}, prompt=${fullPrompt.length}ch, kb=${hasKB}`);
  }

  function handleGeminiMessage(msg) {
    if (msg.setupComplete !== undefined) {
      session.geminiReady = true;
      session._geminiReconnectAttempts = 0; // handshake succeeded → safe to reset
      // Greet ONLY on the first setup of this call. On a mid-call Gemini reconnect
      // (_greeted already true) the resume block in the prompt handles continuity,
      // so we must NOT re-trigger the greeting.
      // NOTE: setupComplete and agent-config load race each other. maybeGreet()
      // fires the greeting as soon as BOTH are ready, no matter which finishes
      // last — this prevents the multi-second stall where setup completed first,
      // config arrived after, and nothing ever triggered the opening line.
      maybeGreet();
      // Drop handshake-buffered audio — flushing it causes Gemini to burst-generate
      // response audio, which floods the outbound queue and produces fast-forward playback.
      // On outbound calls we speak first (greeting), so pre-greeting audio is just hiss.
      session._audioBuffer = [];
      return;
    }
    if (msg.serverContent) {
      const sc = msg.serverContent;
      if (sc.modelTurn?.parts) {
        // 3.1-flash-live packs MULTIPLE parts per event (audio + text together).
        // Process EVERY part: audio → Smartflo, text → AI transcript buffer.
        // Previously text parts were dropped → garbled saved transcripts.
        for (const p of sc.modelTurn.parts) {
          if (p.inlineData?.mimeType?.includes('audio')) {
            session.isSpeaking = true;
            if (!session._firstAudioLogged) {
              session._firstAudioLogged = true;
              console.log(`[${reqId}] 🔊 FIRST audio out: ${Date.now() - session.startTime}ms after START`);
            }
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
        if (t && !isNoiseTranscription(t)) {
          session._pendingCustomerText += (session._pendingCustomerText ? ' ' : '') + t;
          // Real speech arrived — cancel the noise-resume timer so we don't
          // re-engage the agent while the customer is mid-turn.
          clearTimeout(session._noiseResumeTimer);
        }
      }
      if (sc.outputTranscription) {
        const t = (sc.outputTranscription.text || '').trim();
        if (t) session._pendingAiText += (session._pendingAiText ? ' ' : '') + t;
      }
      if (sc.turnComplete) {
        session.isSpeaking = false;
        // Flush the carried mu-law tail (pad ONLY this final frame) so the last few ms
        // of the utterance are played — there is no next part to prepend it to.
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
        session.isSpeaking = false;
        // Flush queued AI frames + carried tail so barge-in stops old audio immediately.
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
        // ── NOISE-RESUME GUARD ──────────────────────────────────────────────────
        // PROBLEM: clientContent{turnComplete} was used here but it freezes Gemini's
        // internal state machine — Gemini neither responds NOR processes subsequent
        // audio for up to 60+ seconds (confirmed in call transcripts).
        //
        // NEW STRATEGY:
        // • Wait 7s (customer typically responds within 2-3s, noise stops in <1s)
        // • Only fire if no caller audio was forwarded in the last 4s (customer silent)
        // • Use realtimeInput.text('Continue.') — a safe nudge that works in any
        //   Gemini state without corrupting the conversation state machine.
        clearTimeout(session._noiseResumeTimer);
        session._noiseResumeTimer = setTimeout(() => {
          // Guard 1: agent must not already be speaking
          if (session.isSpeaking) return;
          // Guard 2: no caller audio forwarded in last 4s means customer isn't speaking
          const noRecentCallerAudio = !session._lastCallerAudioSentAt ||
            (Date.now() - session._lastCallerAudioSentAt) > 4000;
          if (!noRecentCallerAudio) return; // customer is mid-speech, do not interrupt
          // Guard 3: Gemini WebSocket must be alive
          if (geminiSocket?.readyState !== WebSocket.OPEN) return;
          console.log(`[${reqId}] 🔇 Noise-resume: no customer audio in 4s — nudging agent to continue`);
          // 'Continue.' is safe — the system prompt governs the response.
          // It does NOT corrupt the state machine unlike clientContent{turnComplete}.
          sendToGemini({ realtimeInput: { text: 'Continue.' } });
        }, 7000);
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

  // Fires the opening greeting only once BOTH the Gemini handshake (setupComplete)
  // AND the agent-config load have completed — regardless of arrival order. This is
  // the fix for the first-response stall: previously the greeting was only attempted
  // inside setupComplete, so when config finished AFTER setup, nothing re-triggered it
  // and the AI waited (silently) for the customer to speak first → ~6-8s of dead air.
  function maybeGreet() {
    if (session._greeted) return;
    if (!session.geminiReady || !session._agentConfigReady) return;
    triggerGreeting();
  }

  function triggerGreeting() {
    session._greeted = true;  // mark immediately — guards against re-greeting on reconnect
    console.log(`[${reqId}] 👋 Greeting triggered: ${Date.now() - session.startTime}ms after START`);
    const g = session.greetingMessage || '';
    if (g) {
      session.transcript.push({ speaker: 'AI', text: g });
      sendToGemini({ realtimeInput: { text: `Say: ${g}` } });
    } else {
      sendToGemini({ realtimeInput: { text: 'Greet briefly.' } });
    }
  }

  // ─── PACED mu-law sender to Smartflo (jitter-buffer-safe) ───
  // ROOT-CAUSE FIX for voice breaking + high ROS: Gemini emits long audio parts
  // in bursts. Sending every 160-byte frame synchronously in a tight loop floods
  // Smartflo's jitter buffer → buffer overflow → dropped frames → choppy/broken
  // voice. We now ENQUEUE 20ms (160-byte) frames and drain them on a real-time
  // 20ms metronome, so audio leaves at exactly the rate the phone consumes it.
  session._outQueue = [];
  session._outPumping = false;
  function startOutPump() {
    if (session._outPumping) return;
    session._outPumping = true;
    // Drift-corrected pacing: setTimeout always fires LATE (timer + event-loop lag),
    // so draining exactly 1 frame per tick feeds Smartflo SLOWER than real-time → its
    // jitter buffer starves → underrun gaps = crackle/noise. Instead we track a virtual
    // playback clock and release however many 20ms frames the elapsed wall-clock has
    // "earned" since the last tick — so average output rate stays exactly real-time.
    session._nextFrameDue = Date.now();
    const FRAME_MS = 20;
    const pump = () => {
      if (session._callEnded || smartfloSocket.readyState !== WebSocket.OPEN || !session.streamSid) {
        session._outPumping = false;
        return;
      }
      const now = Date.now();
      // Release every frame whose scheduled play-time has passed (catch up if late).
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
        // Sleep until the next frame is due (never negative).
        const wait = Math.max(0, session._nextFrameDue - Date.now());
        setTimeout(pump, wait);
      } else {
        // Queue drained — reset clock so the next burst starts paced from "now".
        session._nextFrameDue = Date.now();
        session._outPumping = false;
        // Mark when the last agent audio frame left the server. The echo guard
        // in the media handler uses this to suppress caller audio for 350ms
        // (echo round-trip decay window) so the agent's own voice doesn't
        // bounce back through the phone line and trigger a false barge-in.
        session._lastAgentAudioEndedAt = Date.now();
      }
    };
    pump();
  }
  function sendMulawToSmartflo(mulawBytes) {
    if (smartfloSocket.readyState !== WebSocket.OPEN || !session.streamSid) return;
    if (!session._firstSendLogged) {
      session._firstSendLogged = true;
      const sinceStart = Date.now() - session.startTime;
      const sinceFirstMedia = session._firstInboundMediaTs ? (Date.now() - session._firstInboundMediaTs) : -1;
      console.log(`[${reqId}] 📡 FIRST audio SENT to Smartflo: ${sinceStart}ms after START, ${sinceFirstMedia}ms after first inbound media`);
    }
    // Split into 160-byte (20ms) frames and enqueue; the metronome paces the send.
    // SPEC FIX (Smartflo §3.1: payload must be a multiple of 160 bytes or audio gaps
    // occur): Gemini audio parts rarely divide evenly by 160. Instead of padding the
    // tail with 0x7F silence (which injected a tiny SILENCE GAP between every part →
    // the "breaking/noisy" voice), we CARRY the leftover <160 bytes to the FRONT of the
    // next part so every frame sent is a true 160-byte continuation of real audio.
    const FRAME = 160;
    let buf = session._outTail && session._outTail.length
      ? (() => { const m = new Uint8Array(session._outTail.length + mulawBytes.length); m.set(session._outTail, 0); m.set(mulawBytes, session._outTail.length); return m; })()
      : mulawBytes;
    let i = 0;
    for (; i + FRAME <= buf.length; i += FRAME) {
      session._outQueue.push(buf.slice(i, i + FRAME));
    }
    // Keep the remainder (real audio, not silence) for the next part.
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
    // Cross-engine aliases (Azure Realtime → closest Gemini equivalent)
    const map = { 'alloy': 'Puck', 'shimmer': 'Kore', 'echo': 'Charon', 'ash': 'Fenrir', 'coral': 'Aoede', 'sage': 'Kore', 'ballad': 'Aoede', 'verse': 'Puck', 'marin': 'Kore', 'cedar': 'Charon' };
    if (map[v]) return map[v];
    const female = ['neerja', 'ananya', 'swara', 'jenny', 'aria', 'sonia', 'ava', 'emma'];
    if (female.some(n => v.includes(n))) return 'Kore';
    if (v.includes('neural') || v.includes('dragon')) return v.includes('female') ? 'Kore' : 'Charon';
    return fallback;
  }

  // ─── Outbound config: match by call_sid or strict phone (callee+caller) ───
  async function loadAgentConfig() {
    const t0 = Date.now();
    try {
      const svc = await getSvc();
      let callLog = null;
      const cutoff = new Date(Date.now() - 120000).toISOString();

      // ─── Phase 1: O(1) direct lookup via custom parameter ───
      // If initiateCall/campaignPoller passed call_log_id through Smartflo's custom
      // fields, resolve the CallLog directly — no phone scan needed (~50ms vs ~1s).
      // Campaign dials (Option A) write the CallLog to POSTGRES ONLY (never mirrored
      // to Base44), so we check Postgres FIRST. This avoids the guaranteed-to-fail
      // Base44 .get() that spammed noisy 404 errors on every campaign call. Only if
      // PG misses do we fall back to Base44 (covers non-campaign initiateCall dials).
      if (session._customCallLogId) {
        const pgLog = await pgGetCallLogById(session._customCallLogId);
        if (pgLog) {
          callLog = pgLog;
          // Mark this as a Postgres-only (Option-A campaign) CallLog so saveCallRecord
          // finalizes directly in PG and skips the Base44 .get() that would 404 + spam
          // the error log for every campaign call.
          session._pgOnlyCallLog = true;
          console.log(`[${reqId}] ⚡ O(1) match via POSTGRES: ${callLog.id} (${Date.now() - t0}ms)`);
        }
        if (!callLog) {
          const direct = await svc.entities.CallLog.get(session._customCallLogId).catch(() => null);
          if (direct) {
            callLog = direct;
            console.log(`[${reqId}] ⚡ O(1) match via customParameters: ${callLog.id} (${Date.now() - t0}ms)`);
          } else {
            console.log(`[${reqId}] ⚠️ customCallLogId ${session._customCallLogId} not found in PG or Base44`);
          }
        }
      }

      if (!callLog && session.callSid) {
        try { const logs = await svc.entities.CallLog.filter({ call_sid: session.callSid }); if (logs.length) callLog = logs[0]; } catch (_) {}
        if (!callLog) {
          const d = session.callSid.replace(/\D/g, '');
          if (d && d.length > 5 && d !== session.callSid) {
            try { const logs = await svc.entities.CallLog.filter({ call_sid: d }); if (logs.length) callLog = logs[0]; } catch (_) {}
          }
        }
      }

      if (!callLog) {
        const cc = session.calleeNumber?.replace(/\D/g, '').slice(-10) || '';
        const ca = session.callerNumber?.replace(/\D/g, '').slice(-10) || '';
        if (cc && ca) {
          try {
            // Resolve by phone — CallLog.call_sid never matches the media-stream
            // SID (Smartflo reports a different id than its REST call_id). We can't
            // filter by callee_number directly because formats vary (+91 vs raw),
            // so we pull recent outbound calls and match on last-10-digits in JS.
            // The matching CallLog was created seconds ago (status ringing/initiated)
            // so it's always at the very top — 8 rows is more than enough and keeps
            // the payload small (each row carries a heavy agent_config_cache).
            // PRIMARY: query the DB directly by callee_number (last-10) so heavy
            // concurrent dialing can NEVER bury the row out of a small "recent" window
            // — the previous 4-row scan dropped calls under load and fell back to the
            // generic prompt. We try the two most common stored formats (+91XXXXXXXXXX
            // and raw 10-digit). If both miss (format variance), fall back to a WIDE
            // recent scan (30 rows) and match in JS.
            let recent = [];
            const fetchBy = async (filter, limit) => {
              for (let attempt = 0; attempt < 2; attempt++) {
                try { return await svc.entities.CallLog.filter(filter, '-created_date', limit); }
                catch (e) {
                  if (attempt === 0 && /rate limit|429/i.test(e.message || '')) {
                    await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 300)));
                    continue;
                  }
                  return [];
                }
              }
              return [];
            };
            // Direct callee-number lookups (cheap, indexed, concurrency-proof).
            const byCallee = [
              ...await fetchBy({ direction: 'outbound', callee_number: `+91${cc}` }, 8),
              ...await fetchBy({ direction: 'outbound', callee_number: cc }, 8),
            ];
            if (byCallee.length) {
              recent = byCallee;
            } else {
              // Last-resort wide scan — match callee in JS across more rows so
              // concurrency can't bury the target (was 4, now 30).
              recent = await fetchBy({ direction: 'outbound' }, 30);
            }
            const pool = (Array.isArray(recent) ? recent : []).filter(x =>
              !x.stream_sid &&
              x.created_date >= cutoff &&
              ['ringing', 'initiated'].includes(x.status) &&
              (x.callee_number || '').replace(/\D/g, '').slice(-10) === cc
            );
            // DID-strict resolution: only attribute to a CallLog whose caller_id (the
            // agent's DID) ALSO matches this stream's DID. This prevents cross-agent
            // misattribution on shared-DID tenants (e.g. two agents dialing the same
            // number in the same window) — previously we fell back to pool[0] (newest)
            // and could stamp the call with the wrong agent.
            // Resolve the matching CallLog for this callee. The pool already filters
            // to fresh (<120s) ringing/initiated outbound calls to THIS callee, so in
            // practice there is exactly one. We pick the newest (pool[0], already sorted
            // by -created_date) as the base, then use the agent DID purely as a TIE-BREAKER
            // when more than one candidate exists.
            // IMPORTANT: do NOT require a DID match to attribute — on outbound Smartflo
            // the stream's `from` is the customer/trunk number, not the agent DID, so a
            // DID-strict requirement wrongly drops to the generic default prompt.
            if (pool.length === 1) {
              callLog = pool[0];
            } else if (pool.length > 1) {
              // Multiple candidates → prefer the one whose agent DID matches; else newest.
              const didMatch = pool.find(x => ca && (x.caller_id || '').replace(/\D/g, '').slice(-10) === ca);
              callLog = didMatch || pool[0];
              console.log(`[${reqId}] ℹ️ Multiple phone matches (pool=${pool.length}) — picked ${didMatch ? 'DID-match' : 'newest'}: ${callLog.id}`);
            }
            if (callLog) console.log(`[${reqId}] ⚡ Fast phone match: ${callLog.id} (${Date.now() - t0}ms)`);
          } catch (_) {}
        }
      }

      if (!callLog) { console.log(`[${reqId}] ⚠️ No call log — default prompt`); return; }

      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      // Load this client's sendable WhatsApp media (PDFs/images) in the BACKGROUND
      // (fire-and-forget) so it NEVER blocks the greeting / initial response. Media
      // is only needed later if the customer asks for it mid-call.
      if (session.clientId) {
        svc.entities.MediaAsset.filter({ client_id: session.clientId, is_active: true }, '-created_date', 25)
          .then(assets => {
            session._mediaAssets = (assets || []).filter(a => a.file_url && a.intent);
            if (session._mediaAssets.length) console.log(`[${reqId}] 📎 ${session._mediaAssets.length} WhatsApp media asset(s) available`);
          })
          .catch(() => {});
      }
      const cache = callLog.agent_config_cache || {};
      // Capture agent_id so loadKBLazy can fetch KB docs from DB if blob is missing
      session._agentId = cache.agent_id || callLog.agent_id || null;

      // SLIM cache path
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
      }
      // Legacy cache
      else if (cache.system_prompt) {
        // FIX: Do NOT inject KB content inline into the prompt. This caused the
        // AI to answer from a stale/truncated copy and skip the search_knowledge_base
        // tool entirely. Strip any "KNOWLEDGE BASE" heading and force tool use instead.
        let p = cache.system_prompt;
        const kbR = /\n+(?:[-=]{2,}\s*)?KNOWLEDGE BASE[^\n]*[\s\S]*?(?=\n\n---|\n\n##|$)/i;
        p = p.replace(kbR, '').trim();
        session.systemPrompt = p;
        session._leadId = callLog.lead_id || null;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (session.systemPrompt.includes('SHOPIFY')) session.hasShopify = true;
        if (session.systemPrompt.includes('UNICOMMERCE')) session.hasUniCommerce = true;
        // Flag KB as available so the tool is registered — content loads lazily from blob/DB.
        if (cache.knowledge_base_content || callLog.agent_id) {
          session._toolFlags = { ...(session._toolFlags || {}), has_kb: true };
        }
      }

      session.voiceType = mapVoice(cache.persona?.voice_type, 'Puck');
      // Capture the FULL persona (language/accent + tone) so the persona lock in
      // sendGeminiSetup can enforce the agent's configured accent (e.g. Indian English).
      session.persona = cache.persona || {};

      // Vaani Sales AI gets the book_demo tool. Detect by agent name/id.
      // NON-BLOCKING: this extra Agent.get used to run inline and delay
      // _agentConfigReady (→ the greeting) by a full round-trip. The essential
      // config (prompt, voice, greeting) is already set above, so resolve the
      // book_demo flag in the BACKGROUND instead of stalling the opening line.
      if (session._agentId) {
        svc.entities.Agent.get(session._agentId)
          .then(ag => {
            _agentRecord = ag; // cache so loadKBLazy reuses it (avoids a 2nd identical fetch)
            if (ag && (ag.name || '').toLowerCase().includes('vaani sales')) {
              session._toolFlags = { ...(session._toolFlags || {}), can_book_demo: true };
              console.log(`[${reqId}] 🎯 book_demo tool enabled for Vaani Sales agent`);
            }
          })
          .catch(() => {});
      }

      // Skip the Base44 update for PG-only (Option-A campaign) CallLogs — the row
      // doesn't exist in Base44, so this would 404 + spam the error log. Write the
      // stream_sid to Postgres instead so post-call matching still works.
      const upd = {};
      if (session.streamSid) upd.stream_sid = session.streamSid;
      if (session.callSid && callLog.call_sid !== session.callSid) upd.call_sid = session.callSid;
      if (Object.keys(upd).length) {
        if (session._pgOnlyCallLog) {
          _openPg().then(async (pg) => {
            try {
              await pg.queryObject`UPDATE call_logs SET stream_sid = ${session.streamSid || null}, updated_at = now() WHERE id = ${callLog.id}`;
            } finally { try { ; /* pg.end() not needed */ } catch (_) {} }
          }).catch(() => {});
        } else {
          svc.entities.CallLog.update(callLog.id, upd).catch(() => {});
        }
      }

      console.log(`[${reqId}] ✅ OUTBOUND ready in ${Date.now() - t0}ms: voice=${session.voiceType}, prompt=${session.systemPrompt.length}ch`);
    } catch (e) { console.error(`[${reqId}] ❌ Config err: ${e.message}`); }
  }

  connectGemini();
  // Warm the Base44 SDK connection in parallel with the Gemini handshake, during the
  // idle gap before Smartflo's `start` frame arrives. Cuts the phone-lookup latency
  // from ~1s (cold) to ~50ms (warm) without blocking call setup.
  warmSvc();
  // PG connection is warmed at MODULE LEVEL (see getWarmPg() call after its
  // definition) so the TLS handshake completes between calls, not on the
  // critical path. We still nudge it here in case this is the very first call
  // on a fresh isolate and module warm-up is mid-flight — harmless if already warm.
  getWarmPg().catch(() => {});

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
        // ─── Phase 1: O(1) call resolution via custom parameters ───
        // initiateCall passes our CallLog id as `custom_identifier` — the ONLY
        // field Smartflo officially echoes back into the start frame. Read it
        // (plus legacy aliases as harmless fallbacks) so loadAgentConfig can do a
        // direct get() instead of scanning recent CallLogs by phone number.
        const cp = sd.customParameters || {};
        session._customCallLogId = cp.custom_identifier || cp.call_log_id || cp.custom_field_1 || cp.cf1 || '';
        console.log(`[${reqId}] 📞 START outbound: callee=${session.calleeNumber}, caller(DID)=${session.callerNumber}, customCallLogId=${session._customCallLogId || 'none'} | WS-open→start gap=${Date.now() - _wsOpenTs}ms`);
        session._lastUpsampleValue = 0; session._lastDownsampleRemainder = [];
        session._upPrev1 = null; session._upPrev2 = null;

        loadAgentConfig().then(async () => {
          // ── LATENCY FIX ── If the FIRST pass already resolved the agent, mark ready
          // and fire the Gemini setup + greeting IMMEDIATELY. Do NOT wait on the retry
          // loop. Previously the Gemini handshake was serialized AFTER config (incl. its
          // up-to-1.5s retry sleeps), so a single slow/missed first lookup pushed the
          // first response to ~7s even though the happy path is sub-second.
          if (session.callLogId) {
            session._agentConfigReady = true;
            if (session.geminiWs?.readyState === WebSocket.OPEN && !session.geminiReady) sendGeminiSetup();
            maybeGreet();
            if (session._toolFlags?.has_kb || session._kbFileUri || session._agentId) loadKBLazy().catch(() => {});
            return;
          }
          // First pass missed (CallLog mirror lagged behind the stream). Retry a few
          // times with a SHORT sleep — but the moment a retry resolves, fire setup+greet.
          for (let i = 0; i < 3 && !session.callLogId; i++) {
            await new Promise(r => setTimeout(r, 250));
            await loadAgentConfig();
          }
          if (!session.callLogId) {
            console.error(`[${reqId}] ⛔ Agent config unresolved after retries — using default prompt (generic agent)`);
          }
          session._agentConfigReady = true;
          if (session.geminiWs?.readyState === WebSocket.OPEN && !session.geminiReady) sendGeminiSetup();
          maybeGreet();
          if (session._toolFlags?.has_kb || session._kbFileUri || session._agentId) loadKBLazy().catch(() => {});
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        if (!session._firstInboundMediaTs) {
          session._firstInboundMediaTs = Date.now();
          console.log(`[${reqId}] 🎧 FIRST inbound media (caller audio LIVE): ${session._firstInboundMediaTs - session.startTime}ms after START`);
        }
        const raw = atob(msg.media.payload);
        const m = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) m[i] = raw.charCodeAt(i);
        const b64 = mulawToBase64PCM16_16k(m, session);
        if (!session.geminiReady) {
          if (session._audioBuffer.length < 200) session._audioBuffer.push(b64);
          return;
        }
        // ── ECHO GUARD ──────────────────────────────────────────────────────────────
        // The agent's audio is played to the caller via Smartflo. The phone line
        // reflects that audio back to us as "caller media" (sidetone / line echo).
        // If we forward this echo to Gemini while the agent is still speaking,
        // Gemini's VAD detects it as the caller interrupting → sc.interrupted fires
        // → agent audio queue is cleared → agent goes silent mid-sentence.
        //
        // Guard: drop caller audio frames while the agent is currently speaking OR
        // within 350ms of the last agent frame being pumped out (echo tail window).
        // 350ms covers the round-trip echo latency on Indian phone networks.
        // After 350ms of agent silence the caller's genuine speech is forwarded normally.
        const ECHO_TAIL_MS = 350;
        const agentPlaying = session.isSpeaking || (session._outQueue?.length > 0);
        const echoTail = session._lastAgentAudioEndedAt &&
          (Date.now() - session._lastAgentAudioEndedAt) < ECHO_TAIL_MS;
        if (agentPlaying || echoTail) return; // echo window — drop this frame
        // ────────────────────────────────────────────────────────────────────────────
        sendToGemini({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
        // Track the last time caller audio was forwarded — used by the noise-resume
        // timer to distinguish "customer is still speaking" from "silent after noise".
        session._lastCallerAudioSentAt = Date.now();
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
    // NOTE: do NOT close the warm PG connection here — Deno reuses this isolate
    // for the next call, and keeping the connection alive lets the next call's
    // lookup stay warm (~20ms). A dropped/stale connection self-heals via the
    // fallback path in pgGetCallLogById.
  };
  smartfloSocket.onerror = () => { if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close(); };

  return response;

};