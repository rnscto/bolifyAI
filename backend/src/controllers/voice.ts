import { Hono } from "hono";
import { client } from "../db/index.ts";
import { sendWhatsAppMessage } from "../integrations/whatsapp.ts";
import { sendSMS } from "../integrations/sms.ts";
import * as geminiKeys from "../services/geminiKeyManager.ts";
import { campaignPostCallCore } from "../functions/campaignPostCall.ts";
import { postCallActionExtractorCore } from "../functions/postCallActionExtractor.ts";

export const voiceRouter = new Hono();

// POST /api/voice/incoming
// Webhook for Smartflo (Tata Tele) when a call is received
voiceRouter.post("/incoming", async (c) => {
  try {
    const contentType = c.req.header("content-type") || "";
    let body: any = {};
    try {
      if (contentType.includes("application/json")) {
        body = await c.req.json();
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        body = await c.req.parseBody();
      }
    } catch (e) {
      console.warn("[Smartflo] Failed to parse incoming webhook body");
    }
    
    // Extract Smartflo identifiers (adjust fields based on actual Smartflo documentation)
    const to = body.to || body.destination_number || "";
    const from = body.from || body.caller_id || "";
    const callId = body.call_id || body.uuid || `call_${Date.now()}`;

    console.log(`[Smartflo] Webhook Raw Body:`, JSON.stringify(body));
    console.log(`[Smartflo] Incoming call from ${from} to ${to} (Call ID: ${callId})`);

    let agentId = c.req.query("agent_id") || "";
    let leadId = c.req.query("lead_id") || "";

    // If missing from query string, look it up via custom_identifier (CallLog ID) from Smartflo payload
    const customIdentifier = body.custom_identifier || body.custom_data || "";
    if (!agentId && customIdentifier) {
       try {
          const callLogRes = await client.queryObject(`SELECT agent_id, lead_id FROM "calllog" WHERE id = $1 LIMIT 1`, [customIdentifier]);
          if (callLogRes.rows.length > 0) {
             const callLog = callLogRes.rows[0] as any;
             agentId = callLog.agent_id || "";
             leadId = callLog.lead_id || "";
          }
       } catch (e) {
          console.error("Error fetching callLog for custom_identifier:", customIdentifier, e);
       }
    }

    const forwardedProto = c.req.header("x-forwarded-proto");
    const forwardedHost = c.req.header("x-forwarded-host");
    const protocol = forwardedProto ? (forwardedProto === "https" ? "wss" : "ws") : (new URL(c.req.url).protocol === "https:" ? "wss" : "ws");
    const host = forwardedHost || new URL(c.req.url).host;
    let wsUrl = `${protocol}://${host}/api/voice/stream/${callId}`;
    
    if (agentId || leadId) {
       const params = new URLSearchParams();
       if (agentId) params.append("agent_id", agentId);
       if (leadId) params.append("lead_id", leadId);
       wsUrl += `?${params.toString()}`;
    }

    // Return the JSON/XML response telling Smartflo to bridge to WebSocket
    const accept = c.req.header("accept") || "";
    if (accept.includes("application/xml") || accept.includes("text/xml")) {
      c.header("Content-Type", "application/xml");
      return c.body(`<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wsUrl.replace(/&/g, '&amp;')}" /></Connect></Response>`);
    }

    const smartfloResponse = [
      {
        action: "connect",
        endpoint: [
          {
            type: "websocket",
            uri: wsUrl,
            content_type: "audio/l16;rate=16000"
          }
        ]
      }
    ];

    return c.json(smartfloResponse);
  } catch (error) {
    console.error("Error handling incoming Smartflo call:", error);
    return c.json({ action: "hangup", reason: "application_error" }, 500);
  }
});

// --- Audio Conversion Helpers ---
function decodeMulaw(b: number): number {
  const BIAS = 33; const mu = ~b & 0xFF;
  const sign = (mu & 0x80) ? -1 : 1, exp = (mu >> 4) & 0x07, mant = mu & 0x0F;
  let s = ((mant << 3) + BIAS) << exp; s -= BIAS;
  return sign * s;
}

function encodeMulaw(s: number): number {
  const MAX = 32635, BIAS = 33;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s; if (s > MAX) s = MAX;
  s += BIAS; let exp = 7;
  for (; exp > 0; exp--) { if (s & 0x4000) break; s <<= 1; }
  const mant = (s >> 10) & 0x0F;
  return ~(sign | (exp << 4) | mant) & 0xFF;
}

function mulawToBase64PCM16_16k(mulawBytes: Uint8Array, session: any): string {
  const n = mulawBytes.length;
  const pcm8k = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm8k[i] = decodeMulaw(mulawBytes[i]);
  const pm2 = session._upPrev2 ?? (pcm8k[0] || 0);
  const pm1 = session._upPrev1 ?? (pcm8k[0] || 0);
  const at = (idx: number) => (idx < 0 ? (idx === -2 ? pm2 : pm1) : (idx < n ? pcm8k[idx] : pcm8k[n - 1] ?? pm1));
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

function base64PCM16_24kToMulaw(b64: string, session: any): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const num = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const rem = session._lastDownsampleRemainder || new Int16Array(0);
  const all = new Int16Array(rem.length + num);
  all.set(rem, 0);
  for (let i = 0; i < num; i++) all[rem.length + i] = view.getInt16(i * 2, true);

  const total = all.length;
  const dl = Math.floor(total / 3);
  const mulaw = new Uint8Array(dl);
  for (let i = 0; i < dl; i++) {
    const idx = i * 3;
    const a = all[idx], b = all[idx + 1], c = all[idx + 2];
    const f = Math.round(a * 0.25 + b * 0.5 + c * 0.25);
    mulaw[i] = encodeMulaw(Math.max(-32768, Math.min(32767, f)));
  }

  const consumed = dl * 3;
  const remCount = total - consumed;
  const nextRem = new Int16Array(remCount);
  for (let i = 0; i < remCount; i++) {
    nextRem[i] = all[consumed + i];
  }
  session._lastDownsampleRemainder = nextRem;

  return mulaw;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
  }
  return btoa(bin);
}

// --- WebSocket Handler ---


// ─── Noise + hallucinated-script filter ───
function isNoiseTranscription(text: string): boolean {
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
function splitKBIntoChunks(content: string): string[] {
  if (!content || content.length < 100) return [];
  const chunks: string[] = [];
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
async function saveCallRecord(session: any, reqId: string, duration: number) {
  if (!session.callLogId || session._saved) return;
  session._saved = true;
  try {
    if (session._pendingCustomerText) { session.transcript.push({ speaker: 'Customer', text: session._pendingCustomerText.trim() }); session._pendingCustomerText = ''; }
    if (session._pendingAiText) { session.transcript.push({ speaker: 'AI', text: session._pendingAiText.trim() }); session._pendingAiText = ''; }
    const transcript = session.transcript.map((t: any) => `${t.speaker}: ${t.text}`).join('\n');
    
    let summary = 'Analyzing...';
    const callLogQuery = await client.queryObject(`SELECT * FROM "calllog" WHERE id = $1 LIMIT 1`, [session.callLogId]);
    const currentLog = callLogQuery.rows[0] as any;
    
    const wasTerminal = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);
    await client.queryObject(`
      UPDATE "calllog" 
      SET status = $1, call_end_time = $2, transcript = $3, duration = $4, conversation_summary = $5
      WHERE id = $6
    `, [
       wasTerminal ? currentLog.status : 'completed',
       wasTerminal ? currentLog.call_end_time : new Date().toISOString(),
       transcript || '',
       duration,
       summary,
       session.callLogId
    ]);
    console.log(`[${reqId}] 💾 Saved basic CallLog: ${session.callLogId}. Handing off AI scoring to Dapr.`);

    try {
      const daprUrl = `http://localhost:3500/v1.0/publish/pubsub/call-tasks`;
      const res = await fetch(daprUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
           action: "process_post_call", 
           callLogId: session.callLogId, 
           transcript: transcript,
           duration: duration,
           leadId: currentLog?.lead_id || session._leadId,
           reqId: reqId
        })
      });
      if (!res.ok) throw new Error(`Dapr responded with status ${res.status}`);
      console.log(`[${reqId}] 🚀 Published Post-Call Orchestrator task to Dapr`);
    } catch (daprErr: any) {
      console.warn(`[${reqId}] ⚠️ Dapr publish failed (${daprErr.message}). AI scoring will not process.`);
    }
  } catch (err: any) { console.error(`[${reqId}] ❌ Save: ${err.message}`); }
}

// initStreamSession: Called with an ALREADY-UPGRADED socket from Deno.serve.
// Deno.upgradeWebSocket was called SYNCHRONOUSLY in main.ts before this function.
// All async work (Gemini, DB) happens here, AFTER the WS handshake is complete.
export async function initStreamSession(smartfloSocket: WebSocket, url: URL): Promise<void> {
  const callId = url.searchParams.get("call_log_id") || url.searchParams.get("callId") || `call_${Date.now()}`;
  const reqId = Math.random().toString(36).substring(2, 10);
  const leadIdParam = url.searchParams.get("lead_id") || null;
  const agentIdParam = url.searchParams.get("agent_id") || null;

  const initialKey = geminiKeys.getKey();
  if (!initialKey.key) {
    console.error("Missing GEMINI_API_KEY. Terminating call.");
    smartfloSocket.close();
    return;
  }

  const session: any = {
    callSid: callId,
    callLogId: url.searchParams.get("call_log_id") || null,
    clientId: null,
    transcript: [],
    startTime: Date.now(),
    systemPrompt: 'You are a professional AI voice assistant.',
    greetingMessage: '',
    voiceType: 'Puck',
    _saved: false,
    geminiWs: null,
    geminiReady: false,
    isSpeaking: false,
    tools: [],
    humanTransferNumber: '',
    enableAutoTransfer: false,
    _geminiReconnectAttempts: 0,
    _callEnded: false,
    _agentConfigReady: false,
    calleeNumber: '',
    callerNumber: '',
    _lastDownsampleRemainder: [],
    _pendingAiText: '',
    _pendingCustomerText: '',
    _kbChunks: [],
    _leadId: leadIdParam,
    _agentId: agentIdParam,
    _audioBuffer: [],
    _setupSent: false,
    _greetingTriggered: false,
    _usingPaidKey: false,
    _triedKeyFallback: false,
    _sendBuffer: new Uint8Array(0)
  };

  let geminiSocket: WebSocket | null = null;
  let currentGeminiKey = "";
  let streamId: string | null = null;
  
  async function loadAgentConfig(agentId: string) {
     if (session._agentConfigReady) return;
     try {
       if (session.callLogId) {
          const logRes = await client.queryObject(`SELECT agent_config_cache FROM "calllog" WHERE id = $1 LIMIT 1`, [session.callLogId]);
          if (logRes.rows.length > 0 && (logRes.rows[0] as any).agent_config_cache) {
             const cache = (logRes.rows[0] as any).agent_config_cache;
             if (cache.system_prompt) session.systemPrompt = cache.system_prompt;
             if (cache.greeting_message) session.greetingMessage = cache.greeting_message;
             if (cache.persona) {
               if (cache.persona.voice_type) session.voiceType = cache.persona.voice_type;
               session.humanTransferNumber = cache.human_transfer_number || cache.persona.human_transfer_number;
               session.enableAutoTransfer = cache.enable_auto_transfer ?? cache.persona.enable_auto_transfer;
             }
             if (cache.knowledge_base_content && cache.knowledge_base_content.length > 100) {
                session._kbChunks = splitKBIntoChunks(cache.knowledge_base_content);
                console.log(`[${reqId}] 📚 KB loaded from cache: ${session._kbChunks.length} chunks`);
             }
             session._agentConfigReady = true;
             console.log(`[${reqId}] Agent config loaded from calllog cache`);
          }
       }
       
       if (!session._agentConfigReady) {
           const agentResult = await client.queryObject(`SELECT client_id, system_prompt, greeting_message, persona, human_transfer_number FROM "agent" WHERE id = $1 LIMIT 1`, [agentId]);
           if (agentResult.rows.length > 0) {
              const agent = agentResult.rows[0] as any;
              session.clientId = agent.client_id;
              if (agent.system_prompt) session.systemPrompt = agent.system_prompt;
              if (agent.greeting_message) session.greetingMessage = agent.greeting_message;
              if (agent.persona && typeof agent.persona === 'object') {
                const personaObj = agent.persona as any;
                if (personaObj.voice_type) session.voiceType = personaObj.voice_type;
                if (personaObj.human_transfer_number) session.humanTransferNumber = personaObj.human_transfer_number;
                if (personaObj.enable_auto_transfer) session.enableAutoTransfer = personaObj.enable_auto_transfer;
              }
              if (agent.human_transfer_number) session.humanTransferNumber = agent.human_transfer_number;
           }
           
           // Load Agent Tools
           try {
             const toolsRes = await client.queryObject(`SELECT name, description, method, url, headers, parameters_schema FROM "agent_tools" WHERE agent_id = $1 AND is_active = true`, [agentId]);
             session.apiTools = toolsRes.rows;
           } catch(e) {
             console.error(`[${reqId}] Failed to load agent tools:`, e);
             session.apiTools = [];
           }
           
           // Load KB
           const kbQuery = await client.queryObject(`SELECT content, title FROM "knowledgebase" WHERE client_id = $1 AND status = 'ready'`, [session.clientId]);
           let text = '';
           for (const r of kbQuery.rows as any[]) {
              if (r.content) text += `[${r.title}]\n${r.content}\n\n---\n\n`;
           }
           if (text.length >= 100) {
              session._kbChunks = splitKBIntoChunks(text);
              console.log(`[${reqId}] 📚 KB loaded: ${session._kbChunks.length} chunks`);
           }
       }
     } catch (e) {
       console.error(`[${reqId}] Agent config err:`, e);
     }
     session._agentConfigReady = true;
     if (geminiSocket?.readyState === WebSocket.OPEN) sendGeminiSetup();
  }

  function searchKBChunks(query: string) {
    if (!session._kbChunks?.length) return '';
    const kws = (query || '').toLowerCase().replace(/[^\w\s\u0900-\u097F]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
    if (!kws.length) return session._kbChunks.slice(0, 2).join('\n\n---\n\n');
    const scored = session._kbChunks.map((c: string) => {
      const lo = c.toLowerCase(); let s = 0;
      for (const k of kws) {
        s += lo.split(k).length - 1;
        if (/^\[.*\]|^#/.test(c) && lo.substring(0, 100).includes(k)) s += 2;
      }
      return { c, s };
    });
    const top = scored.filter((x: any) => x.s > 0).sort((a: any, b: any) => b.s - a.s).slice(0, 3);
    return top.length ? top.map((x: any) => x.c).join('\n\n---\n\n') : session._kbChunks.slice(0, 2).join('\n\n---\n\n');
  }

  function buildGeminiTools() {
    const decls: any[] = [
      { name: 'end_call', description: 'End the call after caller said goodbye or conversation concluded.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } }
    ];
    if (session.humanTransferNumber) {
      decls.push({ name: 'transfer_to_human', description: 'Transfer to human when customer requests it.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } });
    }
    if (session._kbChunks.length > 0) {
      decls.push({ name: 'search_knowledge_base', description: 'Search KB for product/pricing/feature/policy info. ALWAYS use for company facts.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } });
    }
    if (session.apiTools && session.apiTools.length > 0) {
      for (const t of session.apiTools) {
        decls.push({
          name: t.name,
          description: t.description,
          parameters: t.parameters_schema || { type: 'object', properties: {} }
        });
      }
    }
    session.tools = decls;
    return decls;
  }

  async function executeToolCall(name: string, args: any) {
    console.log(`[${reqId}] 🔧 ${name}`);
    if (name === 'search_knowledge_base') {
      const results = searchKBChunks(args.query || '');
      return { results: results || 'No relevant info.' };
    }
    if (name === 'transfer_to_human') {
      const reason = args.reason || 'user_requested_transfer';
      session.transcript.push({ speaker: 'System', text: `[Transferring to human: ${reason}]` });
      if (smartfloSocket?.readyState === WebSocket.OPEN && streamId) {
         smartfloSocket.send(JSON.stringify({
            event: 'transfer',
            streamSid: streamId,
            transferTo: session.humanTransferNumber
         }));
      }
      setTimeout(() => {
        session._callEnded = true;
        if (geminiSocket?.readyState === WebSocket.OPEN) geminiSocket.close();
        if (smartfloSocket?.readyState === WebSocket.OPEN) smartfloSocket.close();
      }, 500);
      return { success: true, message: "Call transferred." };
    }
    
    if (session.apiTools) {
      const tool = session.apiTools.find((t: any) => t.name === name);
      if (tool) {
        try {
          const fetchOpts: any = { method: tool.method || 'GET' };
          if (tool.headers) fetchOpts.headers = tool.headers;
          let fetchUrl = tool.url;
          if (fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD') {
             fetchOpts.body = JSON.stringify(args);
             fetchOpts.headers = { ...fetchOpts.headers, 'Content-Type': 'application/json' };
          } else {
             const qs = new URLSearchParams(args).toString();
             if (qs) fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + qs;
          }
          // SSRF Protection
          try {
             const u = new URL(fetchUrl);
             if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.startsWith('10.') || u.hostname.startsWith('169.254') || u.hostname.startsWith('192.168.')) {
                return { error: "Security Exception: Internal network access blocked." };
             }
          } catch(e) {}

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s timeout
          const resp = await fetch(fetchUrl, { ...fetchOpts, signal: controller.signal });
          clearTimeout(timeoutId);
          const data = await resp.text();
          try {
             return JSON.parse(data);
          } catch(e) {
             return { result: data };
          }
        } catch(e: any) {
          if (e.name === 'AbortError') return { error: "API timeout. Advise the user the system is slow." };
          return { error: `Failed to execute API call: ${e.message}` };
        }
      }
    }

    if (name === 'end_call') {
      const elapsed = (Date.now() - session.startTime) / 1000;
      if (elapsed < 10) return { error: 'Call just started. Continue the conversation naturally.' };
      
      const reason = args.reason || 'conversation_complete';
      session.transcript.push({ speaker: 'System', text: `[Ended: ${reason}]` });
      setTimeout(() => {
        session._callEnded = true;
        if (geminiSocket?.readyState === WebSocket.OPEN) geminiSocket.close();
        if (smartfloSocket?.readyState === WebSocket.OPEN) smartfloSocket.close();
      }, 500);
      return { success: true };
    }
    return { error: `Unknown: ${name}` };
  }

  function sendToGemini(msg: any) { if (geminiSocket?.readyState === WebSocket.OPEN) geminiSocket.send(JSON.stringify(msg)); }

  function sendGeminiSetup() {
    if (session._setupSent) return;
    session._setupSent = true;
    const tools = buildGeminiTools();
    const transferRule = session.humanTransferNumber ? `\n[TRANSFER] If the user explicitly asks to speak to a human or becomes extremely frustrated, use the transfer_to_human tool immediately.` : '';
    const voiceRules = `[GREETING] Always start with a very short greeting immediately.\n[LANGUAGE] Speak ONLY Hindi (Devanagari/Roman) + English (Indian accent). Keep replies SHORT (1-2 sentences).\n[END-CALL GUARD] Use the end_call tool IMMEDIATELY if the customer says goodbye, asks to call back later, shows disinterest, or if the conversation has naturally concluded. Do not wait for further input.${transferRule}`;
    const kbHeader = session._kbChunks.length > 0 ? `\n[KB] For any price/product/feature/policy/location fact: CALL search_knowledge_base FIRST. Never guess.\n` : '';
    const fullPrompt = voiceRules + '\n' + kbHeader + '\n' + session.systemPrompt;

    const allowedVoices = [
      'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Zephyr', 'Enceladus', 'Leda',
      'Sadachbia', 'Vindemiatrix', 'Callirrhoe', 'Umbriel', 'Gacrux', 'Orus',
      'Autonoe', 'Iapetus', 'Algieba', 'Despina', 'Erinome', 'Algenib',
      'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Pulcherrima',
      'Achird', 'Sadaltager', 'Sulafat'
    ];
    const safeVoice = allowedVoices.includes(session.voiceType) ? session.voiceType : 'Puck';

    const setup: any = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoice } } } },
        systemInstruction: { parts: [{ text: fullPrompt }] },
      }
    };
    if (tools.length) setup.setup.tools = [{ functionDeclarations: tools }];
    sendToGemini(setup);
    console.log(`[${reqId}] 📤 Setup: tools=${tools.length}, voice=${session.voiceType}, prompt=${fullPrompt.length}ch`);
  }

  let geminiKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const connectGemini = async (isReconnect: boolean = false) => {
    if (geminiSocket && !isReconnect) return;
    if (isReconnect && geminiSocket) { try { geminiSocket.close(); } catch (_) {} geminiSocket = null; }
    if (geminiKeepaliveTimer) { clearInterval(geminiKeepaliveTimer); geminiKeepaliveTimer = null; }

    const { url: WS_URL, key, tier } = geminiKeys.getWebSocketUrl();
    currentGeminiKey = key;
    geminiSocket = new WebSocket(WS_URL);

    geminiSocket.onopen = async () => {
      console.log(`[${reqId}] 🔌 Gemini Connected (attempt ${session._geminiReconnectAttempts + 1})`);
      session._setupSent = false;
      if (session._agentConfigReady) sendGeminiSetup();
      // Keepalive: Gemini Live has a ~10min idle timeout and a ~2min session limit on free tier.
      // Send a silent ping every 25s to prevent idle disconnects.
      geminiKeepaliveTimer = setInterval(() => {
        if (geminiSocket?.readyState === WebSocket.OPEN && !session._callEnded) {
          // Send silent audio chunk to keep connection alive safely
          try {
            geminiSocket.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "AAAAAA==" } } }));
          } catch (_) {}
        } else {
          if (geminiKeepaliveTimer) clearInterval(geminiKeepaliveTimer);
        }
      }, 25000);
    };

    geminiSocket.onmessage = async (event) => {
      try {
        let text = typeof event.data === "string" ? event.data : "";
        if (event.data instanceof Blob) text = await event.data.text();
        else if (event.data instanceof ArrayBuffer) text = new TextDecoder().decode(event.data);
        
        if (!text) return;
        const msg = JSON.parse(text);

        if (msg.setupComplete !== undefined) {
          session.geminiReady = true;
          console.log(`[${reqId}] ✅ Gemini setupComplete (buffered=${session._audioBuffer.length}, reconnect=${isReconnect})`);
          
          if (!session._greetingTriggered) {
             session._greetingTriggered = true;
             sendToGemini({ clientContent: { turns: [{ role: "user", parts: [{ text: "User connected. Greet them." }] }], turnComplete: true } });
             session._audioBuffer = [];
          } else if (isReconnect) {
             // On reconnect, replay the last few turns so Gemini has context
             const recentTranscript = session.transcript.slice(-8);
             if (recentTranscript.length > 0) {
               const ctxText = recentTranscript
                 .map((t: any) => `${t.speaker}: ${t.text}`)
                 .join('\n');
               sendToGemini({ clientContent: { turns: [
                 { role: "user", parts: [{ text: `[Session resumed. Previous conversation:\n${ctxText}\n\nContinue naturally from where we left off.]` }] }
               ], turnComplete: true } });
             }
             // Flush buffered audio
             const tail = session._audioBuffer.slice(-150);
             for (const b64 of tail) sendToGemini({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
             session._audioBuffer = [];
          }
          return;
        }

        if (msg.serverContent) {
          const sc = msg.serverContent;
          if (sc.modelTurn?.parts) {
            for (const p of sc.modelTurn.parts) {
              if (p.inlineData?.mimeType?.includes('audio') && p.inlineData.data) {
                session.isSpeaking = true;
                const m = base64PCM16_24kToMulaw(p.inlineData.data, session);
                if (m.length > 0) {
                  // Append to buffer
                  const newBuffer = new Uint8Array(session._sendBuffer.length + m.length);
                  newBuffer.set(session._sendBuffer, 0);
                  newBuffer.set(m, session._sendBuffer.length);
                  session._sendBuffer = newBuffer;

                  // Extract 160-byte chunks
                  const chunkCount = Math.floor(session._sendBuffer.length / 160);
                  if (chunkCount > 0 && smartfloSocket.readyState === WebSocket.OPEN && streamId) {
                    const toSend = session._sendBuffer.slice(0, chunkCount * 160);
                    session._sendBuffer = session._sendBuffer.slice(chunkCount * 160);
                    smartfloSocket.send(JSON.stringify({ event: "media", streamSid: streamId, media: { payload: uint8ToBase64(toSend) } }));
                  }
                }
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
            
            // Flush and pad any remaining audio buffer with silence (255)
            if (session._sendBuffer.length > 0 && smartfloSocket.readyState === WebSocket.OPEN && streamId) {
              const remaining = session._sendBuffer;
              const paddedLength = Math.ceil(remaining.length / 160) * 160;
              const padded = new Uint8Array(paddedLength);
              padded.set(remaining);
              padded.fill(255, remaining.length); // 255 (0xFF) is G.711 µ-law silence
              smartfloSocket.send(JSON.stringify({ event: "media", streamSid: streamId, media: { payload: uint8ToBase64(padded) } }));
              session._sendBuffer = new Uint8Array(0);
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
             session._sendBuffer = new Uint8Array(0); // Discard unplayed audio on interrupt
             if (session._pendingAiText) { session.transcript.push({ speaker: 'AI', text: session._pendingAiText.trim() }); session._pendingAiText = ''; }
             if (smartfloSocket.readyState === WebSocket.OPEN && streamId) smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: streamId }));
          }
        }
        if (msg.toolCall) {
           const fcs = msg.toolCall.functionCalls || [];
           const responses = [];
           for (const fc of fcs) {
              const r = await executeToolCall(fc.name, fc.args || {});
              responses.push({ id: fc.id, name: fc.name, response: r });
           }
           sendToGemini({ toolResponse: { functionResponses: responses } });
        }
      } catch (e) {
        console.error(`[${reqId}] Gemini error handling msg:`, e);
      }
    };

    geminiSocket.onerror = (e) => console.error(`[${reqId}] Gemini WS Error`, e);

    geminiSocket.onclose = (event) => {
      console.log(`[${reqId}] 🔴 Gemini Disconnected (code: ${event.code}, reason: ${event.reason})`);
      if (geminiKeepaliveTimer) { clearInterval(geminiKeepaliveTimer); geminiKeepaliveTimer = null; }
      session.geminiReady = false;

      // If the close was due to rate limiting, switch key before reconnecting
      if (geminiKeys.isRateLimitError(event.code)) {
        geminiKeys.markRateLimited(currentGeminiKey, `ws_close_${event.code}`);
      }

      if (!session._callEnded && session._geminiReconnectAttempts < 10) {
        session._geminiReconnectAttempts++;
        const delay = session._geminiReconnectAttempts <= 2 ? 200 : 500;
        console.log(`[${reqId}] 🔁 Reconnecting Gemini (attempt ${session._geminiReconnectAttempts}) in ${delay}ms...`);
        setTimeout(() => connectGemini(true), delay);
      } else if (!session._callEnded) {
        console.error(`[${reqId}] ❌ Gemini reconnect exhausted. Ending call.`);
        session._callEnded = true;
        if (smartfloSocket.readyState === WebSocket.OPEN) smartfloSocket.close();
      }
    };
  };


  smartfloSocket.onopen = () => console.log(`[${reqId}] Smartflo Connected`);

  smartfloSocket.onmessage = async (event) => {
    try {
      if (typeof event.data === "string") {
        const payload = JSON.parse(event.data);
        if (payload.stream_id || payload.streamSid) streamId = payload.stream_id || payload.streamSid;
        
        if (payload.event === "start" || payload.event === "connected") {
           console.log(`[${reqId}] Smartflo WS Start payload:`, JSON.stringify(payload));
           let resolvedAgentId = session._agentId;
           const customIdentifier = payload.start?.customParameters?.customData || payload.start?.customParameters?.custom_identifier || payload.start?.customData || payload.customData || payload.custom_identifier || "";
           const wsCallId = payload.start?.callSid || payload.callSid || payload.start?.call_id || payload.call_id || payload.uuid || payload.start?.uuid || payload.streamSid || payload.stream_id || payload.start?.ref_id || payload.ref_id || "";

           if (!resolvedAgentId) {
             if (customIdentifier) {
               try {
                 const callLogRes = await client.queryObject(`SELECT agent_id, lead_id, id FROM "calllog" WHERE id = $1 LIMIT 1`, [customIdentifier.trim()]);
                 if (callLogRes.rows.length > 0) {
                   const callLog = callLogRes.rows[0] as any;
                   resolvedAgentId = callLog.agent_id;
                   session.callLogId = callLog.id;
                   if (!session._leadId && callLog.lead_id) session._leadId = callLog.lead_id;
                 }
               } catch(e) { console.error(`[${reqId}] Error fetching calllog by customIdentifier:`, e); }
             }
             if (!resolvedAgentId && wsCallId) {
               try {
                 const callLogRes = await client.queryObject(`SELECT agent_id, lead_id, id FROM "calllog" WHERE call_sid = $1 LIMIT 1`, [wsCallId]);
                 if (callLogRes.rows.length > 0) {
                   const callLog = callLogRes.rows[0] as any;
                   resolvedAgentId = callLog.agent_id;
                   session.callLogId = callLog.id;
                   if (!session._leadId && callLog.lead_id) session._leadId = callLog.lead_id;
                 }
               } catch(e) {}
             }
             if (!resolvedAgentId) {
                 const possibleDids = [
                    payload.start?.customParameters?.calledNumber, payload.start?.calledNumber, payload.customerNumber, payload.to,
                    payload.start?.customParameters?.callerNumber, payload.start?.callerNumber, payload.callerNumber, payload.from,
                    payload.start?.customParameters?.caller_id, payload.start?.customParameters?.customer_number
                 ].filter(Boolean).map(n => String(n).replace(/[^0-9]/g, '').slice(-10));
                 
                 for (const cleanDid of possibleDids) {
                     if (cleanDid.length === 10) {
                         try {
                             const didRes = await client.queryObject(`SELECT id FROM "agent" WHERE assigned_did LIKE $1 OR assigned_dids::text LIKE $1 LIMIT 1`, [`%${cleanDid}%`]);
                             if (didRes.rows.length > 0) {
                                 resolvedAgentId = (didRes.rows[0] as any).id;
                                 break;
                             }
                         } catch(e) { console.error(`[${reqId}] Error in DID fallback query for ${cleanDid}:`, e); }
                     }
                 }
             }
           }
           
           // FALLBACK: If we found the agent but STILL don't have the callLogId (e.g. Smartflo didn't pass customData and call_id mismatched)
           if (resolvedAgentId && !session.callLogId) {
               try {
                   const recentCallRes = await client.queryObject(
                       `SELECT id, lead_id FROM "calllog" WHERE agent_id = $1 AND status IN ('initiated', 'ringing', 'answered') ORDER BY created_at DESC LIMIT 1`, 
                       [resolvedAgentId]
                   );
                   if (recentCallRes.rows.length > 0) {
                       const recentCall = recentCallRes.rows[0] as any;
                       session.callLogId = recentCall.id;
                       if (!session._leadId && recentCall.lead_id) session._leadId = recentCall.lead_id;
                       console.log(`[${reqId}] ⚠️ Fallback: recovered session.callLogId ${session.callLogId} from active calls for agent ${resolvedAgentId}`);
                   }
               } catch(e) { console.error(`[${reqId}] Error in recent call fallback query:`, e); }
           }
           
           session._agentId = resolvedAgentId;
           if (resolvedAgentId) await loadAgentConfig(resolvedAgentId);
           connectGemini();
        }

        if (payload.event === "media" || payload.type === "audio") {
          const rawBase64 = payload.media?.payload || payload.data;
          const rawBytes = Uint8Array.from(atob(rawBase64), c => c.charCodeAt(0));
          const pcm16kBase64 = mulawToBase64PCM16_16k(rawBytes, session);

          if (geminiSocket && session.geminiReady) {
            sendToGemini({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcm16kBase64 } } });
          } else {
            session._audioBuffer.push(pcm16kBase64);
            if (!geminiSocket) connectGemini();
          }
        }
      }
    } catch (e) { console.error(`[${reqId}] Smartflo parse err:`, e); }
  };

  smartfloSocket.onclose = () => {
    console.log(`[${reqId}] Smartflo Disconnected`);
    session._callEnded = true;
    if (geminiKeepaliveTimer) { clearInterval(geminiKeepaliveTimer); geminiKeepaliveTimer = null; }
    if (geminiSocket && geminiSocket.readyState === WebSocket.OPEN) geminiSocket.close();
    
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    if (session.callLogId) {
      saveCallRecord(session, reqId, duration).catch(e => console.error(`[${reqId}] Save record error:`, e));
    } else if (session._leadId) {
      client.queryObject(`UPDATE "lead" SET last_call_date = $1 WHERE id = $2`, [new Date().toISOString(), session._leadId]).catch(e => console.error(`[${reqId}] Lead update err:`, e));
    }
  };


  smartfloSocket.onerror = (e) => console.error(`[${reqId}] Smartflo WS Error:`, e);
  // initStreamSession is void — response was already returned to the client by Deno.serve
}


// streamHandler: Hono handler for GET /api/voice/stream (HTTP only — not WS)
// WS upgrades are intercepted at Deno.serve level in main.ts.
export const streamHandler = async (c: any) => {
  const appBaseUrl = Deno.env.get('APP_BASE_URL');
  const host = appBaseUrl || c.req.header('x-forwarded-host') || c.req.header('host') || '';

  const cid = c.req.query('call_log_id') || c.req.query('custom_identifier') || '';
  return c.json({
    success: true,
    wss_url: `wss://${host}/api/voice/stream${cid ? '?call_log_id=' + encodeURIComponent(cid) : ''}`
  });
};

import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

voiceRouter.post("/initiate", async (c) => {
  try {
    const { lead_id, agent_id } = await c.req.json();
    if (!lead_id || !agent_id) return c.json({ error: "lead_id and agent_id required" }, 400);

    const leadRes = await client.queryObject(`SELECT id, phone FROM "lead" WHERE id = $1 LIMIT 1`, [lead_id]);
    const agentRes = await client.queryObject(`SELECT id, client_id, assigned_did, assigned_dids, smartflo_api_token FROM "agent" WHERE id = $1 LIMIT 1`, [agent_id]);
    
    if (leadRes.rows.length === 0 || agentRes.rows.length === 0) return c.json({ error: "Lead or Agent not found" }, 404);
    
    const lead = leadRes.rows[0] as any;
    const agent = agentRes.rows[0] as any;

    let callerDID = agent.assigned_did;
    if (!callerDID && typeof agent.assigned_dids === 'string') {
        try { const arr = JSON.parse(agent.assigned_dids); if (arr.length > 0) callerDID = arr[0]; } catch(_) {}
    } else if (!callerDID && Array.isArray(agent.assigned_dids) && agent.assigned_dids.length > 0) {
        callerDID = agent.assigned_dids[0];
    }
    if (!callerDID) return c.json({ error: "Agent has no assigned DID" }, 400);

    const callLogRes = await client.queryObject(`
      INSERT INTO "calllog" (client_id, agent_id, lead_id, caller_id, callee_number, direction, status, call_start_time)
      VALUES ($1, $2, $3, $4, $5, 'outbound', 'initiated', NOW())
      RETURNING id
    `, [agent.client_id, agent.id, lead.id, callerDID, lead.phone]);
    
    const callLogId = (callLogRes.rows[0] as any).id;

    const smartfloApiKey = agent.smartflo_api_token || Deno.env.get("SMARTFLO_API_KEY");
    if (!smartfloApiKey) return c.json({ error: "No Smartflo API Key configured" }, 500);

    const result = await triggerSmartfloOutboundCall({
      smartfloApiKey,
      calleeNumber: lead.phone,
      callerId: callerDID,
      callLogId: callLogId
    });

    if (result.success) {
      return c.json({ success: true, call_sid: result.call_sid, call_log_id: callLogId });
    } else {
      return c.json({ success: false, error: result.message }, 500);
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

voiceRouter.post("/transfer", async (c) => {
  return c.json({ error: "Transfer logic to be implemented with Smartflo login/cache." }, 501);
});

import { getSmartfloToken } from "../services/smartflo.ts";

voiceRouter.post("/fetch-recording", async (c) => {
  try {
    const { call_log_id, bulk, force_refresh } = await c.req.json();
    let token;
    try {
      token = await getSmartfloToken(force_refresh === true);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }

    let logs: any[] = [];
    if (call_log_id) {
      const res = await client.queryObject(`SELECT * FROM "calllog" WHERE id = $1`, [call_log_id]);
      if (res.rows.length > 0) logs.push(res.rows[0]);
    } else if (bulk) {
      const res = await client.queryObject(`SELECT * FROM "calllog" WHERE status = 'completed' AND recording_url IS NULL ORDER BY created_at DESC LIMIT 50`);
      logs = res.rows;
    }
    
    if (logs.length === 0) {
      return c.json({ success: true, message: "No calls to process", updated: 0 });
    }

    let updatedCount = 0;
    const results = [];

    for (const log of logs) {
      try {
        const callSid = (log as any).call_sid;
        if (!callSid) continue;

        let recordingUrl = null;
        let cdrResp = await fetch(
          `https://api-smartflo.tatateleservices.com/v1/call/records?call_id=${encodeURIComponent(callSid)}&limit=1`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
        );

        if (cdrResp.status === 401 || cdrResp.status === 403) {
          token = await getSmartfloToken(true);
          cdrResp = await fetch(
            `https://api-smartflo.tatateleservices.com/v1/call/records?call_id=${encodeURIComponent(callSid)}&limit=1`,
            { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
          );
          if (cdrResp.status === 401 || cdrResp.status === 403) {
            console.error("[fetch-recording] Auth failed even after token refresh. Breaking batch.");
            break;
          }
        }

        if (cdrResp.ok) {
          const cdrData = await cdrResp.json();
          const records = cdrData.data || cdrData.records || cdrData.results || (Array.isArray(cdrData) ? cdrData : []);
          if (records.length > 0) {
            recordingUrl = records[0].recording_url || records[0].recording || records[0].record_url || null;
          }
        }

        if (recordingUrl) {
          await client.queryObject(`UPDATE "calllog" SET recording_url = $1 WHERE id = $2`, [recordingUrl, (log as any).id]);
          updatedCount++;
          results.push({ id: (log as any).id, call_sid: callSid, recording_url: recordingUrl });
        } else {
          results.push({ id: (log as any).id, call_sid: callSid, recording_url: null, note: "No recording found" });
        }
      } catch (err: any) {
        results.push({ id: (log as any).id, error: err.message });
      }
    }

    return c.json({ success: true, updated: updatedCount, total: logs.length, results });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});
