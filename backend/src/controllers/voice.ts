import { Hono } from "hono";
import { client } from "../db/index.ts";
import { sendWhatsAppMessage } from "../integrations/whatsapp.ts";
import { sendSMS } from "../integrations/sms.ts";
import * as geminiKeys from "../services/geminiKeyManager.ts";

export const voiceRouter = new Hono();

// POST /api/voice/incoming
// Webhook for Smartflo (Tata Tele) when a call is received
voiceRouter.post("/incoming", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    
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
    // Note: This is a placeholder payload; adapt exactly to Smartflo's WebSocket Connect API.
    const smartfloResponse = {
      action: "connect",
      endpoint: {
        type: "websocket",
        uri: wsUrl,
        content_type: "audio/l16;rate=16000" // Instructing Smartflo to send PCM 16-bit 16kHz
      }
    };

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

function mulawToBase64PCM16_16k(mulawBytes: Uint8Array): string {
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) pcm8k[i] = decodeMulaw(mulawBytes[i]);
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    const s1 = pcm8k[i];
    pcm16k[i * 2] = s1;
    pcm16k[i * 2 + 1] = Math.round((s1 + (i < pcm8k.length - 1 ? pcm8k[i + 1] : s1)) / 2);
  }
  const buf = new Uint8Array(pcm16k.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < pcm16k.length; i++) view.setInt16(i * 2, pcm16k[i], true);
  
  // Chunked btoa
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, Math.min(i + CHUNK, buf.length))));
  }
  return btoa(bin);
}

function base64PCM16_24kToMulaw(b64: string, session: any): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const num = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const rem = session._lastDownsampleRemainder || [];
  const all = new Int16Array(rem.length + num);
  for (let i = 0; i < rem.length; i++) all[i] = rem[i];
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
  session._lastDownsampleRemainder = [];
  for (let i = consumed; i < total; i++) {
    session._lastDownsampleRemainder.push(all[i]);
  }

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
    
    let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0, intentSignals: string[] = [], scoreBreakdown: any = {}, keyTopics: string[] = [], summaryHindi = '';

    if (transcript.trim().length > 30) {
      try {
        const azureKey = Deno.env.get("AZURE_OPENAI_KEY");
        let baseUrl = (Deno.env.get("AZURE_OPENAI_ENDPOINT") || "").replace(/\/+$/, '');
        const azureDeployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT") || "gpt-5.4-pro";
        
        if (azureKey && baseUrl) {
          const azureEndpoint = `${baseUrl}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-08-01-preview`;
          
          const requestBody = JSON.stringify({
            messages: [{
              role: "user",
              content: `Analyze the following AI voice call transcript.\nTranscript:\n${transcript}\n\nReturn JSON exactly matching this format: {"summary":"2-3 sentences","summary_hindi":"Devanagari translation of summary","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":<number 0-100>,"intent_signals":["signal1", "signal2"],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":["topic1", "topic2"],"objections":["obj1"],"recommended_next_action":"..."}\n\nIMPORTANT: Output ONLY valid JSON. Do not include markdown formatting or backticks.`
            }]
          });
          
          let r = await fetch(azureEndpoint, {
            method: 'POST', 
            headers: { 
              'Content-Type': 'application/json',
              'api-key': azureKey,
              'Authorization': `Bearer ${azureKey}` // Fallback in case it expects standard Bearer
            }, 
            body: requestBody
          });
          
          if (r.ok) {
            const data = await r.json();
            const aTextRaw = data.choices?.[0]?.message?.content || '{}';
            const aText = aTextRaw.replace(/^```(?:json)?\n?/i, '').replace(/```$/i, '').trim();
            const a = JSON.parse(aText);
            summary = a.summary || ''; summaryHindi = a.summary_hindi || '';
            leadStatus = a.lead_status || 'contacted'; sentiment = a.sentiment || 'neutral';
            leadScore = Math.min(100, Math.max(0, a.lead_score || 0));
            intentSignals = a.intent_signals || [];
            scoreBreakdown = { ...(a.score_breakdown || {}), objections: a.objections || [], recommended_next_action: a.recommended_next_action || '', key_topics: a.key_topics || [], summary_hindi: summaryHindi };
            keyTopics = a.key_topics || [];
            console.log(`[${reqId}] 🧠 Score=${leadScore}, status=${leadStatus}`);
          } else {
            console.error(`[${reqId}] Azure OpenAI error:`, await r.text());
          }
        }
      } catch (e: any) { console.error(`[${reqId}] AI err: ${e.message}`); }
    } else { summary = 'Call ended with minimal conversation.'; }

    const custLines = session.transcript.filter((t: any) => t.speaker === 'Customer');
    const custWords = custLines.reduce((a: number, t: any) => a + t.text.split(/\s+/).length, 0);
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

    const callLogQuery = await client.queryObject(`SELECT * FROM "calllog" WHERE id = $1 LIMIT 1`, [session.callLogId]);
    const currentLog = callLogQuery.rows[0] as any;
    
    const wasTerminal = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);
    await client.queryObject(`
      UPDATE "calllog" 
      SET status = $1, call_end_time = $2, transcript = $3, duration = $4, lead_status_updated = $5, conversation_summary = $6
      WHERE id = $7
    `, [
       wasTerminal ? currentLog.status : 'completed',
       wasTerminal ? currentLog.call_end_time : new Date().toISOString(),
       transcript || '',
       duration,
       leadStatus,
       enriched || null,
       session.callLogId
    ]);
    console.log(`[${reqId}] 💾 Saved CallLog: ${session.callLogId}, score=${leadScore}`);

    const leadId = currentLog?.lead_id || session._leadId;
    if (leadId) {
      try {
        const exQuery = await client.queryObject(`SELECT * FROM "lead" WHERE id = $1 LIMIT 1`, [leadId]);
        const ex = exQuery.rows[0] as any;
        if (ex) {
           const merged = [...new Set([...(ex.tags || []), ...keyTopics.slice(0, 10)])];
           await client.queryObject(`
             UPDATE "lead"
             SET status = $1, score = $2, sentiment = $3, intent_signals = $4, score_breakdown = $5,
                 qualification_tier = $6, qualification_reason = $7, tags = $8,
                 last_call_date = $9, last_engagement_date = $10,
                 engagement_count = $11, notes = $12
             WHERE id = $13
           `, [
             leadStatus, leadScore, sentiment, JSON.stringify(intentSignals), JSON.stringify(scoreBreakdown),
             qTier, qReason, JSON.stringify(merged),
             new Date().toISOString(), new Date().toISOString(),
             (ex.engagement_count || 0) + 1,
             `[Score: ${leadScore}/100 | ${sentiment} | ${qTier}] ${summary.substring(0, 300)}`,
             leadId
           ]);
        }
      } catch (e: any) { console.error(`[${reqId}] Lead err: ${e.message}`); }
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
    _triedKeyFallback: false
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
           const agentResult = await client.queryObject(`SELECT client_id, system_prompt, greeting_message, persona FROM "agent" WHERE id = $1 LIMIT 1`, [agentId]);
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
    session.tools = decls;
    return decls;
  }

  async function executeToolCall(name: string, args: any) {
    console.log(`[${reqId}] 🔧 ${name}`);
    if (name === 'search_knowledge_base') {
      const results = searchKBChunks(args.query || '');
      return { results: results || 'No relevant info.' };
    }
    if (name === 'end_call') {
      const elapsed = (Date.now() - session.startTime) / 1000;
      if (elapsed < 10) return { error: 'Call just started. Continue the conversation naturally.' };
      
      const recentCustomer = session.transcript.filter((t: any) => t.speaker === 'Customer').slice(-3).map((t: any) => (t.text || '').toLowerCase()).join(' ');
      const goodbyeRegex = /(bye|goodbye|alvida|namaste|namaskar|dhanyav[aā]d|thank\s*you|thanks|shukriya|theek\s*hai\s*bye|ok\s*bye|fir\s*milte|chalo\s*bye|बाय|अलविदा|धन्यवाद|शुक्रिया|नमस्ते|नमस्कार|फिर मिलते)/i;
      if (!goodbyeRegex.test(recentCustomer)) return { error: 'Customer has NOT said goodbye yet. Continue the conversation.' };
      
      const reason = args.reason || 'conversation_complete';
      session.transcript.push({ speaker: 'System', text: `[Ended: ${reason}]` });
      setTimeout(() => {
        session._callEnded = true;
        if (geminiSocket?.readyState === WebSocket.OPEN) geminiSocket.close();
        if (smartfloSocket?.readyState === WebSocket.OPEN) smartfloSocket.close();
      }, 2000);
      return { success: true };
    }
    return { error: `Unknown: ${name}` };
  }

  function sendToGemini(msg: any) { if (geminiSocket?.readyState === WebSocket.OPEN) geminiSocket.send(JSON.stringify(msg)); }

  function sendGeminiSetup() {
    if (session._setupSent) return;
    session._setupSent = true;
    const tools = buildGeminiTools();
    const voiceRules = `[LANGUAGE] Speak ONLY Hindi (Devanagari/Roman) + English (Indian accent). Keep replies SHORT (1-2 sentences).\n[END-CALL GUARD] Use end_call ONLY after the CUSTOMER clearly says bye/thanks/namaste/dhanyavaad AND has spoken 2+ clear sentences.`;
    const kbHeader = session._kbChunks.length > 0 ? `\n[KB] For any price/product/feature/policy/location fact: CALL search_knowledge_base FIRST. Never guess.\n` : '';
    const fullPrompt = voiceRules + '\n' + kbHeader + '\n' + session.systemPrompt;

    const setup: any = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceType } } } },
        systemInstruction: { parts: [{ text: fullPrompt }] },
      }
    };
    if (tools.length) setup.setup.tools = [{ functionDeclarations: tools }];
    sendToGemini(setup);
    console.log(`[${reqId}] 📤 Setup: tools=${tools.length}, voice=${session.voiceType}, prompt=${fullPrompt.length}ch`);
  }

  const connectGemini = async (isReconnect: boolean = false) => {
    if (geminiSocket && !isReconnect) return;
    if (isReconnect && geminiSocket) { try { geminiSocket.close(); } catch (_) {} geminiSocket = null; }

    const { url: WS_URL, key, tier } = geminiKeys.getWebSocketUrl();
    currentGeminiKey = key;
    geminiSocket = new WebSocket(WS_URL);

    geminiSocket.onopen = async () => {
      console.log(`[${reqId}] 🔌 Gemini Connected`);
      session._setupSent = false;
      if (session._agentConfigReady) sendGeminiSetup();
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
          console.log(`[${reqId}] ✅ Gemini setupComplete (buffered=${session._audioBuffer.length})`);
          
          if (!session._greetingTriggered) {
             session._greetingTriggered = true;
             sendToGemini({ clientContent: { turns: [{ role: "user", parts: [{ text: "Hello! Greet me briefly in English or Hindi to start the conversation." }] }], turnComplete: true } });
             session._audioBuffer = [];
          } else {
             // Flush last bit of buffer for reconnects
             const tail = session._audioBuffer.slice(-50);
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
                if (m.length > 0 && smartfloSocket.readyState === WebSocket.OPEN && streamId) {
                  const CHUNK_SIZE = 960;
                  for (let i = 0; i < m.length; i += CHUNK_SIZE) {
                    const end = Math.min(i + CHUNK_SIZE, m.length);
                    let chunk = m.slice(i, end);
                    if (chunk.length % 160 !== 0) {
                      const padded = new Uint8Array(Math.ceil(chunk.length / 160) * 160);
                      padded.set(chunk); padded.fill(127, chunk.length);
                      chunk = padded;
                    }
                    smartfloSocket.send(JSON.stringify({ event: "media", streamSid: streamId, media: { payload: uint8ToBase64(chunk) } }));
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
      session.geminiReady = false;
      if (!session._callEnded && session._geminiReconnectAttempts < 5) {
        session._geminiReconnectAttempts++;
        connectGemini(true);
      } else if (!session._callEnded) {
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
          const pcm16kBase64 = mulawToBase64PCM16_16k(rawBytes);

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

  smartfloSocket.onclose = async () => {
    console.log(`[${reqId}] Smartflo Disconnected`);
    session._callEnded = true;
    if (geminiSocket && geminiSocket.readyState === WebSocket.OPEN) geminiSocket.close();
    
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    if (session.callLogId) {
      await saveCallRecord(session, reqId, duration);
    } else if (session._leadId) {
      await client.queryObject(`UPDATE "lead" SET last_call_date = $1 WHERE id = $2`, [new Date().toISOString(), session._leadId]);
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
