const fs = require('fs');

const original = fs.readFileSync('/Users/nandyadav/bolifyai-your-smart-ai-voice-calling-agent/backend/src/controllers/voice.ts', 'utf-8');
const lines = original.split('\n');

const topPart = lines.slice(0, 153).join('\n'); // Up to line 153 (// --- WebSocket Handler ---)
const bottomPart = lines.slice(547).join('\n'); // From line 548 (voiceRouter.get("/stream/:callId", streamHandler);)

const newMiddle = `
// ─── Noise + hallucinated-script filter ───
function isNoiseTranscription(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length <= 4 && /^(uh|um|mhm|hmm|eh|oh|ah)\\.?$/i.test(t)) return true;
  if (/[\\uAC00-\\uD7AF\\u3040-\\u309F\\u30A0-\\u30FF\\u4E00-\\u9FFF\\u0600-\\u06FF\\u0E00-\\u0E7F\\u0400-\\u04FF]/.test(t)) return true;
  if (!/[a-zA-Z\\u0900-\\u097F]/.test(t)) return true;
  if (/[¿¡]/.test(t)) return true;
  if (t.length < 80 && /[àâäçéèêëîïôöûùüÿñõãáíóú]/i.test(t)) return true;
  return false;
}

// ─── KB chunking ───
function splitKBIntoChunks(content: string): string[] {
  if (!content || content.length < 100) return [];
  const chunks: string[] = [];
  const docs = content.split(/\\n---\\n/);
  for (const doc of docs) {
    const t = doc.trim();
    if (!t) continue;
    if (t.length <= 600) chunks.push(t);
    else {
      const paras = t.split(/\\n\\n+/);
      let buf = '';
      for (const p of paras) {
        if ((buf + '\\n\\n' + p).length > 600 && buf) { chunks.push(buf.trim()); buf = p; }
        else buf = buf ? buf + '\\n\\n' + p : p;
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
    const transcript = session.transcript.map((t: any) => \`\${t.speaker}: \${t.text}\`).join('\\n');
    
    let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0, intentSignals: string[] = [], scoreBreakdown: any = {}, keyTopics: string[] = [], summaryHindi = '';

    if (transcript.trim().length > 30) {
      try {
        let { key: geminiApiKey, tier } = geminiKeys.getRestApiKey();
        if (geminiApiKey) {
          const requestBody = JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { text: \`Analyze the following AI voice call transcript.\\nTranscript:\\n\${transcript}\\n\\nReturn JSON exactly matching this format: {"summary":"2-3 sentences","summary_hindi":"Devanagari translation of summary","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":<number 0-100>,"intent_signals":["signal1", "signal2"],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":["topic1", "topic2"],"objections":["obj1"],"recommended_next_action":"..."}\` }
              ]
            }],
            generationConfig: { responseMimeType: "application/json" }
          });
          
          let r = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=\${geminiApiKey}\`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody
          });
          
          if (r.status === 429) {
             geminiKeys.markRateLimited(geminiApiKey, "rest_429");
             const fb = geminiKeys.getRestApiKey();
             r = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=\${fb.key}\`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody
             });
          }
          
          if (r.ok) {
            const data = await r.json();
            const aText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const a = JSON.parse(aText);
            summary = a.summary || ''; summaryHindi = a.summary_hindi || '';
            leadStatus = a.lead_status || 'contacted'; sentiment = a.sentiment || 'neutral';
            leadScore = Math.min(100, Math.max(0, a.lead_score || 0));
            intentSignals = a.intent_signals || [];
            scoreBreakdown = { ...(a.score_breakdown || {}), objections: a.objections || [], recommended_next_action: a.recommended_next_action || '', key_topics: a.key_topics || [], summary_hindi: summaryHindi };
            keyTopics = a.key_topics || [];
            console.log(\`[\${reqId}] 🧠 Score=\${leadScore}, status=\${leadStatus}\`);
          }
        }
      } catch (e: any) { console.error(\`[\${reqId}] AI err: \${e.message}\`); }
    } else { summary = 'Call ended with minimal conversation.'; }

    const custLines = session.transcript.filter((t: any) => t.speaker === 'Customer');
    const custWords = custLines.reduce((a: number, t: any) => a + t.text.split(/\\s+/).length, 0);
    if (custWords <= 5 && duration < 30 && (leadStatus === 'do_not_call' || leadStatus === 'not_interested')) {
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
    }

    let qTier = 'cold', qReason = '';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) { qTier = 'hot'; qReason = \`\${leadScore}/100, \${sentiment}\`; }
    else if (leadScore >= 50) { qTier = 'warm'; qReason = \`\${leadScore}/100\`; }
    else if (leadScore >= 25) { qTier = 'nurture'; qReason = \`\${leadScore}/100\`; }
    else if (['negative', 'very_negative'].includes(sentiment)) qTier = 'disqualified';
    if (leadStatus === 'converted') qTier = 'hot';
    if (leadStatus === 'do_not_call') qTier = 'disqualified';

    const enriched = summary ? \`\${summary}\${summaryHindi ? '\\n\\n🇮🇳 ' + summaryHindi : ''}\\n\\n---\\nScore: \${leadScore}/100 | \${sentiment} | \${qTier} | \${intentSignals.join(', ')}\` : '';

    const callLogQuery = await client.queryObject(\`SELECT * FROM "calllog" WHERE id = $1 LIMIT 1\`, [session.callLogId]);
    const currentLog = callLogQuery.rows[0] as any;
    
    const wasTerminal = currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status);
    await client.queryObject(\`
      UPDATE "calllog" 
      SET status = $1, call_end_time = $2, transcript = $3, duration = $4, lead_status_updated = $5, conversation_summary = $6
      WHERE id = $7
    \`, [
       wasTerminal ? currentLog.status : 'completed',
       wasTerminal ? currentLog.call_end_time : new Date().toISOString(),
       transcript || '',
       duration,
       leadStatus,
       enriched || null,
       session.callLogId
    ]);
    console.log(\`[\${reqId}] 💾 Saved CallLog: \${session.callLogId}, score=\${leadScore}\`);

    const leadId = currentLog?.lead_id || session._leadId;
    if (leadId) {
      try {
        const exQuery = await client.queryObject(\`SELECT * FROM "lead" WHERE id = $1 LIMIT 1\`, [leadId]);
        const ex = exQuery.rows[0] as any;
        if (ex) {
           const merged = [...new Set([...(ex.tags || []), ...keyTopics.slice(0, 10)])];
           await client.queryObject(\`
             UPDATE "lead"
             SET status = $1, score = $2, sentiment = $3, intent_signals = $4, score_breakdown = $5,
                 qualification_tier = $6, qualification_reason = $7, tags = $8,
                 last_call_date = $9, last_engagement_date = $10,
                 engagement_count = $11, notes = $12
             WHERE id = $13
           \`, [
             leadStatus, leadScore, sentiment, JSON.stringify(intentSignals), JSON.stringify(scoreBreakdown),
             qTier, qReason, JSON.stringify(merged),
             new Date().toISOString(), new Date().toISOString(),
             (ex.engagement_count || 0) + 1,
             \`[Score: \${leadScore}/100 | \${sentiment} | \${qTier}] \${summary.substring(0, 300)}\`,
             leadId
           ]);
        }
      } catch (e: any) { console.error(\`[\${reqId}] Lead err: \${e.message}\`); }
    }
  } catch (err: any) { console.error(\`[\${reqId}] ❌ Save: \${err.message}\`); }
}

const streamHandler = (c: any) => {
  const callId = c.req.param("callId") || \`call_\${Date.now()}\`;
  const reqId = Math.random().toString(36).substring(2, 10);
  
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("Expected Upgrade: websocket", 400);
  }

  const { socket: smartfloSocket, response } = Deno.upgradeWebSocket(c.req.raw);

  const initialKey = geminiKeys.getKey();
  if (!initialKey.key) {
    console.error("Missing GEMINI_API_KEY. Terminating call.");
    smartfloSocket.close();
    return response;
  }

  const session: any = {
    callSid: callId,
    callLogId: null,
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
    _leadId: c.req.query("lead_id") || null,
    _agentId: c.req.query("agent_id") || null,
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
       const agentResult = await client.queryObject(\`SELECT client_id, system_prompt, persona FROM "agent" WHERE id = $1 LIMIT 1\`, [agentId]);
       if (agentResult.rows.length > 0) {
          const agent = agentResult.rows[0] as any;
          session.clientId = agent.client_id;
          if (agent.system_prompt) session.systemPrompt = agent.system_prompt;
          if (agent.persona && typeof agent.persona === 'object') {
            const personaObj = agent.persona as any;
            if (personaObj.voice_type) session.voiceType = personaObj.voice_type;
            if (personaObj.human_transfer_number) session.humanTransferNumber = personaObj.human_transfer_number;
            if (personaObj.enable_auto_transfer) session.enableAutoTransfer = personaObj.enable_auto_transfer;
          }
       }
       
       // Load KB
       const kbQuery = await client.queryObject(\`SELECT content, title FROM "knowledge_base" WHERE client_id = $1 AND status = 'ready'\`, [session.clientId]);
       let text = '';
       for (const r of kbQuery.rows as any[]) {
          if (r.content) text += \`[\${r.title}]\\n\${r.content}\\n\\n---\\n\\n\`;
       }
       if (text.length >= 100) {
          session._kbChunks = splitKBIntoChunks(text);
          console.log(\`[\${reqId}] 📚 KB loaded: \${session._kbChunks.length} chunks\`);
       }
     } catch (e) {
       console.error(\`[\${reqId}] Agent config err:\`, e);
     }
     session._agentConfigReady = true;
     if (geminiSocket?.readyState === WebSocket.OPEN) sendGeminiSetup();
  }

  function searchKBChunks(query: string) {
    if (!session._kbChunks?.length) return '';
    const kws = (query || '').toLowerCase().replace(/[^\\w\\s\\u0900-\\u097F]/g, ' ').split(/\\s+/).filter(w => w.length >= 3);
    if (!kws.length) return session._kbChunks.slice(0, 2).join('\\n\\n---\\n\\n');
    const scored = session._kbChunks.map((c: string) => {
      const lo = c.toLowerCase(); let s = 0;
      for (const k of kws) {
        s += lo.split(k).length - 1;
        if (/^\\[.*\\]|^#/.test(c) && lo.substring(0, 100).includes(k)) s += 2;
      }
      return { c, s };
    });
    const top = scored.filter((x: any) => x.s > 0).sort((a: any, b: any) => b.s - a.s).slice(0, 3);
    return top.length ? top.map((x: any) => x.c).join('\\n\\n---\\n\\n') : session._kbChunks.slice(0, 2).join('\\n\\n---\\n\\n');
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
    console.log(\`[\${reqId}] 🔧 \${name}\`);
    if (name === 'search_knowledge_base') {
      const results = searchKBChunks(args.query || '');
      return { results: results || 'No relevant info.' };
    }
    if (name === 'end_call') {
      const elapsed = (Date.now() - session.startTime) / 1000;
      if (elapsed < 10) return { error: 'Call just started. Continue the conversation naturally.' };
      
      const recentCustomer = session.transcript.filter((t: any) => t.speaker === 'Customer').slice(-3).map((t: any) => (t.text || '').toLowerCase()).join(' ');
      const goodbyeRegex = /(bye|goodbye|alvida|namaste|namaskar|dhanyav[aā]d|thank\\s*you|thanks|shukriya|theek\\s*hai\\s*bye|ok\\s*bye|fir\\s*milte|chalo\\s*bye|बाय|अलविदा|धन्यवाद|शुक्रिया|नमस्ते|नमस्कार|फिर मिलते)/i;
      if (!goodbyeRegex.test(recentCustomer)) return { error: 'Customer has NOT said goodbye yet. Continue the conversation.' };
      
      const reason = args.reason || 'conversation_complete';
      session.transcript.push({ speaker: 'System', text: \`[Ended: \${reason}]\` });
      setTimeout(() => {
        session._callEnded = true;
        if (geminiSocket?.readyState === WebSocket.OPEN) geminiSocket.close();
        if (smartfloSocket?.readyState === WebSocket.OPEN) smartfloSocket.close();
      }, 2000);
      return { success: true };
    }
    return { error: \`Unknown: \${name}\` };
  }

  function sendToGemini(msg: any) { if (geminiSocket?.readyState === WebSocket.OPEN) geminiSocket.send(JSON.stringify(msg)); }

  function sendGeminiSetup() {
    if (session._setupSent) return;
    session._setupSent = true;
    const tools = buildGeminiTools();
    const voiceRules = \`[LANGUAGE] Speak ONLY Hindi (Devanagari/Roman) + English (Indian accent). Keep replies SHORT (1-2 sentences).\\n[END-CALL GUARD] Use end_call ONLY after the CUSTOMER clearly says bye/thanks/namaste/dhanyavaad AND has spoken 2+ clear sentences.\`;
    const kbHeader = session._kbChunks.length > 0 ? \`\\n[KB] For any price/product/feature/policy/location fact: CALL search_knowledge_base FIRST. Never guess.\\n\` : '';
    const fullPrompt = voiceRules + '\\n' + kbHeader + '\\n' + session.systemPrompt;

    const setup: any = {
      setup: {
        model: 'models/gemini-2.0-flash-live-preview',
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceType } } } },
        systemInstruction: { parts: [{ text: fullPrompt }] },
      }
    };
    if (tools.length) setup.setup.tools = [{ functionDeclarations: tools }];
    sendToGemini(setup);
    console.log(\`[\${reqId}] 📤 Setup: tools=\${tools.length}, voice=\${session.voiceType}, prompt=\${fullPrompt.length}ch\`);
  }

  const connectGemini = async (isReconnect: boolean = false) => {
    if (geminiSocket && !isReconnect) return;
    if (isReconnect && geminiSocket) { try { geminiSocket.close(); } catch (_) {} geminiSocket = null; }

    const { url: WS_URL, key, tier } = geminiKeys.getWebSocketUrl();
    currentGeminiKey = key;
    geminiSocket = new WebSocket(WS_URL);

    geminiSocket.onopen = async () => {
      console.log(\`[\${reqId}] 🔌 Gemini Connected\`);
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
          console.log(\`[\${reqId}] ✅ Gemini setupComplete (buffered=\${session._audioBuffer.length})\`);
          
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
              console.log(\`[\${reqId}] 🗣️ "\${t.substring(0, 200)}"\`);
              session.transcript.push({ speaker: 'Customer', text: t });
              session._pendingCustomerText = '';
            }
            if (session._pendingAiText) {
              const t = session._pendingAiText.trim();
              console.log(\`[\${reqId}] 🤖 "\${t.substring(0, 200)}"\`);
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
        console.error(\`[\${reqId}] Gemini error handling msg:\`, e);
      }
    };

    geminiSocket.onerror = (e) => console.error(\`[\${reqId}] Gemini WS Error\`, e);

    geminiSocket.onclose = (event) => {
      console.log(\`[\${reqId}] 🔴 Gemini Disconnected (code: \${event.code})\`);
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

  smartfloSocket.onopen = () => console.log(\`[\${reqId}] Smartflo Connected\`);

  smartfloSocket.onmessage = async (event) => {
    try {
      if (typeof event.data === "string") {
        const payload = JSON.parse(event.data);
        if (payload.stream_id || payload.streamSid) streamId = payload.stream_id || payload.streamSid;
        
        if (payload.event === "start" || payload.event === "connected") {
           let resolvedAgentId = session._agentId;
           const customIdentifier = payload.start?.customData || payload.customData || payload.custom_identifier || "";
           const customerNumber = payload.start?.calledNumber || payload.customerNumber || "";

           if (!resolvedAgentId) {
             if (customIdentifier) {
               try {
                 const callLog = await base44.entities.CallLog.get(customIdentifier);
                 if (callLog) {
                   resolvedAgentId = callLog.agent_id;
                   session.callLogId = customIdentifier;
                   if (!session._leadId && callLog.lead_id) session._leadId = callLog.lead_id;
                 }
               } catch(e) {}
             }
             if (!resolvedAgentId && customerNumber) {
               try {
                 const cleanDid = customerNumber.replace(/[^0-9]/g, '').slice(-10);
                 const didRes = await client.queryObject(\`SELECT id FROM "agent" WHERE assigned_did LIKE $1 OR assigned_dids::text LIKE $1 LIMIT 1\`, [\`%\${cleanDid}%\`]);
                 if (didRes.rows.length > 0) resolvedAgentId = (didRes.rows[0] as any).id;
               } catch(e) {}
             }
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
    } catch (e) { console.error(\`[\${reqId}] Smartflo parse err:\`, e); }
  };

  smartfloSocket.onclose = async () => {
    console.log(\`[\${reqId}] Smartflo Disconnected\`);
    session._callEnded = true;
    if (geminiSocket && geminiSocket.readyState === WebSocket.OPEN) geminiSocket.close();
    
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    if (session.callLogId) {
      await saveCallRecord(session, reqId, duration);
    } else if (session._leadId) {
      await client.queryObject(\`UPDATE "lead" SET last_call_date = $1 WHERE id = $2\`, [new Date().toISOString(), session._leadId]);
    }
  };

  smartfloSocket.onerror = (e) => console.error(\`[\${reqId}] Smartflo WS Error:\`, e);

  return response;
};
`;

fs.writeFileSync('voice_new.ts', topPart + '\n' + newMiddle + '\n' + bottomPart);
console.log("Generated voice_new.ts");
