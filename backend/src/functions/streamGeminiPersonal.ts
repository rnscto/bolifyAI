import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";
// ═══════════════════════════════════════════════════════════════════════
// streamGeminiPersonal — Personal AI Assistant flow ONLY (Gemini Live)
// ═══════════════════════════════════════════════════════════════════════
// Phase 1 of the multi-channel split. Handles:
//   - Inbound calls to a personal-account DID (call screening)
//   - Outbound calls placed BY the personal AI assistant
// Business / campaign / screening flows continue on streamAudioGemini.
//
// Key differences vs streamAudioGemini:
//   - SDK module pre-warmed at isolate cold-start to avoid mid-call freezes
//   - Cached service-role client (single import per session, reused for tools)
//   - Noise transcription filter (drops Gemini hallucinations from background hiss)
//   - No e-commerce / no campaign / no screening / no KB tooling
//   - Strict personal-mode prompt (trusted contacts, owner-reachable / DND modes)
// ═══════════════════════════════════════════════════════════════════════

// ─── Audio Conversion Helpers (mu-law 8kHz ↔ PCM16 16/24kHz) ───
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
  const buffer = new Uint8Array(pcm16k.length * 2);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < pcm16k.length; i++) view.setInt16(i * 2, pcm16k[i], true);
  return uint8ToBase64(buffer);
}

function base64PCM16_24kToMulaw(base64Pcm16, session) {
  // 3:1 downsample (24kHz → 8kHz) with a GENTLE triangular low-pass [0.25,0.5,0.25]
  // — a smooth anti-alias filter with NO negative side-lobes, so it removes aliasing
  // WITHOUT the ringing/distortion a sharp sinc FIR adds on loud speech.
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
    const f = Math.round(allSamples[idx] * 0.25 + allSamples[idx + 1] * 0.5 + allSamples[idx + 2] * 0.25);
    mulaw[i] = encodeMulaw(Math.max(-32768, Math.min(32767, f)));
  }
  const consumed = downsampledLen * 3;
  session._lastDownsampleRemainder = [];
  for (let i = consumed; i < totalSamples; i++) session._lastDownsampleRemainder.push(allSamples[i]);
  return mulaw;
}

function uint8ToBase64(bytes) {
  // Chunked btoa — avoids huge string concat that stalls the event loop on every frame
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

// ═══════════════════════════════════════════════════════════════════════
// COLD-START OPTIMIZATIONS — pre-warm SDK + filler audio at module load
// ═══════════════════════════════════════════════════════════════════════
// Without these, the first SDK import inside a tool call mid-conversation
// can take 300-1500ms on a cold isolate, causing dead-air freezes.
let _sdkModulePromise = null;
function getSDKModule() {
  if (!_sdkModulePromise) _sdkModulePromise = import('npm:@base44/sdk@0.8.31');
  return _sdkModulePromise;
}
getSDKModule().catch(() => {}); // kick off at module load

// ─── Pre-warmed filler audio cache (cold-start hider) ───
// Azure Blob URI (Phase 3 — moved off Base44 storage to avoid integration credits).
const FILLER_URI = 'azblob://vaani-private/filler/filler_hello_1778132145341.mulaw';
let _fillerCache = null;
let _fillerLoadPromise = null;

async function loadFillerFromStorage(uri, label) {
  try {
    const { BlobServiceClient } = await import('npm:@azure/storage-blob@12.17.0');
    const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    if (!conn) return null;
    const path = uri.replace('azblob://', '');
    const slash = path.indexOf('/');
    const container = path.substring(0, slash);
    const blobName = path.substring(slash + 1);
    const svc = BlobServiceClient.fromConnectionString(conn);
    const blob = svc.getContainerClient(container).getBlockBlobClient(blobName);
    const buf = new Uint8Array(await blob.downloadToBuffer());
    console.log(`[filler] Loaded ${label}: ${buf.length} bytes`);
    return buf;
  } catch (e) {
    console.error(`[filler] load error: ${e.message}`);
    return null;
  }
}

async function getFillerAudio() {
  if (_fillerCache) return _fillerCache;
  if (!_fillerLoadPromise) _fillerLoadPromise = loadFillerFromStorage(FILLER_URI, 'hello');
  _fillerCache = await _fillerLoadPromise;
  return _fillerCache;
}

// NOTE: NO module-load pre-warm — wastes integration credits on cold starts.

// ═══════════════════════════════════════════════════════════════════════
// PERSONA LOCK — enforce the agent's configured accent (e.g. Indian English).
// persona.language was previously loaded but never sent to Gemini → US accent.
// ═══════════════════════════════════════════════════════════════════════
const GEMINI_FEMALE_VOICES_P = new Set(['aoede','kore','leda','autonoe','callirrhoe','despina','erinome','laomedeia','pulcherrima','vindemiatrix','achernar','gacrux','sulafat','zephyr']);
const LANG_LABEL_P = {
  'en-in': 'Indian English (Indian accent)',
  'hi-in': 'Hindi (natural Indian pronunciation)',
  'en-us': 'US English (American accent)',
  'en-gb': 'British English (UK accent)',
  'bilingual': 'natural Hinglish — Hindi + Indian-accent English',
  'mr-in': 'Marathi (natural Indian pronunciation)',
};
function buildPersonaLock(persona) {
  const p = persona || {};
  const lang = String(p.language || 'hi-in').toLowerCase();
  const isFemale = GEMINI_FEMALE_VOICES_P.has(String(p.voice_type || '').toLowerCase());
  const lines = [
    `• ACCENT/LANGUAGE: Speak in ${LANG_LABEL_P[lang] || LANG_LABEL_P['hi-in']}. This accent is FIXED — never drift to a US/American accent.`,
    isFemale
      ? `• You have a FEMALE voice — use feminine Hindi verb forms (kar rahi hoon, bol rahi hoon).`
      : `• You have a MALE voice — use masculine Hindi verb forms (kar raha hoon, bol raha hoon).`,
  ];
  if (p.tone) lines.push(`• TONE: Stay ${p.tone} throughout.`);
  return lines.join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════════════════════
// NOISE TRANSCRIPTION FILTER
// ═══════════════════════════════════════════════════════════════════════
// Gemini sometimes hallucinates random foreign-language phrases from background
// hiss/echo on quiet calls. These pollute the transcript AND trick the AI into
// trying to "respond" to nonsense, causing dead-air freezes.
// Returns true → drop the chunk (not added to transcript, not sent as a turn).
function isNoiseTranscription(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length <= 4 && /^(uh|um|mhm|hmm|eh|oh|ah)\.?$/i.test(t)) return true;
  if (/[\u0400-\u04FF\u0E00-\u0E7F\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(t)) return true;
  if (!/[a-zA-Z\u0900-\u097F]/.test(t)) return true;
  if (/[¿¡]/.test(t)) return true;
  if (t.length < 80 && /[àâäçéèêëîïôöûùüÿñõãáíóú]/i.test(t)) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// SAVE CALL RECORD — personal-only (voicemail + Telegram summary)
// ═══════════════════════════════════════════════════════════════════════
async function saveCallRecord(session, reqId, duration) {
  if (!session.callLogId || session._saved) return;
  session._saved = true;

  try {
    if (session._pendingCustomerText) {
      session.transcript.push({ speaker: 'Customer', text: session._pendingCustomerText.trim() });
      session._pendingCustomerText = '';
    }
    if (session._pendingAiText) {
      session.transcript.push({ speaker: 'AI', text: session._pendingAiText.trim() });
      session._pendingAiText = '';
    }
    const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');

    const { createClient } = await getSDKModule();
    const svc = base44;;

    // AI analysis via Azure OpenAI
                    let summary = '', summaryHindi = '', sentiment = 'neutral', category = 'unknown', urgency = 'medium';
    if (transcript.trim().length > 30 && baseUrl && deployment && apiKey) {
      try {
        const r = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
          method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'Personal AI call screening analyst. Classify the call and summarize. Respond ONLY in valid JSON.' },
              { role: 'user', content: `Transcript:\n${transcript}\n\nReturn JSON:\n{"summary":"2-3 sentence summary","summary_hindi":"Same in Devanagari","category":"family|business|promotional|spam|unknown","urgency":"low|medium|high|urgent","sentiment":"very_positive|positive|neutral|negative|very_negative"}` }
            ], max_completion_tokens: 500, response_format: { type: 'json_object' }
          })
        });
        if (r.ok) {
          const a = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
          summary = a.summary || '';
          summaryHindi = a.summary_hindi || '';
          category = a.category || 'unknown';
          urgency = a.urgency || 'medium';
          sentiment = a.sentiment || 'neutral';
        }
      } catch (e) { console.error(`[${reqId}] AI analysis err: ${e.message}`); }
    } else {
      summary = 'Call ended with minimal conversation.';
    }

    const enriched = summary ? `${summary}${summaryHindi ? '\n\n🇮🇳 ' + summaryHindi : ''}\n\n---\nCategory: ${category} | Urgency: ${urgency}` : '';

    const currentLog = await svc.entities.CallLog.get(session.callLogId);
    const wasTerminal = ['completed', 'failed', 'no_answer'].includes(currentLog?.status);
    const callLogUpdate = {
      ...(wasTerminal ? {} : { status: 'completed', call_end_time: new Date().toISOString() }),
      transcript: transcript || '',
      duration,
      ...(enriched ? { conversation_summary: enriched } : {})
    };
    // ── POSTGRES-PRIMARY WRITE ── transcript + summary survive a Base44 429.
    try { await svc.functions.invoke('pgLeadSync', { call_log: { ...currentLog, ...callLogUpdate } }); }
    catch (pgErr) { console.error(`[${reqId}] ⚠️ PG-primary write failed: ${pgErr.message}`); }
    await svc.entities.CallLog.update(session.callLogId, callLogUpdate);
    console.log(`[${reqId}] 💾 Personal call saved: ${session.callLogId}, category=${category}`);

    // Save VoicemailMessage
    if (session._personalClientId) {
      try {
        const cPh = currentLog?.caller_id || session.callerNumber || '';
        const callerName = (session._isTrustedCaller && session._trustedContactName) ? session._trustedContactName : '';
        await svc.entities.VoicemailMessage.create({
          client_id: session._personalClientId,
          call_log_id: session.callLogId,
          caller_number: cPh,
          caller_name: callerName,
          message: summary || transcript.substring(0, 1000),
          urgency, category, is_read: false
        });

        // Telegram post-call summary
        const tgTk = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgTk) {
          const pCl = await svc.entities.Client.get(session._personalClientId);
          if (pCl?.telegram_connected && pCl?.telegram_chat_id && !pCl.dnd_enabled && pCl.owner_notification_channel === 'telegram') {
            const emj = category === 'spam' ? '🚫' : category === 'family' ? '👨‍👩‍👧' : category === 'business' ? '💼' : '📋';
            const fresh = await svc.entities.CallLog.get(session.callLogId);
            const recLine = fresh?.recording_url ? `\n\n🎧 <a href="${fresh.recording_url}">Play Recording</a>` : '';
            const hi = summaryHindi ? `\n\n🇮🇳 ${summaryHindi.substring(0, 300)}` : '';
            const fromLine = callerName ? `<b>${callerName}</b>${cPh ? `\n📞 ${cPh}` : ''}` : `<b>${cPh || 'Unknown'}</b>`;
            const text = `${emj} <b>Call Summary</b>\n\n📱 From: ${fromLine}\n📂 ${category}\n\n💬 ${summary.substring(0, 400)}${hi}${recLine}`;
            fetch(`https://api.telegram.org/bot${tgTk}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: pCl.telegram_chat_id, text, parse_mode: 'HTML', disable_web_page_preview: false })
            }).catch(() => {});
          }
        }
      } catch (e) { console.error(`[${reqId}] Voicemail save err: ${e.message}`); }
    }

    // Fetch recording later
    setTimeout(() => {
      svc.functions.invoke('fetchCallRecording', { call_log_id: session.callLogId }).catch(() => {});
    }, 20000);
  } catch (err) {
    console.error(`[${reqId}] ❌ Save failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════
export default async function streamGeminiPersonal(c: any) {
  const req = c.req.raw || c.req;
  const reqId = Math.random().toString(36).substring(2, 10);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  const isWebSocket = upgrade === 'websocket';
  console.log(`[${reqId}] 📨 ${req.method} (personal), ws=${isWebSocket}`);

  if (!isWebSocket) {
    const host = req.headers.get('host') || 'localhost';
    const protocol = req.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
    return c.json({ data: {
      status: 'ready',
      flow: 'personal',
      version: 'v1.0-gemini-personal',
      wss_url: `${protocol}://${host}/functions/streamGeminiPersonal`
    } }, 200);
  }

  let smartfloSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    smartfloSocket = upgraded.socket;
    response = upgraded.response;
  } catch (err) {
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  const session = {
    streamSid: null, callSid: null, callLogId: null, clientId: null,
    transcript: [], startTime: Date.now(),
    systemPrompt: 'You are a personal AI assistant.',
    greetingMessage: '', voiceType: 'Aoede',  // soft female voice for personal AI
    _saved: false, geminiWs: null, geminiReady: false,
    isSpeaking: false, tools: [],
    humanTransferNumber: '', enableAutoTransfer: true,
    _geminiReconnectAttempts: 0, _callEnded: false,
    _agentConfigReady: false, _transferInitiated: false,
    calleeNumber: '', callerNumber: '',
    persona: {},  // agent persona (language/accent + tone) — drives the accent lock
    _personalClientId: null, _ownerName: '',
    _isTrustedCaller: false, _trustedContactName: '',
    _ownerReachable: false,
    _midCallTgSent: false, _midCallChecking: false,
    _awaitingOwnerDecision: false,
    _lastUpsampleValue: 0, _lastDownsampleRemainder: [],
    _pendingAiText: '', _pendingCustomerText: '',
    _fillerStarted: false, _fillerPlaying: false, _fillerAborted: false,
    _audioBuffer: [],  // P0: queue customer audio during Gemini handshake
  };

  // Cached service-role client per session — avoids re-importing SDK on every tool call
  let _cachedSvc = null;
  async function getSvc() {
    if (_cachedSvc) return _cachedSvc;
    const { createClient } = await getSDKModule();
    _cachedSvc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    return _cachedSvc;
  }

  // ─── Filler audio playback ───
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
        if (chunk.length < 160) {
          const padded = new Uint8Array(160);
          padded.set(chunk); padded.fill(0xFF, chunk.length);
          chunk = padded;
        }
        smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
        await new Promise(r => setTimeout(r, 20));
      }
    } catch (_) {}
    finally { session._fillerPlaying = false; }
  }

  function stopFiller() {
    const wasPlaying = session._fillerPlaying;
    session._fillerAborted = true;
    if (wasPlaying && smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
      smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
  }

  // ─── Personal-only Gemini tools ───
  function buildGeminiTools() {
    const declarations = [
      {
        name: 'end_call',
        description: 'End the call. Use ONLY after caller has said goodbye, you have taken a message, or conversation naturally concluded. Say final goodbye BEFORE calling this tool.',
        parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }
      }
    ];
    if (session.humanTransferNumber && session.enableAutoTransfer) {
      declarations.push({
        name: 'transfer_to_human',
        description: 'Transfer the call to the owner when they have explicitly authorized it via Telegram instruction.',
        parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }
      });
    }
    session.tools = declarations;
    return declarations;
  }

  // ─── Tool execution ───
  async function executeToolCall(name, args) {
    console.log(`[${reqId}] 🔧 Tool: ${name}`);

    if (name === 'end_call') {
      const reason = args.reason || 'conversation_complete';
      session.transcript.push({ speaker: 'System', text: `[Call ended by AI: ${reason}]` });
      // Fire Smartflo hangup in parallel
      getSvc().then(svc => {
        svc.functions.invoke('disconnectCall', {
          call_sid: session.callSid,
          caller_number: session.callerNumber,
          callee_number: session.calleeNumber
        }).catch(() => {});
      });
      setTimeout(() => {
        session._callEnded = true;
        if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        saveCallRecord(session, reqId, duration).then(() => {
          if (smartfloSocket.readyState === WebSocket.OPEN) smartfloSocket.close();
        });
      }, 2000);
      return { success: true, message: 'Disconnecting call.' };
    }

    if (name === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const sfEmail = Deno.env.get('SMARTFLO_EMAIL');
        const sfPassword = Deno.env.get('SMARTFLO_PASSWORD');
        if (!sfEmail || !sfPassword) return { error: 'Transfer not configured' };
        const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: sfEmail, password: sfPassword })
        });
        const token = (await loginResp.json()).access_token;
        if (!token) return { error: 'Smartflo auth failed' };
        const tr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ type: 4, call_id: session.callSid, intercom: String(session.humanTransferNumber) })
        });
        const trData = await tr.json();
        if (!tr.ok) return { error: `Transfer failed: ${trData.message || tr.status}` };
        session._transferInitiated = true;
        session.transcript.push({ speaker: 'System', text: `[Call transferred to owner. Reason: ${args.reason || ''}]` });
        if (session.callLogId) {
          const svc = await getSvc();
          svc.entities.CallLog.update(session.callLogId, { transferred_to: `Owner intercom ${session.humanTransferNumber}` }).catch(() => {});
        }
        return { success: true, message: 'Transferring to owner.' };
      } catch (e) {
        return { error: e.message };
      }
    }

    return { error: `Unknown tool: ${name}` };
  }

  // ─── Connect to Gemini Live API (with auto FREE→PAID fallback on 429/quota) ───
  function isQuotaCloseEvt(e) {
    if (!e) return false;
    if (e.code === 1011 || e.code === 1008) return true;
    const r = (e.reason || '').toLowerCase();
    return r.includes('quota') || r.includes('resource_exhausted') || r.includes('429') || r.includes('rate limit');
  }
  function connectGemini() {
    const freeKey = Deno.env.get('GEMINI_API_KEY');
    const paidKey = Deno.env.get('GEMINI_API_KEY_PAID');
    if (!freeKey && !paidKey) { console.error(`[${reqId}] Missing GEMINI_API_KEY`); return; }
    if (!freeKey) session._usingPaidKey = true;
    const apiKey = session._usingPaidKey ? paidKey : freeKey;
    console.log(`[${reqId}] 🔑 Connecting Gemini with ${session._usingPaidKey ? 'PAID' : 'FREE'} key`);
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      session._geminiReconnectAttempts = 0;
      if (session._agentConfigReady) sendGeminiSetup();
    };

    ws.onmessage = async (event) => {
      try {
        let text;
        if (typeof event.data === 'string') text = event.data;
        else if (event.data instanceof Blob) text = await event.data.text();
        else text = new TextDecoder().decode(event.data);
        handleGeminiMessage(JSON.parse(text));
      } catch (err) { console.error(`[${reqId}] Gemini parse: ${err.message}`); }
    };

    ws.onclose = (event) => {
      session.geminiReady = false;
      // Auto-fallback: FREE key exhausted → switch to PAID and reconnect immediately
      if (!session._usingPaidKey && !session._triedKeyFallback && paidKey && isQuotaCloseEvt(event) && !session._callEnded) {
        session._triedKeyFallback = true;
        session._usingPaidKey = true;
        console.log(`[${reqId}] ⚠️ FREE Gemini key hit quota → falling back to PAID key`);
        connectGemini();
        return;
      }
      const MAX = 3;
      if (!session._callEnded && session._geminiReconnectAttempts < MAX) {
        session._geminiReconnectAttempts++;
        setTimeout(() => { if (!session._callEnded) connectGemini(); }, session._geminiReconnectAttempts * 1500);
      }
    };
    ws.onerror = () => { console.error(`[${reqId}] Gemini WS error`); };
    session.geminiWs = ws;
  }

  function sendToGemini(msg) {
    if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.send(JSON.stringify(msg));
  }

  function sendGeminiSetup() {
    const tools = buildGeminiTools();
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
    const langLock = `[RULES]\n${buildPersonaLock(session.persona)}• Speak ONLY Hindi + English. NEVER Korean/Japanese/Chinese/Arabic/Thai/Spanish/Portuguese/French.\n• If transcription looks foreign, it is noise — IGNORE it, do NOT respond.\n• On unclear audio: ask caller to repeat. WAIT.\n`;
    const endR = `• end_call when CALLER signals they want to end: bye/namaste/dhanyavaad, message taken, OR Indian hang-up cues like "phone kaat do", "rakh do", "abhi baat nahi karni", "baad mein", "nahi chahiye", "call mat karo". Say a quick polite goodbye, THEN call end_call. Your own goodbye alone doesn't count. On silence → ask, never end.\n`;
    const time = `• Now: ${nowIST} IST.\n\n`;
    const fullPrompt = langLock + endR + time + session.systemPrompt;

    const setupMsg = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceType } } }
        },
        systemInstruction: { parts: [{ text: fullPrompt }] },
        // ── TURN-TAKING LATENCY FIX ── Tune server-side VAD to reply faster after
        // the caller stops talking, instead of the slow default end-of-speech wait.
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            silenceDurationMs: 400,
            prefixPaddingMs: 60
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };
    if (tools.length > 0) setupMsg.setup.tools = [{ functionDeclarations: tools }];
    sendToGemini(setupMsg);
    console.log(`[${reqId}] 📤 Setup sent: voice=${session.voiceType}, prompt=${fullPrompt.length}ch`);
  }

  function handleGeminiMessage(msg) {
    if (msg.setupComplete !== undefined) {
      session.geminiReady = true;
      if (session._agentConfigReady) triggerGreeting();
      // FLUSH handshake-buffered caller audio. On inbound screening the caller often
      // speaks during the ~1-2s handshake; discarding it made the AI miss their opening
      // words. Replay the buffered speech now (capped at ~3s in onmessage) so Gemini
      // hears it. The greeting was already triggered above.
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
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.mimeType?.includes('audio')) {
            stopFiller();
            session.isSpeaking = true;
            const mulawBytes = base64PCM16_24kToMulaw(part.inlineData.data, session);
            if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) sendMulawToSmartflo(mulawBytes);
          }
        }
      }
      // Input transcription with noise filter
      if (sc.inputTranscription) {
        const text = (sc.inputTranscription.text || '').trim();
        if (text && !isNoiseTranscription(text)) {
          session._pendingCustomerText += (session._pendingCustomerText ? ' ' : '') + text;
        }
      }
      if (sc.outputTranscription) {
        const text = (sc.outputTranscription.text || '').trim();
        if (text) session._pendingAiText += (session._pendingAiText ? ' ' : '') + text;
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
          console.log(`[${reqId}] 🗣️ Customer: "${t.substring(0, 200)}"`);
          session.transcript.push({ speaker: 'Customer', text: t });
          session._pendingCustomerText = '';
          // Mid-call Telegram: action buttons (when owner reachable) — fire on first qualifying turn
          if (session._personalClientId && session._ownerReachable && !session._midCallTgSent && !session._midCallChecking) {
            const c = session.transcript.filter(x => x.speaker === 'Customer').length;
            const min = session._isTrustedCaller ? 1 : 2;
            if (c >= min) checkCallerInfoAndNotify();
          }
          // Live transcript streaming to Telegram (every 2 customer turns AFTER buttons sent)
          if (session._personalClientId && session._midCallTgSent) {
            const c = session.transcript.filter(x => x.speaker === 'Customer').length;
            if (c % 2 === 0) sendLiveTranscriptUpdate();
          }
        }
        if (session._pendingAiText) {
          const t = session._pendingAiText.trim();
          console.log(`[${reqId}] 🤖 AI: "${t.substring(0, 200)}"`);
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
    if (msg.toolCall) {
      handleToolCalls(msg.toolCall.functionCalls || []);
    }
  }

  async function handleToolCalls(fcs) {
    const responses = [];
    for (const fc of fcs) {
      const result = await executeToolCall(fc.name, fc.args || {});
      responses.push({ id: fc.id, name: fc.name, response: result });
    }
    sendToGemini({ toolResponse: { functionResponses: responses } });
  }

  function triggerGreeting() {
    const g = session.greetingMessage || '';
    if (g) {
      session.transcript.push({ speaker: 'AI', text: g });
      sendToGemini({ realtimeInput: { text: `Say: ${g}` } });
    } else {
      sendToGemini({ realtimeInput: { text: 'Greet briefly as a personal AI assistant.' } });
    }
  }

  // ─── PACED mu-law sender to Smartflo (jitter-buffer-safe) ───
  // ROOT-CAUSE FIX for choppy/broken personal-call voice: the old fire-and-forget
  // burst sent every 960-byte chunk synchronously → flooded Smartflo's jitter
  // buffer → dropped frames → choppy audio. We now enqueue 20ms (160-byte) frames
  // and drain them on a drift-corrected 20ms metronome, exactly matching the
  // proven sender in streamGeminiIncoming/Outgoing → audio leaves at real-time rate.
  session._outQueue = [];
  session._outPumping = false;
  function startOutPump() {
    if (session._outPumping) return;
    session._outPumping = true;
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

  // ─── Load agent config (personal-only path) ───
  async function loadAgentConfig() {
    const t0 = Date.now();
    try {
      const svc = await getSvc();

      // Try outbound match first (call_sid or strict phone match)
      let callLog = null;
      if (session.callSid) {
        try {
          const logs = await svc.entities.CallLog.filter({ call_sid: session.callSid });
          if (logs.length > 0) callLog = logs[0];
        } catch (_) {}
      }
      const cutoff = new Date(Date.now() - 120000).toISOString();
      if (!callLog) {
        const cleanCallee = session.calleeNumber?.replace(/\D/g, '').slice(-10) || '';
        const cleanCaller = session.callerNumber?.replace(/\D/g, '').slice(-10) || '';
        if (cleanCallee && cleanCaller) {
          try {
            const [ringing, initiated] = await Promise.all([
              svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 10).catch(() => []),
              svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 10).catch(() => [])
            ]);
            const pick = (list) => (Array.isArray(list) ? list : []).find(l =>
              !l.stream_sid && l.created_date >= cutoff && l.direction === 'outbound' &&
              (l.callee_number||'').replace(/\D/g,'').slice(-10) === cleanCallee &&
              (l.caller_id||'').replace(/\D/g,'').slice(-10) === cleanCaller
            );
            callLog = pick(ringing) || pick(initiated);
          } catch (_) {}
        }
      }

      // Outbound personal call — config from CallLog cache
      if (callLog) {
        session.callLogId = callLog.id;
        session.clientId = callLog.client_id;
        session._personalClientId = callLog.client_id;
        const cache = callLog.agent_config_cache || {};
        session.systemPrompt = cache.core_prompt || cache.system_prompt || session.systemPrompt;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        // Map voice — all 30 prebuilt Gemini Live voices
        const v = (cache.persona?.voice_type || 'aoede').toLowerCase();
        const geminiVoices = ['achernar','achird','aoede','autonoe','callirrhoe','despina','erinome','kore','laomedeia','leda','pulcherrima','vindemiatrix','zephyr','algenib','algieba','alnilam','charon','enceladus','fenrir','gacrux','iapetus','orus','puck','rasalgethi','sadachbia','sadaltager','schedar','sulafat','umbriel','zubenelgenubi'];
        session.voiceType = geminiVoices.includes(v) ? v.charAt(0).toUpperCase() + v.slice(1) : 'Aoede';
        session.persona = cache.persona || {};  // accent/tone lock
        // Owner name for personal mode
        try {
          const cl = await svc.entities.Client.get(callLog.client_id);
          session._ownerName = cl?.company_name || '';
        } catch (_) {}
        // Claim
        const upd = {};
        if (session.streamSid) upd.stream_sid = session.streamSid;
        if (session.callSid && callLog.call_sid !== session.callSid) upd.call_sid = session.callSid;
        if (Object.keys(upd).length > 0) svc.entities.CallLog.update(callLog.id, upd).catch(() => {});
        console.log(`[${reqId}] ✅ OUTBOUND personal ready in ${Date.now()-t0}ms`);
        return;
      }

      // Inbound personal — DID → Agent → Client lookup
      const cands = [session.calleeNumber, session.callerNumber].filter(Boolean);
      let didAgent = null, didClient = null;
      for (const cand of cands) {
        if (didAgent) break;
        const cleanDID = cand.replace(/[^0-9]/g, '').slice(-10);
        if (!cleanDID) continue;
        const allDIDs = await svc.entities.DID.list('-created_date', 200);
        const matched = allDIDs.find(d => (d.number || '').replace(/\D/g, '').slice(-10) === cleanDID);
        if (matched?.agent_id) {
          const [a, c] = await Promise.all([
            svc.entities.Agent.get(matched.agent_id).catch(() => null),
            matched.client_id ? svc.entities.Client.get(matched.client_id).catch(() => null) : Promise.resolve(null)
          ]);
          if (a) { didAgent = a; didClient = c; break; }
        }
      }

      if (!didAgent || didClient?.account_type !== 'personal') {
        console.log(`[${reqId}] ⚠️ No personal-account agent matched — using default prompt`);
        return;
      }

      session.clientId = didClient.id;
      session._personalClientId = didClient.id;
      session._ownerName = didClient.company_name || '';
      if (didAgent.greeting_message) session.greetingMessage = didAgent.greeting_message;
      if (didAgent.human_transfer_number) session.humanTransferNumber = didAgent.human_transfer_number;
      else if (didClient.phone) session.humanTransferNumber = didClient.phone;
      if (didAgent.enable_auto_transfer === false) session.enableAutoTransfer = false;

      // Voice — all 30 prebuilt Gemini Live voices
      const vRaw = (didAgent.persona?.voice_type || 'aoede').toLowerCase();
      const geminiVoices = ['achernar','achird','aoede','autonoe','callirrhoe','despina','erinome','kore','laomedeia','leda','pulcherrima','vindemiatrix','zephyr','algenib','algieba','alnilam','charon','enceladus','fenrir','gacrux','iapetus','orus','puck','rasalgethi','sadachbia','sadaltager','schedar','sulafat','umbriel','zubenelgenubi'];
      session.voiceType = geminiVoices.includes(vRaw) ? vRaw.charAt(0).toUpperCase() + vRaw.slice(1) : 'Aoede';
      session.persona = didAgent.persona || {};  // accent/tone lock

      // Build personal-mode prompt (trusted contact lookup + screening script)
      await applyPersonalMode(svc, didClient, session.callerNumber);
      session.systemPrompt = (didAgent.system_prompt || 'You are a personal AI assistant.') + session.systemPrompt;

      // Create CallLog
      try {
        const newLog = await svc.entities.CallLog.create({
          client_id: didClient.id, agent_id: didAgent.id,
          call_sid: session.callSid || `inbound_${Date.now()}`,
          stream_sid: session.streamSid || null,
          caller_id: session.callerNumber || '', callee_number: session.calleeNumber,
          direction: 'inbound', status: 'answered', call_start_time: new Date().toISOString(),
          agent_config_cache: {
            agent_name: didAgent.name, system_prompt: session.systemPrompt,
            persona: didAgent.persona || {}, greeting_message: didAgent.greeting_message || '',
            flow_type: 'personal'
          }
        });
        if (newLog) session.callLogId = newLog.id;
      } catch (e) { console.error(`[${reqId}] CallLog create err: ${e.message}`); }

      // Initial Telegram heads-up
      if (didClient.telegram_connected && didClient.telegram_chat_id && !didClient.dnd_enabled && didClient.owner_notification_channel === 'telegram') {
        const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgT) {
          const nm = session._trustedContactName || session.callerNumber || 'Unknown';
          fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: didClient.telegram_chat_id, text: `📞 <b>Incoming Call</b>\n\n📱 From: <b>${nm}</b>\n\n💬 AI is screening — actions appear shortly...`, parse_mode: 'HTML' })
          }).catch(() => {});
        }
      }

      console.log(`[${reqId}] ✅ INBOUND personal ready in ${Date.now()-t0}ms: agent="${didAgent.name}", trusted=${session._isTrustedCaller}`);
    } catch (e) { console.error(`[${reqId}] ❌ Config err: ${e.message}`); }
  }

  // ─── Personal mode prompt builder (trusted contacts + owner-reachable / DND modes) ───
  async function applyPersonalMode(svc, ownerClient, callerPhone) {
    const aiMode = ownerClient.ai_response_mode || 'screen_all';
    const dndEnabled = ownerClient.dnd_enabled || false;
    const callerClean = (callerPhone || '').replace(/\D/g, '').slice(-10);

    const ownerReachable = !!(
      ownerClient.telegram_connected &&
      ownerClient.telegram_chat_id &&
      ownerClient.owner_notification_channel === 'telegram' &&
      !dndEnabled
    );
    session._ownerReachable = ownerReachable;

    const [trustedContacts, ownerStatuses] = await Promise.all([
      callerClean ? svc.entities.TrustedContact.filter({ client_id: ownerClient.id }).catch(() => []) : Promise.resolve([]),
      svc.entities.OwnerStatus.filter({ client_id: ownerClient.id, is_active: true }).catch(() => [])
    ]);

    let isTrusted = false, trustedName = '', rel = '', famRel = '';
    if (callerClean) {
      const m = trustedContacts.find(tc => tc.phone && tc.phone.replace(/\D/g, '').slice(-10) === callerClean);
      if (m) { isTrusted = true; trustedName = m.name || ''; rel = m.relationship || 'other'; famRel = m.family_relation || ''; }
    }

    const owner = ownerClient.company_name || 'Sir';
    let pi = '\n\n--- PERSONAL AI ASSISTANT MODE ---';

    if (aiMode === 'block_all') pi += '\nMODE: BLOCK ALL. Politely tell the caller the owner is unavailable and end quickly.';
    else if (aiMode === 'take_messages') pi += '\nMODE: TAKE MESSAGES. Take a message from every caller.';
    else if (isTrusted) pi += `\nMODE: TRUSTED CALLER "${trustedName}" (${rel}). Greet warmly by name.`;
    else pi += '\nMODE: SCREEN ALL. Classify as family/business/promotional/spam.';

    // Screening script (owner reachable vs unreachable)
    if (!isTrusted && aiMode !== 'block_all') {
      if (ownerReachable) {
        pi += `\n\n--- SCREENING SCRIPT (OWNER REACHABLE) ---
You are ${owner} ji's FEMALE personal AI assistant. Use feminine Hindi forms (rahi hoon, aati hoon).

STEP 1 — GREET: "Namaste! Main ${owner} ji ki personal AI assistant hoon. ${owner} ji abhi available nahi hain — main aapki call screen kar rahi hoon."
STEP 2 — ASK NAME: "Aap apna naam bata sakte hain please?"
STEP 3 — ASK PURPOSE: "<Name> ji, aap kis silsile mein call kar rahe hain?"
STEP 4 — HOLD: "Theek hai <Name> ji, ek minute line par rahiye — main ${owner} ji se confirm karke abhi aati hoon. Kripya hold kariye."
STEP 5 — SILENT WAIT for [OWNER INSTRUCTION]. Do NOT speak again until you receive it.

If caller speaks during wait: "Bas ek minute aur, ${owner} ji se confirm ho raha hai." Then go silent.
NEVER fabricate ${owner} ji's response, schedule, or availability.`;
      } else {
        pi += `\n\n--- MESSAGE-TAKING SCRIPT (OWNER UNREACHABLE — DND OR NOT CONNECTED) ---
You are ${owner} ji's FEMALE personal AI assistant. Use feminine Hindi forms.
${owner} ji is NOT reachable for live confirmation — politely take a message and end the call.

STEP 1 — GREET: "Namaste! Main ${owner} ji ki personal AI assistant hoon. ${owner} ji abhi available nahi hain. Main aapka message le sakti hoon."
STEP 2 — ASK NAME.
STEP 3 — ASK MESSAGE: "<Name> ji, aap apna message bata dijiye — main ${owner} ji ko de dungi."
STEP 4 — CONFIRM & END: "Maine note kar liya hai. Dhanyavaad, namaste." → call end_call tool with reason="message_taken".

NEVER say "main confirm karke aati hoon", "ek minute hold kariye", "main ${owner} ji se baat kar rahi hoon" — owner is not reachable.
NEVER fabricate ${owner} ji's location, activity, or schedule. Keep call SHORT (under 60s).`;
      }
    }

    if (isTrusted && ['family', 'friend'].includes(rel)) {
      const greetMap = { wife: 'Bhabhiji', mother: 'Mummy ji', father: 'Papa ji', brother: `${trustedName} Bhaiya`, sister: `${trustedName} Didi`, son: `${trustedName} Beta`, daughter: `${trustedName} Beta`, uncle: 'Uncle ji', aunt: 'Aunty ji', cousin: `${trustedName} ji`, in_law: `${trustedName} ji` };
      const honorific = greetMap[famRel || rel] || `${trustedName} ji`;
      if (ownerReachable) {
        pi += `\n\n--- TRUSTED FAMILY/FRIEND: ${trustedName} (${rel}) — OWNER REACHABLE ---
STEP 1: "Namaste ${honorific}! Main ${owner} ji ki personal assistant hoon. ${owner} ji abhi available nahi hain — main aapki call le rahi hoon."
STEP 2: "${honorific}, koi urgent kaam hai ya main message le lun?"
STEP 3: "Theek hai ${honorific}, ek minute hold kariye — main ${owner} ji se confirm karke abhi bataati hoon."
STEP 4: SILENT WAIT for [OWNER INSTRUCTION]. NEVER fabricate.`;
      } else {
        pi += `\n\n--- TRUSTED FAMILY/FRIEND: ${trustedName} — OWNER UNREACHABLE ---
STEP 1: "Namaste ${honorific}! Main ${owner} ji ki personal assistant hoon. ${owner} ji abhi available nahi hain. Aap mujhe bata dijiye, main unhe message pahuncha dungi."
STEP 2: Take their message warmly.
STEP 3: "Theek hai ${honorific}, maine note kar liya hai. ${owner} ji ko bata dungi. Dhanyavaad, namaste." → end_call.
NEVER say "ek minute hold kariye" — owner is NOT reachable.`;
      }
    }

    if (dndEnabled) pi += '\nDND IS ON: Handle silently and politely.';
    pi += '\nClassify call in summary as family/business/promotional/spam/unknown.';

    // Active owner status
    try {
      for (const s of ownerStatuses) {
        if (s.title) {
          pi += `\n\n--- OWNER STATUS: ${s.icon || ''} ${s.title} ---\nTell callers in Hindi: "${s.caller_message_hindi || ''}"`;
          break;
        }
      }
    } catch (_) {}

    session.systemPrompt = pi;
    session._isTrustedCaller = isTrusted;
    session._trustedContactName = trustedName;
    console.log(`[${reqId}] 🛡️ Personal: mode=${aiMode}, dnd=${dndEnabled}, trusted=${isTrusted}, ownerReachable=${ownerReachable}`);
  }

  // ─── Mid-call: extract caller info via LLM and notify owner via Telegram with action buttons ───
  async function checkCallerInfoAndNotify() {
    session._midCallChecking = true;

    const bUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const ak = Deno.env.get('AZURE_OPENAI_KEY');

    let callerName = session._trustedContactName || '';
    let reason = '';

    if (bUrl && dep && ak) {
      try {
        const convo = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
        const sysPrompt = session._isTrustedCaller
          ? 'Extract reason for this call in 5-10 words. Return JSON: {"reason":"brief"}'
          : 'Extract caller name and reason from this live call. Return JSON: {"caller_name":"name if said else empty","reason":"why calling else empty"}';
        const r = await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
          method: 'POST', headers: { 'api-key': ak, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: convo }],
            max_completion_tokens: 80, response_format: { type: 'json_object' }
          })
        });
        if (r.ok) {
          const j = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
          if (j.caller_name) callerName = j.caller_name;
          reason = j.reason || '';
        }
      } catch (_) {}
    }

    // Always send buttons — owner needs to decide even if name/reason are unclear.
    // Use phone number as caller identity if name not extracted.
    session._midCallTgSent = true;
    sendMidCallTgButtons(callerName || session.callerNumber || 'Unknown', reason || 'Not yet specified');
  }

  // ─── Live transcript snippet → Telegram (after action buttons sent) ───
  async function sendLiveTranscriptUpdate() {
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!tgT || !session._personalClientId) return;
    try {
      const svc = await getSvc();
      const cl = await svc.entities.Client.get(session._personalClientId);
      if (!cl?.telegram_connected || !cl?.telegram_chat_id || cl.owner_notification_channel !== 'telegram') return;
      const recent = session.transcript.slice(-4).map(t => `${t.speaker === 'Customer' ? '🗣️' : '🤖'} <b>${t.speaker}:</b> ${t.text.substring(0, 200)}`).join('\n');
      const msg = `📞 <b>Live Call Update</b>\n\n${recent}\n\n💬 <i>Type any message to instruct the AI</i>`;
      fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: msg, parse_mode: 'HTML' })
      }).catch(() => {});
    } catch (_) {}
  }

  async function sendMidCallTgButtons(name, reason) {
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!tgT || !session.callLogId) return;
    try {
      const svc = await getSvc();
      const cl = await svc.entities.Client.get(session._personalClientId);
      if (!cl?.telegram_connected || !cl?.telegram_chat_id || cl.dnd_enabled || cl.owner_notification_channel !== 'telegram') return;
      const ph = name !== session.callerNumber && session.callerNumber ? `\n📞 ${session.callerNumber}` : '';
      const tp = session._isTrustedCaller ? '\n🏷️ 👤 Saved Contact' : '';
      const text = `📞 <b>Live Call — What should I do?</b>\n\n👤 Caller: <b>${name}</b>${ph}${tp}\n\n📋 Reason: <b>${reason}</b>\n\n👇 <b>Choose action:</b>`;
      const kb = { inline_keyboard: [
        [{ text: '📞 Transfer to Me', callback_data: `decision:${session.callLogId}:transfer` }, { text: '⏰ Call Back', callback_data: `decision:${session.callLogId}:callback` }],
        [{ text: '📝 Take Message', callback_data: `decision:${session.callLogId}:take_message` }, { text: '🚫 Block/End', callback_data: `decision:${session.callLogId}:block` }]
      ]};
      const r = await fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cl.telegram_chat_id, text, parse_mode: 'HTML', reply_markup: kb })
      });
      if ((await r.json()).ok) {
        session._awaitingOwnerDecision = true;
        pollOwnerDecision(svc);
      }
    } catch (e) { console.error(`[${reqId}] TG buttons err: ${e.message}`); }
  }

  async function pollOwnerDecision(svc) {
    if (!session.callLogId) return;
    let polls = 0, reass = 0, fb = false;
    const start = Date.now();
    const iv = setInterval(async () => {
      polls++;
      if (polls > 120 || session._callEnded) { clearInterval(iv); return; }
      try {
        const decs = await svc.entities.CallDecision.filter({ call_log_id: session.callLogId, status: 'pending' });
        const ready = decs.filter(d => d.custom_message !== '__AWAITING_TIME__' && d.custom_message !== '__AWAITING_MESSAGE__');
        if (ready.length > 0) {
          for (const d of ready) {
            await svc.entities.CallDecision.update(d.id, { status: 'delivered' });
            executeOwnerDecision(d);
          }
          clearInterval(iv);
          return;
        }
        const elapsed = Date.now() - start;
        if (!fb && elapsed >= 60000) {
          fb = true;
          sendWaitingFallback();
          clearInterval(iv);
        } else if (elapsed >= (reass + 1) * 15000 && reass < 3) {
          reass++;
          sendWaitingReassurance();
        }
      } catch (_) {}
    }, 2000);
  }

  function sendWaitingReassurance() {
    const o = session._ownerName || 'Sir';
    sendToGemini({ realtimeInput: { text: `[WAITING UPDATE] Owner ne abhi tak reply nahi diya. Caller ko gently reassure karo: "Abhi ${o} ji se koi update nahi aaya hai, aap line par rahiye — main phir se pooch rahi hoon." Sirf 1 line bolo, phir wapas chup ho jao.` } });
  }

  function sendWaitingFallback() {
    const o = session._ownerName || 'Sir';
    sendToGemini({ realtimeInput: { text: `[WAITING TIMEOUT] Owner ne reply nahi diya. Caller ko boliye: "Lagta hai ${o} ji abhi busy hain. Maine aapka message unhe pahuncha diya hai. Wo free hote hi aapko khud call kar lenge. Dhanyavaad, namaste." Yeh bolne ke baad end_call tool use karo with reason="owner_unresponsive".` } });
  }

  function executeOwnerDecision(dec) {
    const owner = session._ownerName || 'Sir';
    let inst = '';
    if (dec.decision === 'transfer') {
      inst = session.humanTransferNumber
        ? `[OWNER INSTRUCTION] ${owner} ji ne call transfer karne bola hai. Caller ko boliye: "Sir, ${owner} ji aapka call apne paas transfer kar rahe hain." Phir transfer_to_human tool use karo.`
        : `[OWNER INSTRUCTION] ${owner} ji jald call back karenge.`;
    } else if (dec.decision === 'callback') {
      const t = dec.callback_time || dec.custom_message || 'kuch der mein';
      inst = `[OWNER INSTRUCTION] ${owner} ji ${t} mein call back karenge. Caller ko batao.`;
    } else if (dec.decision === 'take_message') {
      inst = `[OWNER INSTRUCTION] ${owner} ji busy hain. Caller ka message lo — naam, purpose, details.`;
    } else if (dec.decision === 'block') {
      inst = `[OWNER INSTRUCTION] Politely end: "${owner} ji abhi available nahi hain. Dhanyavaad. Namaste."`;
    } else if (dec.custom_message) {
      inst = `[OWNER INSTRUCTION] ${owner} ji ka message: "${dec.custom_message}". Relay naturally.`;
    }
    if (!inst) return;
    if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
      smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    session.isSpeaking = false;
    sendToGemini({ realtimeInput: { text: inst } });
  }

  // ─── Pre-warm Gemini connection ───
  connectGemini();

  // ─── Smartflo WebSocket Handlers ───
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
        console.log(`[${reqId}] 📞 START: callee=${session.calleeNumber}, caller=${session.callerNumber}`);
        session._lastUpsampleValue = 0;
        session._lastDownsampleRemainder = [];
        session._upPrev1 = null; session._upPrev2 = null;

        // NOTE: robotic pre-recorded Azure-TTS filler removed — Gemini's own natural
        // voice now handles the entire greeting, matching the main assistant voice
        // for a seamless, non-robotic transition (same approach as streamGeminiIncoming/Outgoing).
        loadAgentConfig().then(() => {
          session._agentConfigReady = true;
          if (session.geminiWs?.readyState === WebSocket.OPEN && !session.geminiReady) sendGeminiSetup();
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        const raw = atob(msg.media.payload);
        const mulawBytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) mulawBytes[i] = raw.charCodeAt(i);
        const pcm16Base64 = mulawToBase64PCM16_16k(mulawBytes, session);
        // P0: buffer audio during Gemini handshake instead of dropping it
        if (!session.geminiReady) {
          if (session._audioBuffer.length < 150) session._audioBuffer.push(pcm16Base64); // ~3s cap
          return;
        }
        sendToGemini({ realtimeInput: { audio: { data: pcm16Base64, mimeType: 'audio/pcm;rate=16000' } } });
        return;
      }

      if (msg.event === 'stop') {
        session._callEnded = true;
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
        await saveCallRecord(session, reqId, duration);
        return;
      }
    } catch (err) { console.error(`[${reqId}] Smartflo msg err: ${err.message}`); }
  };

  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    console.log(`[${reqId}] 🔴 Smartflo closed, ${duration}s`);
    if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
    if (session.callLogId) await saveCallRecord(session, reqId, duration);
  };

  smartfloSocket.onerror = () => {
    if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
  };

  return response;

};