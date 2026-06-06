// ═══════════════════════════════════════════════════════════════════════
// streamAudioGemini — Smartflo OUTBOUND voice bridge for Gemini Live
// ═══════════════════════════════════════════════════════════════════════
// Refactored to match the proven streamGeminiOutgoing architecture:
// • 16kHz PCM input upsample (Gemini Live native input rate)
// • Proper 3:1 boxcar downsample for 24k→8k output (no aliasing)
// • Legacy 960-byte fire-and-forget pacing with 0x7F silence padding
// • Lazy KB loading from Azure Blob → DB → client-wide fallback
// • Hallucinated-script noise filter (foreign-language TTS hallucinations)
// • FREE → PAID Gemini key fallback on quota
// • Exponential backoff reconnect (max 5 attempts)
// • Audio buffer during Gemini handshake (no dropped packets)
// • end_call guarded by min-duration AND customer goodbye phrase
// ═══════════════════════════════════════════════════════════════════════

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ─── Smartflo token cache (shared across WS sessions in this isolate) ───
const SMARTFLO_TOKEN_TTL_MS = 50 * 60 * 1000;
let _smartfloTokenCache = { token: null, expiresAt: 0, inFlight: null, blockedUntil: 0 };

async function getSmartfloToken() {
  const now = Date.now();
  if (_smartfloTokenCache.token && _smartfloTokenCache.expiresAt > now) return _smartfloTokenCache.token;
  if (_smartfloTokenCache.blockedUntil > now) return null;
  if (_smartfloTokenCache.inFlight) return _smartfloTokenCache.inFlight;
  const sfE = Deno.env.get('SMARTFLO_EMAIL'), sfP = Deno.env.get('SMARTFLO_PASSWORD');
  if (!sfE || !sfP) return null;
  _smartfloTokenCache.inFlight = (async () => {
    try {
      const lr = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email: sfE, password: sfP })
      });
      const ld = await lr.json().catch(() => ({}));
      const tk = ld.access_token || ld.token;
      if (!lr.ok || !tk) {
        if (lr.status === 429 || ld.retry_after) {
          let cooldownMs = 10 * 60 * 1000;
          if (ld.retry_after) {
            const ra = new Date(ld.retry_after.replace(' ', 'T') + '+05:30').getTime();
            if (!isNaN(ra) && ra > Date.now()) cooldownMs = ra - Date.now() + 5000;
          }
          _smartfloTokenCache.blockedUntil = Date.now() + cooldownMs;
        }
        return null;
      }
      _smartfloTokenCache.token = tk;
      _smartfloTokenCache.expiresAt = Date.now() + SMARTFLO_TOKEN_TTL_MS;
      _smartfloTokenCache.blockedUntil = 0;
      return tk;
    } catch (_) { return null; }
    finally { _smartfloTokenCache.inFlight = null; }
  })();
  return _smartfloTokenCache.inFlight;
}

// ─── Audio helpers (mu-law 8kHz ↔ PCM16 16/24kHz) ───
function decodeMulaw(b) {
  const BIAS = 33; const mu = ~b & 0xFF;
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

// Mu-law 8kHz → PCM16 16kHz base64 (2x upsample, linear interp). Matches Gemini Live native input.
function mulawToBase64PCM16_16k(mulawBytes, session) {
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) pcm8k[i] = decodeMulaw(mulawBytes[i]);
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    const s1 = pcm8k[i];
    pcm16k[i * 2] = s1;
    pcm16k[i * 2 + 1] = Math.round((s1 + (i < pcm8k.length - 1 ? pcm8k[i + 1] : s1)) / 2);
  }
  if (pcm8k.length > 0) session._lastUpsampleValue = pcm8k[pcm8k.length - 1];
  const buf = new Uint8Array(pcm16k.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < pcm16k.length; i++) view.setInt16(i * 2, pcm16k[i], true);
  return uint8ToBase64(buf);
}

// PCM16 24kHz base64 → mu-law 8kHz (3:1 boxcar low-pass downsample). Uses EVERY sample to prevent aliasing.
function base64PCM16_24kToMulaw(b64, session) {
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
    const f = Math.round((all[idx] + all[idx + 1] + all[idx + 2]) / 3);
    mulaw[i] = encodeMulaw(Math.max(-32768, Math.min(32767, f)));
  }
  const consumed = dl * 3;
  session._lastDownsampleRemainder = [];
  for (let i = consumed; i < total; i++) session._lastDownsampleRemainder.push(all[i]);
  return mulaw;
}

// Chunked btoa — avoids huge string concat that stalls the event loop per frame
function uint8ToBase64(bytes) {
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

// ─── Noise + hallucinated-script filter ───
// Gemini's transcriber hallucinates Korean/Japanese/Chinese/Arabic/Thai/Cyrillic phrases
// on silence or noisy Indian audio. Drop those entirely so the AI never reacts to imaginary speech.
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
    const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });

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
              { role: 'system', content: 'Expert sales call analyst. Score 0-100. Respond ONLY in valid JSON.' },
              { role: 'user', content: `Transcript:\n${transcript}\n\nReturn JSON: {"summary":"2-3 sentences","summary_hindi":"Devanagari","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":[],"objections":[],"recommended_next_action":"..."}` }
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
    if (custWords <= 5 && duration < 30 && (leadStatus === 'do_not_call' || leadStatus === 'not_interested')) {
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
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
    await svc.entities.CallLog.update(session.callLogId, {
      ...(wasTerminal ? {} : { status: 'completed', call_end_time: new Date().toISOString() }),
      transcript: transcript || '', duration,
      lead_status_updated: leadStatus,
      ...(enriched ? { conversation_summary: enriched } : {})
    });
    console.log(`[${reqId}] 💾 Saved: ${session.callLogId}, score=${leadScore}`);

    const leadId = currentLog?.lead_id || session._leadId;
    if (leadId) {
      try {
        const ex = await svc.entities.Lead.get(leadId);
        const merged = [...new Set([...(ex.tags || []), ...keyTopics.slice(0, 10)])];
        await svc.entities.Lead.update(leadId, {
          status: leadStatus, score: leadScore, sentiment, intent_signals: intentSignals, score_breakdown: scoreBreakdown,
          qualification_tier: qTier, qualification_reason: qReason, tags: merged,
          last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString(),
          engagement_count: (ex.engagement_count || 0) + 1,
          notes: `[Score: ${leadScore}/100 | ${sentiment} | ${qTier}] ${summary.substring(0, 300)}`
        });
      } catch (e) { console.error(`[${reqId}] Lead err: ${e.message}`); }
    }

    // Personal account voicemail
    if (session._personalMode && session._personalClientId) {
      try {
        const cLines = session.transcript.filter(t => t.speaker === 'Customer').map(t => t.text);
        const msgText = cLines.join(' ').substring(0, 1000) || summary;
        await svc.entities.VoicemailMessage.create({ client_id: session._personalClientId, call_log_id: session.callLogId, caller_number: currentLog?.caller_id || currentLog?.callee_number || '', message: summary || msgText, is_read: false });
      } catch (_) {}
    }

    setTimeout(() => svc.functions.invoke('fetchCallRecording', { call_log_id: session.callLogId }).catch(() => {}), 20000);
    if (transcript.length > 50) svc.functions.invoke('postCallActionExtractor', { call_log_id: session.callLogId }).catch(() => {});
  } catch (err) { console.error(`[${reqId}] ❌ Save: ${err.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const isWS = (req.headers.get('upgrade') || '').toLowerCase() === 'websocket';

  // Inject Base44-App-Id for SDK validation
  let base44Req = req;
  if (!req.headers.get('Base44-App-Id')) {
    const newHeaders = new Headers(req.headers);
    newHeaders.set('Base44-App-Id', Deno.env.get('BASE44_APP_ID'));
    base44Req = new Request(req.url, { method: req.method, headers: newHeaders });
  }
  createClientFromRequest(base44Req);

  console.log(`[${reqId}] 📨 ${req.method} streamAudioGemini ws=${isWS}`);

  // ─── Smartflo Dynamic endpoint: return wss URL ───
  if (!isWS) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    let cid = '';
    if (req.method === 'POST') {
      try { const bd = await req.json(); cid = bd.call_log_id || bd.custom_identifier || bd.callLogId || ''; } catch (_) {}
    } else if (req.method === 'GET') {
      const u = new URL(req.url);
      cid = u.searchParams.get('call_log_id') || u.searchParams.get('custom_identifier') || '';
    }
    return new Response(JSON.stringify({
      sucess: true,
      wss_url: `wss://${host}/functions/streamAudioGemini${cid ? '?call_log_id=' + encodeURIComponent(cid) : ''}`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ─── Upgrade WebSocket ───
  const _wsUrl = new URL(req.url);
  const _wsCallLogId = _wsUrl.searchParams.get('call_log_id') || '';

  let smartfloSocket, response;
  try { const u = Deno.upgradeWebSocket(req); smartfloSocket = u.socket; response = u.response; }
  catch (_) { return new Response('WS upgrade failed', { status: 500 }); }

  const session = {
    streamSid: null, callSid: null, callLogId: null, clientId: null, smartfloCallId: null,
    transcript: [], startTime: Date.now(),
    systemPrompt: 'You are a professional AI voice assistant.',
    greetingMessage: '', voiceType: 'Puck',
    _saved: false, geminiWs: null, geminiReady: false,
    isSpeaking: false, tools: [], hasShopify: false, hasUniCommerce: false,
    humanTransferNumber: '', enableAutoTransfer: true,
    _geminiReconnectAttempts: 0, _callEnded: false,
    _transferInitiated: false, _agentConfigReady: false,
    calleeNumber: '', callerNumber: '',
    _lastUpsampleValue: 0, _lastDownsampleRemainder: [],
    _pendingAiText: '', _pendingCustomerText: '',
    _kbChunks: [], _kbFileUri: '', _kbLoadPromise: null,
    _leadId: null, _agentId: null, _toolFlags: {},
    _audioBuffer: [], // P0: queue customer audio during Gemini handshake
    _explicitCallLogId: _wsCallLogId || null,
    _greetingTriggered: false,
    _outQueue: [] // kept for interrupt clearing (legacy compat — no-op pacer)
  };

  let _cachedSvc = null;
  async function getSvc() {
    if (_cachedSvc) return _cachedSvc;
    const { createClient } = await getSDKModule();
    _cachedSvc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    return _cachedSvc;
  }

  // ─── KB lazy load: Blob → DB (via agent_id) → client-wide fallback ───
  async function loadKBLazy() {
    if (session._kbChunks.length > 0) return;
    if (session._kbLoadPromise) { await session._kbLoadPromise; return; }
    session._kbLoadPromise = (async () => {
      console.log(`[${reqId}] 📚 KB load start: uri=${session._kbFileUri ? 'yes' : 'no'}, agentId=${session._agentId || 'null'}`);
      // Path A: Azure Blob URI
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
        } catch (e) { console.error(`[${reqId}] ⚠️ Blob KB failed: ${e.message} — falling back to DB`); }
      }
      // Path B: Agent.knowledge_base_ids
      if (session._agentId) {
        try {
          const svc = await getSvc();
          const ag = await svc.entities.Agent.get(session._agentId);
          const kbIds = ag?.knowledge_base_ids || [];
          if (kbIds.length) {
            const docs = await Promise.all(kbIds.map(id => svc.entities.KnowledgeBase.get(id).catch(() => null)));
            const valid = docs.filter(d => d && d.content);
            let text = '';
            valid.forEach(d => { text += `[${d.title}]\n${d.content}\n\n---\n\n`; });
            if (text.length >= 100) {
              session._kbChunks = splitKBIntoChunks(text);
              console.log(`[${reqId}] 📚 KB DB (agent): ${session._kbChunks.length} chunks`);
              return;
            }
          }
        } catch (e) { console.error(`[${reqId}] DB KB err: ${e.message}`); }
      }
      // Path C: client-wide fallback (orphaned KB docs not attached to this agent)
      if (session.clientId) {
        try {
          const svc = await getSvc();
          const clientDocs = await svc.entities.KnowledgeBase.filter({ client_id: session.clientId, status: 'ready' }).catch(() => []);
          if (clientDocs.length) {
            let text = '';
            clientDocs.forEach(d => { if (d.content) text += `[${d.title}]\n${d.content}\n\n---\n\n`; });
            if (text.length >= 100) {
              session._kbChunks = splitKBIntoChunks(text);
              console.log(`[${reqId}] 📚 KB DB (client fallback): ${session._kbChunks.length} chunks`);
            }
          }
        } catch (e) { console.error(`[${reqId}] Client KB err: ${e.message}`); }
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

  // ─── Tools ───
  function buildGeminiTools() {
    const decls = [
      { name: 'end_call', description: 'End the call after caller said goodbye or conversation concluded.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } }
    ];
    if (session.humanTransferNumber) {
      decls.push({ name: 'transfer_to_human', description: 'Transfer to human when customer requests it.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } });
    }
    if (session._toolFlags?.has_kb || session._kbChunks.length > 0 || session._kbFileUri || session._agentId) {
      decls.push({ name: 'search_knowledge_base', description: 'Search KB for product/pricing/feature/policy info. ALWAYS use for company facts.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } });
    }
    if (session.hasShopify) {
      decls.push({ name: 'shopify_lookup', description: 'Look up Shopify orders/products.', parameters: { type: 'object', properties: { lookup_type: { type: 'string', enum: ['order_by_number', 'order_by_phone', 'order_by_email', 'product_search', 'refund_status', 'tracking'] }, query: { type: 'string' } }, required: ['lookup_type', 'query'] } });
    }
    session.tools = decls;
    return decls;
  }

  async function executeToolCall(name, args) {
    console.log(`[${reqId}] 🔧 ${name}`);

    if (name === 'search_knowledge_base') {
      if (!session._kbChunks.length) await loadKBLazy();
      const results = searchKBChunks(args.query || '');
      console.log(`[${reqId}] 📚 KB search: "${(args.query || '').substring(0, 80)}" chunks=${session._kbChunks.length} hit=${results.length > 0 ? 'yes' : 'no'}`);
      return { results: results || 'No relevant info.' };
    }

    if (name === 'end_call') {
      // P1: minimum call duration guard
      const elapsed = (Date.now() - session.startTime) / 1000;
      if (elapsed < 10) {
        console.log(`[${reqId}] 🛑 end_call rejected — too early (${elapsed.toFixed(1)}s)`);
        return { error: 'Call just started. Continue the conversation naturally.' };
      }
      // P1.5: require explicit goodbye phrase from CUSTOMER
      const recentCustomer = session.transcript
        .filter(t => t.speaker === 'Customer')
        .slice(-3)
        .map(t => (t.text || '').toLowerCase())
        .join(' ');
      const goodbyeRegex = /(bye|goodbye|alvida|namaste|namaskar|dhanyav[aā]d|thank\s*you|thanks|shukriya|theek\s*hai\s*bye|ok\s*bye|fir\s*milte|chalo\s*bye|बाय|अलविदा|धन्यवाद|शुक्रिया|नमस्ते|नमस्कार|फिर मिलते)/i;
      if (!goodbyeRegex.test(recentCustomer)) {
        console.log(`[${reqId}] 🛑 end_call rejected — customer hasn't said goodbye`);
        return { error: 'Customer has NOT said goodbye yet. Continue the conversation. Do NOT call end_call until the customer explicitly says bye/thank you/namaste/dhanyavaad. Ask your next question.' };
      }
      const reason = args.reason || 'conversation_complete';
      session.transcript.push({ speaker: 'System', text: `[Ended: ${reason}]` });
      setTimeout(() => {
        session._callEnded = true;
        if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
        hangupCall(reason);
      }, 2000);
      return { success: true };
    }

    if (name === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const tk = await getSmartfloToken();
        if (!tk) return { error: 'Smartflo auth failed' };
        const liveCallId = await findLiveCallId(tk);
        if (!liveCallId) return { error: 'Could not resolve live call for transfer' };
        const tr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
          method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
          body: JSON.stringify({ type: 4, call_id: liveCallId, intercom: String(session.humanTransferNumber) })
        });
        if (!tr.ok) return { error: `Transfer failed: ${tr.status}` };
        session._transferInitiated = true;
        session.transcript.push({ speaker: 'System', text: `[Transferred: ${args.reason || ''}]` });
        if (session.callLogId) {
          const svc = await getSvc();
          svc.entities.CallLog.update(session.callLogId, { transferred_to: `Intercom ${session.humanTransferNumber}` }).catch(() => {});
        }
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
    return { error: `Unknown: ${name}` };
  }

  // ─── Smartflo helpers ───
  // Resolve the LIVE Smartflo call_id (format e.g. "CAGE011-T8-1780735307.142") from
  // the live_calls API. This is the ONLY valid source for hangup/transfer — session.callSid
  // and Smartflo's ref_id are NOT accepted by /v1/call/hangup or /v1/call/options (they 422
  // "Invalid Call ID"). Matches on customer_number OR did, preferring "Voice Streaming" calls.
  // Retries briefly because the call may take a moment to appear in live_calls.
  async function findLiveCallId(token, retries = 3) {
    const ce = (session.calleeNumber || '').replace(/\D/g, '').slice(-10);
    const cr = (session.callerNumber || '').replace(/\D/g, '').slice(-10);
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const r = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
        if (r.ok) {
          const d = await r.json();
          const calls = Array.isArray(d) ? d : (d.data || []);
          const matches = calls.filter(c => {
            const cn = (c.customer_number || '').replace(/\D/g, '').slice(-10);
            const did = (c.did || '').replace(/\D/g, '').slice(-10);
            return (ce && (cn === ce || did === ce)) || (cr && (cn === cr || did === cr));
          });
          // Prefer the active Voice Streaming call (our AI bridge) over any other leg
          const best = matches.find(c => (c.type || '').toLowerCase().includes('voice streaming')) || matches[0];
          if (best?.call_id) return best.call_id;
        }
      } catch (_) {}
      if (attempt < retries - 1) await new Promise(res => setTimeout(res, 700));
    }
    return null;
  }

  async function hangupCall(reason) {
    session._callEnded = true;
    try {
      const tk = await getSmartfloToken();
      if (tk) {
        const liveCallId = await findLiveCallId(tk);
        if (liveCallId) {
          const hr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/hangup', {
            method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
            body: JSON.stringify({ call_id: liveCallId })
          });
          if (!hr.ok) console.error(`[${reqId}] ⚠️ Hangup failed: ${hr.status} (call_id=${liveCallId})`);
        } else {
          console.error(`[${reqId}] ⚠️ Hangup skipped — no live call_id resolved`);
        }
      }
    } catch (_) {}
    const d = Math.round((Date.now() - session.startTime) / 1000);
    saveCallRecord(session, reqId, d).then(() => {
      if (smartfloSocket.readyState === WebSocket.OPEN) smartfloSocket.close();
    });
  }

  // ─── Gemini connection (FREE → PAID key fallback on quota) ───
  function isQuotaCloseEvt(e) {
    if (!e) return false;
    if (e.code === 1011 || e.code === 1008) return true;
    const r = (e.reason || '').toLowerCase();
    return r.includes('quota') || r.includes('resource_exhausted') || r.includes('429') || r.includes('rate limit');
  }

  function connectGemini() {
    const freeKey = Deno.env.get('GEMINI_API_KEY');
    const paidKey = Deno.env.get('GEMINI_API_KEY_PAID');
    if (!freeKey && !paidKey) { console.error(`[${reqId}] ❌ No Gemini key`); return; }
    if (!freeKey) session._usingPaidKey = true;
    const key = session._usingPaidKey ? paidKey : freeKey;
    console.log(`[${reqId}] 🔑 Gemini key=${session._usingPaidKey ? 'PAID' : 'FREE'}`);
    // Gemini Live model→endpoint mapping:
    //   - gemini-2.0-flash-live-001 → v1beta
    //   - gemini-live-2.5-flash-preview → v1beta
    // The wrong combination causes Gemini to silently close the WebSocket right after setup.
    const apiVersion = 'v1beta';
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContent?key=${key}`;
    const ws = new WebSocket(wsUrl);
    session._geminiOpenedAt = 0;
    ws.onopen = () => {
      session._geminiOpenedAt = Date.now();
      session._setupSent = false; // new WS instance → allow one fresh setup
      console.log(`[${reqId}] 🔌 Gemini WS OPEN (${apiVersion})`);
      if (session._agentConfigReady) sendGeminiSetup();
    };
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
      // Stability gate: ONLY reset the reconnect counter if the connection stayed open
      // for >30s (real working session). Closes that happen within seconds of opening
      // mean Gemini is rejecting our setup — don't mask that as a "fresh" reconnect.
      const aliveMs = session._geminiOpenedAt ? (Date.now() - session._geminiOpenedAt) : 0;
      if (aliveMs > 30000) session._geminiReconnectAttempts = 0;
      console.log(`[${reqId}] 🔴 Gemini WS closed: code=${ev.code} reason="${(ev.reason || '').substring(0, 200)}" aliveMs=${aliveMs}`);

      // FREE → PAID auto-fallback on quota close
      if (!session._usingPaidKey && !session._triedKeyFallback && paidKey && isQuotaCloseEvt(ev) && !session._callEnded) {
        session._triedKeyFallback = true;
        session._usingPaidKey = true;
        console.log(`[${reqId}] ⚠️ FREE key quota → PAID fallback`);
        connectGemini();
        return;
      }
      // Exponential backoff, max 5 attempts (counter only resets on stable connections)
      if (!session._callEnded && session._geminiReconnectAttempts < 5) {
        session._geminiReconnectAttempts++;
        const base = Math.min(15000, 1000 * Math.pow(2, session._geminiReconnectAttempts - 1));
        const jitter = Math.floor(Math.random() * 500);
        const delay = base + jitter;
        console.log(`[${reqId}] 🔄 Reconnect ${session._geminiReconnectAttempts}/5 in ${delay}ms`);
        setTimeout(() => { if (!session._callEnded) connectGemini(); }, delay);
      } else if (!session._callEnded) {
        console.error(`[${reqId}] ❌ Reconnect exhausted — ending call`);
        session._callEnded = true;
        const d = Math.round((Date.now() - session.startTime) / 1000);
        saveCallRecord(session, reqId, d).then(() => { if (smartfloSocket.readyState === WebSocket.OPEN) smartfloSocket.close(); });
      }
    };
    ws.onerror = (e) => { console.error(`[${reqId}] ❌ Gemini WS error: ${e?.message || e?.type || 'unknown'}`); };
    session.geminiWs = ws;
  }

  function sendToGemini(msg) { if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.send(JSON.stringify(msg)); }

  function sendGeminiSetup() {
    // Guard against double-setup: connectGemini().onopen AND loadAgentConfig() can both call this.
    // Sending setup twice on the same WS makes Gemini close with code 1007 "invalid argument".
    if (session._setupSent) { console.log(`[${reqId}] ⏭️ setup already sent, skipping`); return; }
    session._setupSent = true;
    const tools = buildGeminiTools();
    const hasKB = session._toolFlags?.has_kb || session._kbFileUri || session._kbChunks.length > 0 || !!session._agentId;
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
    const langLock = `[RULES]\n• Speak ONLY Hindi (Devanagari/Roman) + English. Marathi OK. NEVER use Korean/Japanese/Chinese/Arabic/Thai/Spanish/Portuguese/French.\n• If transcription looks foreign, it is noise — IGNORE it, do NOT respond.\n• On unclear audio: "Didi, aawaz saaf nahi aa rahi, dohra sakti hain?" then WAIT.\n• Identity (name/company) is FIXED — never change.\n`;
    const kbHeader = hasKB ? `• For any price/product/feature/policy/location fact: CALL search_knowledge_base FIRST. Never guess. Never say "tool/database/AI".\n• If KB has nothing: "Iske exact details WhatsApp pe bhej deti hoon."\n` : '';
    const transferI = session.humanTransferNumber && session.enableAutoTransfer ? `• Customer asks for human → call transfer_to_human.\n` : '';
    const endR = `• end_call ONLY after CUSTOMER says bye/thanks/namaste/dhanyavaad. Your goodbye doesn't count. On silence → ask next question, never end.\n`;
    const time = `• Now: ${nowIST} IST.\n\n`;
    const fullPrompt = langLock + kbHeader + transferI + endR + time + session.systemPrompt;

    // Valid Gemini Live voices
    const validVoices = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Puck'];
    const voice = validVoices.includes(session.voiceType) ? session.voiceType : 'Puck';

    const setup = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        systemInstruction: { parts: [{ text: fullPrompt }] },
        inputAudioTranscription: {}, outputAudioTranscription: {}
      }
    };
    if (tools.length) setup.setup.tools = [{ functionDeclarations: tools }];
    sendToGemini(setup);
    console.log(`[${reqId}] 📤 Setup: tools=${tools.length}, voice=${voice}, prompt=${fullPrompt.length}ch, kb=${hasKB}`);
  }

  function handleGeminiMessage(msg) {
    if (msg.setupComplete !== undefined) {
      session.geminiReady = true;
      console.log(`[${reqId}] ✅ Gemini setupComplete (buffered=${session._audioBuffer.length})`);
      // If greeting hasn't started, send it FIRST and drop buffered audio (caller hasn't really
      // spoken yet — buffer contains noise/silence from before pickup).
      // If greeting was already triggered before (reconnect case), flush only the last ~1s of
      // buffered audio (50 chunks ≈ 1s of 20ms frames) to avoid stale-burst turn confusion.
      const wasReconnect = session._greetingTriggered;
      if (!wasReconnect) {
        if (session._agentConfigReady) triggerGreeting();
        session._audioBuffer = [];
      } else if (session._audioBuffer.length > 0) {
        const tail = session._audioBuffer.slice(-50);
        for (const b64 of tail) {
          sendToGemini({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
        }
        session._audioBuffer = [];
      }
      return;
    }
    if (msg.error) { console.error(`[${reqId}] ❌ Gemini error:`, JSON.stringify(msg.error)); return; }
    if (msg.serverContent) {
      const sc = msg.serverContent;
      if (sc.modelTurn?.parts) {
        for (const p of sc.modelTurn.parts) {
          if (p.inlineData?.mimeType?.includes('audio') && p.inlineData.data) {
            session.isSpeaking = true;
            const m = base64PCM16_24kToMulaw(p.inlineData.data, session);
            if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) sendMulawToSmartflo(m);
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
        session._outQueue = [];
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
    if (session._greetingTriggered) return;
    session._greetingTriggered = true;
    const g = session.greetingMessage || '';
    if (g) {
      session.transcript.push({ speaker: 'AI', text: g });
      sendToGemini({ realtimeInput: { text: `Say: ${g}` } });
    } else {
      sendToGemini({ realtimeInput: { text: 'Greet briefly.' } });
    }
  }

  // ─── Legacy fire-and-forget pacing (Smartflo's jitter buffer paces playback) ───
  // 960-byte chunks = 120ms each. 0x7F = mu-law silence (0xFF causes clicks at boundaries).
  function sendMulawToSmartflo(mulawBytes) {
    if (smartfloSocket.readyState !== WebSocket.OPEN || !session.streamSid) return;
    const CHUNK_SIZE = 960;
    for (let i = 0; i < mulawBytes.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, mulawBytes.length);
      let chunk = mulawBytes.slice(i, end);
      if (chunk.length % 160 !== 0) {
        const paddedLen = Math.ceil(chunk.length / 160) * 160;
        const padded = new Uint8Array(paddedLen);
        padded.set(chunk);
        padded.fill(0x7F, chunk.length);
        chunk = padded;
      }
      try {
        smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: uint8ToBase64(chunk) } }));
      } catch (_) {}
    }
  }

  function mapVoice(vRaw, fallback = 'Puck') {
    const gem = ['aoede', 'charon', 'fenrir', 'kore', 'puck'];
    const v = (vRaw || '').toLowerCase();
    if (gem.includes(v)) return v.charAt(0).toUpperCase() + v.slice(1);
    // Cross-engine aliases (Azure Realtime → Gemini)
    const map = { 'alloy': 'Puck', 'shimmer': 'Kore', 'echo': 'Charon', 'ash': 'Fenrir', 'coral': 'Aoede', 'sage': 'Kore', 'ballad': 'Aoede', 'verse': 'Puck', 'marin': 'Kore', 'cedar': 'Charon' };
    if (map[v]) return map[v];
    const female = ['neerja', 'ananya', 'swara', 'jenny', 'aria', 'sonia', 'ava', 'emma'];
    if (female.some(n => v.includes(n))) return 'Kore';
    if (v.includes('neural') || v.includes('dragon')) return v.includes('female') ? 'Kore' : 'Charon';
    return fallback;
  }

  // ─── Load agent config: explicit call_log_id → call_sid → phone match ───
  async function loadAgentConfig() {
    const t0 = Date.now();
    try {
      const svc = await getSvc();
      let callLog = null;

      // Strategy 1: explicit call_log_id from URL or customParameters
      if (session._explicitCallLogId) {
        callLog = await svc.entities.CallLog.get(session._explicitCallLogId).catch(e => {
          console.error(`[${reqId}] ❌ CallLog.get(${session._explicitCallLogId}) failed: ${e.message}`);
          return null;
        });
      }

      // Strategy 2: match by call_sid
      if (!callLog && session.callSid) {
        const sidMatches = await svc.entities.CallLog.filter({ call_sid: session.callSid }).catch(() => []);
        if (sidMatches?.length > 0) { callLog = sidMatches[0]; console.log(`[${reqId}] 🔍 call_sid match: ${callLog.id}`); }
      }

      // Strategy 3: match by phone within 2-min window
      if (!callLog && session.calleeNumber) {
        const cutoff = new Date(Date.now() - 120000).toISOString();
        const cleanCallee = session.calleeNumber.replace(/[^0-9]/g, '').slice(-10);
        const [ring, init] = await Promise.all([
          svc.entities.CallLog.filter({ status: 'ringing' }, '-created_date', 20).catch(() => []),
          svc.entities.CallLog.filter({ status: 'initiated' }, '-created_date', 20).catch(() => [])
        ]);
        const match = (list) => list.find(l => !l.stream_sid && l.created_date >= cutoff && (l.callee_number || '').replace(/[^0-9]/g, '').slice(-10) === cleanCallee);
        callLog = match(ring) || match(init);
        if (callLog) console.log(`[${reqId}] 🔍 Phone match: ${callLog.id}`);
      }

      if (!callLog) {
        console.error(`[${reqId}] ❌ No callLog found. explicitId=${session._explicitCallLogId}, callSid=${session.callSid}, callee=${session.calleeNumber}`);
        return;
      }
      console.log(`[${reqId}] ✅ CallLog: ${callLog.id}, hasCache=${!!callLog.agent_config_cache}`);

      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      if (callLog.call_sid) session.smartfloCallId = callLog.call_sid;
      session._agentId = callLog.agent_id || null;
      session._leadId = callLog.lead_id || null;

      const cache = callLog.agent_config_cache || {};

      // SLIM cache path
      if (cache.core_prompt) {
        session.systemPrompt = cache.core_prompt;
        session._kbFileUri = cache.kb_file_uri || '';
        session._toolFlags = cache.tool_flags || {};
        session.hasShopify = !!cache.tool_flags?.has_shopify;
        session.hasUniCommerce = !!cache.tool_flags?.has_unicommerce;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
      }
      // Legacy cache
      else if (cache.system_prompt) {
        // Strip any inline KB content — force tool use instead
        let p = cache.system_prompt;
        const kbR = /\n+(?:[-=]{2,}\s*)?KNOWLEDGE BASE[^\n]*[\s\S]*?(?=\n\n---|\n\n##|$)/i;
        p = p.replace(kbR, '').trim();
        session.systemPrompt = p;
        if (cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if (cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if (cache.kb_file_uri) session._kbFileUri = cache.kb_file_uri;
        if (session.systemPrompt.includes('SHOPIFY')) session.hasShopify = true;
        // Flag KB as available so the tool is registered — content loads lazily
        if (cache.knowledge_base_content || callLog.agent_id || cache.kb_file_uri) {
          session._toolFlags = { ...(session._toolFlags || {}), has_kb: true };
        }
      }

      session.voiceType = mapVoice(cache.persona?.voice_type, 'Puck');

      // Persist stream_sid back to CallLog
      const upd = {};
      if (session.streamSid) upd.stream_sid = session.streamSid;
      if (session.callSid && callLog.call_sid !== session.callSid) upd.call_sid = session.callSid;
      if (Object.keys(upd).length) svc.entities.CallLog.update(callLog.id, upd).catch(() => {});

      session._agentConfigReady = true;
      console.log(`[${reqId}] ⚡ Config ready in ${Date.now() - t0}ms: voice=${session.voiceType}, prompt=${session.systemPrompt.length}ch`);

      // If Gemini WS already open, send setup now
      if (session.geminiWs?.readyState === WebSocket.OPEN && !session.geminiReady) sendGeminiSetup();
    } catch (e) { console.error(`[${reqId}] ❌ Config err: ${e.message}`); }
  }

  // ─── Boot ───
  connectGemini();

  smartfloSocket.onopen = () => { console.log(`[${reqId}] 🟢 Smartflo WS open`); };
  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.event === 'connected') return;

      if (msg.event === 'start') {
        const sd = msg.start || {};
        session.streamSid = sd.streamSid;
        session.callSid = sd.callSid;
        const cp = sd.customParameters || {};
        // Extract call_log_id from customParameters if not in URL
        if (!session._explicitCallLogId) {
          session._explicitCallLogId = cp.custom_identifier || cp.call_log_id || cp.callLogId || null;
        }
        session.calleeNumber = cp.customer_number || cp.called_number || cp.to || sd.to || sd.callee || cp.did || '';
        session.callerNumber = sd.from || sd.caller || cp.caller_number || cp.from || cp.caller_id || '';
        session._lastUpsampleValue = 0;
        session._lastDownsampleRemainder = [];
        console.log(`[${reqId}] 📞 START: stream=${session.streamSid}, callSid=${session.callSid}, callee=${session.calleeNumber}, explicitId=${session._explicitCallLogId || 'none'}`);

        loadAgentConfig().then(() => {
          if (session.geminiWs?.readyState === WebSocket.OPEN && !session.geminiReady) sendGeminiSetup();
          if (session._toolFlags?.has_kb || session._kbFileUri || session._agentId) loadKBLazy().catch(() => {});
        });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        const raw = atob(msg.media.payload);
        const m = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) m[i] = raw.charCodeAt(i);
        const b64 = mulawToBase64PCM16_16k(m, session);
        // P0: buffer during handshake (~3s cap), don't drop
        if (!session.geminiReady) {
          if (session._audioBuffer.length < 150) session._audioBuffer.push(b64);
          return;
        }
        sendToGemini({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
        return;
      }

      if (msg.event === 'stop') {
        console.log(`[${reqId}] 📴 Smartflo stop`);
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
    console.log(`[${reqId}] 🔴 Smartflo closed, duration=${d}s`);
    if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close();
    if (session.callLogId) await saveCallRecord(session, reqId, d);
  };
  smartfloSocket.onerror = () => { if (session.geminiWs?.readyState === WebSocket.OPEN) session.geminiWs.close(); };

  return response;
});