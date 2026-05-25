import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const SMARTFLO_TOKEN_TTL_MS = 50 * 60 * 1000;
let _smartfloTokenCache = { token: null, expiresAt: 0, inFlight: null, blockedUntil: 0 };

async function getSmartfloToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _smartfloTokenCache.token && _smartfloTokenCache.expiresAt > now) return _smartfloTokenCache.token;
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
    } catch (e) { return null; }
    finally { _smartfloTokenCache.inFlight = null; }
  })();
  return _smartfloTokenCache.inFlight;
}

function decodeMulaw(m) { const B=33;let u=~m&0xFF;return ((u&0x80)?-1:1)*((((u&0x0F)<<3)+B)<<((u>>4)&0x07))-B; }
function encodeMulaw(s) { const M=32635,B=33;const sn=s<0?0x80:0;if(s<0)s=-s;if(s>M)s=M;s+=B;let e=7;for(;e>0;e--){if(s&0x4000)break;s<<=1;}return ~(sn|(e<<4)|((s>>10)&0x0F))&0xFF; }

function mulawToBase64PCM16_24k(mb, ast) {
  const p8 = new Int16Array(mb.length);
  for(let i=0;i<mb.length;i++) p8[i] = decodeMulaw(mb[i]);
  const p24 = new Int16Array(p8.length * 3);
  for(let i=0;i<p8.length;i++) {
    const s0 = i===0 ? ast.lastUpsampleValue : p8[i-1], s1 = p8[i], s2 = i<p8.length-1 ? p8[i+1] : s1;
    p24[i*3] = s1; p24[i*3+1] = Math.round(s1+(s2-s0)/6); p24[i*3+2] = Math.round(s1+(s2-s0)/3);
  }
  if(p8.length>0) ast.lastUpsampleValue = p8[p8.length-1];
  const buf = new Uint8Array(p24.length * 2), vw = new DataView(buf.buffer);
  for(let i=0;i<p24.length;i++) vw.setInt16(i*2, p24[i], true);
  let bin = ''; for(let i=0;i<buf.length;i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

function base64PCM16_24kToMulaw(b64, ast) {
  const rw = atob(b64), bs = new Uint8Array(rw.length);
  for(let i=0;i<rw.length;i++) bs[i] = rw.charCodeAt(i);
  const n = Math.floor(bs.length/2), vw = new DataView(bs.buffer, bs.byteOffset, bs.byteLength);
  const rem = ast.lastDownsampleRemainder, all = new Int16Array(rem.length + n);
  for(let i=0;i<rem.length;i++) all[i] = rem[i];
  for(let i=0;i<n;i++) all[rem.length+i] = vw.getInt16(i*2, true);
  const dl = Math.floor(all.length/3), mu = new Uint8Array(dl);
  for(let i=0;i<dl;i++) {
    const idx=i*3, p=idx>0?all[idx-1]:all[idx], c=all[idx], nx=idx+1<all.length?all[idx+1]:c;
    mu[i] = encodeMulaw(Math.max(-32768, Math.min(32767, Math.round((p+2*c+nx)/4))));
  }
  const nr = []; for(let i=dl*3;i<all.length;i++) nr.push(all[i]);
  ast.lastDownsampleRemainder = nr;
  return mu;
}

async function saveCallRecord(session, reqId, duration) {
  if (!session.callLogId || session._saved) return;
  session._saved = true;

  try {
    const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
    const sdkMod = session._sdkModule || await import('npm:@base44/sdk@0.8.23');
    const serviceClient = sdkMod.createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    
    let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0;
    let intentSignals = [], scoreBreakdown = {}, keyTopics = [];

    if (transcript && transcript.trim().length > 30) {
      try {
        const rawEndpoint = Deno.env.get('AZURE_OPENAI_ENDPOINT') || '';
        let baseUrl = rawEndpoint.replace(/\/+$/, '');
        const openaiIdx = baseUrl.indexOf('/openai/');
        if (openaiIdx > 0) baseUrl = baseUrl.substring(0, openaiIdx);
        const dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT'), ak = Deno.env.get('AZURE_OPENAI_KEY');
        const res = await fetch(`${baseUrl}/openai/deployments/${dep}/chat/completions?api-version=2024-08-01-preview`, {
          method: 'POST', headers: { 'api-key': ak, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'Analyze call transcript and return JSON with summary, lead_status, sentiment, lead_score, intent_signals, key_topics.' },
              { role: 'user', content: `Analyze:\n\n${transcript}\n\nReturn JSON:` }
            ],
            max_completion_tokens: 800, response_format: { type: "json_object" }
          })
        });
        if (res.ok) {
          const analysis = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');
          summary = analysis.summary || '';
          leadStatus = analysis.lead_status || 'contacted';
          sentiment = analysis.sentiment || 'neutral';
          leadScore = Math.min(100, Math.max(0, analysis.lead_score || 0));
          intentSignals = analysis.intent_signals || [];
          keyTopics = analysis.key_topics || [];
        }
      } catch (e) {}
    } else { summary = 'Call ended with minimal or no conversation.'; }

    let qualificationTier = 'cold';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) { qualificationTier = 'hot'; }
    else if (leadScore >= 50) { qualificationTier = 'warm'; }
    else if (leadScore >= 25) { qualificationTier = 'nurture'; }
    else if (['negative', 'very_negative'].includes(sentiment)) { qualificationTier = 'disqualified'; }

    const customerWords = session.transcript.filter(t => t.speaker === 'Customer').reduce((a, t) => a + t.text.split(/\s+/).length, 0);
    if (customerWords <= 5 && duration < 30 && ['do_not_call', 'not_interested'].includes(leadStatus)) {
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
      qualificationTier = 'cold';
    }
    if (leadStatus === 'do_not_call') { qualificationTier = 'disqualified'; }

    const currentLog = await serviceClient.entities.CallLog.get(session.callLogId);
    const enrichedSummary = summary ? `${summary}\n\n---\nScore: ${leadScore}/100 | Tier: ${qualificationTier}` : '';

    if (currentLog && ['completed', 'failed', 'no_answer'].includes(currentLog.status)) {
      await serviceClient.entities.CallLog.update(session.callLogId, { transcript: transcript || '', duration, lead_status_updated: leadStatus, conversation_summary: enrichedSummary || summary || '' });
    } else {
      await serviceClient.entities.CallLog.update(session.callLogId, { status: 'completed', transcript: transcript || '', duration, call_end_time: new Date().toISOString(), lead_status_updated: leadStatus, conversation_summary: enrichedSummary || summary || '' });
    }

    if (currentLog?.lead_id) {
      const existingLead = await serviceClient.entities.Lead.get(currentLog.lead_id);
      const mergedTags = [...new Set([...(existingLead.tags || []), ...keyTopics.slice(0, 10)])];
      await serviceClient.entities.Lead.update(currentLog.lead_id, {
        status: leadStatus, score: leadScore, sentiment, intent_signals: intentSignals,
        qualification_tier: qualificationTier, tags: mergedTags,
        last_call_date: new Date().toISOString(), last_engagement_date: new Date().toISOString(),
        engagement_count: (existingLead.engagement_count || 0) + 1,
        notes: `[Score: ${leadScore}/100] ${summary.substring(0, 300)}`
      }).catch(e => {});
    }

    if (session._personalMode && session._personalClientId) {
      try {
        const cLines = session.transcript.filter(t => t.speaker === 'Customer').map(t => t.text);
        const msgText = cLines.join(' ').substring(0, 1000) || summary;
        await serviceClient.entities.VoicemailMessage.create({ client_id: session._personalClientId, call_log_id: session.callLogId, caller_number: currentLog?.caller_id || currentLog?.callee_number || '', message: summary || msgText, is_read: false });
      } catch (e) {}
    }

    if (transcript.length > 50) {
      serviceClient.functions.invoke('postCallActionExtractor', { call_log_id: session.callLogId }).catch(e => {});
    }
  } catch (err) {}
}

Deno.serve(async (req) => {
  const reqId = Math.random().toString(36).substring(2, 10);
  const isWebSocket = (req.headers.get('upgrade') || '').toLowerCase() === 'websocket';
  let base44Req = req;
  if (!req.headers.get('Base44-App-Id')) {
    const newHeaders = new Headers(req.headers);
    newHeaders.set('Base44-App-Id', Deno.env.get('BASE44_APP_ID'));
    base44Req = new Request(req.url, { method: req.method, headers: newHeaders });
  }
  createClientFromRequest(base44Req);

  if (!isWebSocket) {
    const host = req.headers.get('host') || req.headers.get('x-forwarded-host') || 'localhost';
    return new Response(JSON.stringify({ sucess: true, wss_url: `wss://${host}/functions/streamAudioInboundGemini` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  let smartfloSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    smartfloSocket = upgraded.socket;
    response = upgraded.response;
  } catch (err) { return new Response('WebSocket upgrade failed', { status: 500 }); }

  const session = {
    streamSid: null, callSid: null, callLogId: null, clientId: null,
    transcript: [], startTime: Date.now(),
    systemPrompt: '', greetingMessage: '', voiceType: 'Aoede',
    smartfloCallId: null, realtimeWs: null, realtimeReady: false, isSpeaking: false,
    tools: [], hasShopify: false, humanTransferNumber: '', enableAutoTransfer: true,
    agentId: null, kbFileUri: '', _realtimeReconnectAttempts: 0, _callEnded: false,
    _audioState: { lastUpsampleValue: 0, lastDownsampleRemainder: [] },
    _mediaBuffer: [], _mediaBufferMaxBytes: 256 * 1024, _mediaBufferBytes: 0, _mediaBufferFlushed: false,
    _greetingSent: false, _phase1Applied: false, _fastConfigReady: false
  };

  function connectRealtime() {
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiKey) return;
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${geminiKey}`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      session._realtimeReconnectAttempts = 0;
      session._lastRealtimeOpenTs = Date.now();
      if (session._fastConfigReady) triggerPhase1Greeting();
    };
    ws.onmessage = (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        handleGeminiMessage(JSON.parse(text));
      } catch (err) {}
    };
    ws.onclose = () => {
      session.realtimeReady = false;
      const stableMs = session._lastRealtimeOpenTs ? (Date.now() - session._lastRealtimeOpenTs) : 0;
      if (stableMs > 30000 && session._realtimeReconnectAttempts > 0) session._realtimeReconnectAttempts = 0;
      const RECONNECT_DELAYS_MS = [500, 1500, 3000, 6000, 10000, 15000];
      if (!session._callEnded && session._realtimeReconnectAttempts < RECONNECT_DELAYS_MS.length) {
        setTimeout(() => { if (!session._callEnded) connectRealtime(); }, RECONNECT_DELAYS_MS[session._realtimeReconnectAttempts++]);
      }
    };
    session.realtimeWs = ws;
  }

  async function hangupCall(reason) {
    session._callEnded = true;
    try {
      const tk = await getSmartfloToken();
      if (tk) {
        const liveCallId = await findLiveCallId(tk);
        const candidates = [...new Set([liveCallId, session.smartfloCallId, session.callSid].filter(Boolean))];
        for (const cid of candidates) {
          const hr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/hangup', {
            method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
            body: JSON.stringify({ call_id: cid })
          });
          if (hr.ok && (await hr.json().catch(()=>({}))).success !== false) break;
        }
      }
    } catch (e) {}
    if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
  }

  async function findLiveCallId(token) {
    try {
      const r = await fetch('https://api-smartflo.tatateleservices.com/v1/live_calls', { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
      if (!r.ok) return null;
      const d = await r.json();
      const calls = Array.isArray(d) ? d : (d.data || []);
      const ce = (session.calleeNumber || '').replace(/\D/g, '').slice(-10);
      const cr = (session.callerNumber || '').replace(/\D/g, '').slice(-10);
      const m = calls.find(c => {
        const cn = (c.customer_number || '').replace(/\D/g, '').slice(-10);
        const did = (c.did || '').replace(/\D/g, '').slice(-10);
        return (ce && (cn === ce || did === ce)) || (cr && (cn === cr || did === cr));
      });
      return m?.call_id || null;
    } catch (_) { return null; }
  }

  function buildGeminiTools() {
    const tools = [];
    tools.push({ name: 'end_call', description: 'End the call.', parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING' } }, required: ['reason'] } });
    if (session.humanTransferNumber) {
      tools.push({ name: 'transfer_to_human', description: 'Transfer to a human agent.', parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING' } }, required: ['reason'] } });
    }
    if (session.hasShopify) {
      tools.push({ name: 'shopify_lookup', description: 'Lookup Shopify orders, products, etc.', parameters: { type: 'OBJECT', properties: { lookup_type: { type: 'STRING', enum: ['order_by_number', 'order_by_phone', 'order_by_email', 'product_search', 'refund_status', 'tracking'] }, query: { type: 'STRING' } }, required: ['lookup_type', 'query'] } });
    }
    if (session.kbFileUri && session.agentId) {
      tools.push({ name: 'search_knowledge_base', description: 'Search business knowledge base.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } });
    }
    return tools.length > 0 ? [{ functionDeclarations: tools }] : [];
  }

  async function executeToolCall(callId, functionName, argsStr) {
    let result = { error: `Unknown tool: ${functionName}` };
    if (functionName === 'end_call') {
      result = { success: true };
      sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } });
      setTimeout(() => hangupCall('ended'), 1500);
      return;
    }
    if (functionName === 'transfer_to_human' && session.humanTransferNumber) {
      try {
        const tk = await getSmartfloToken();
        if (tk) {
          const liveCallId = await findLiveCallId(tk) || session.smartfloCallId || session.callSid;
          const tr = await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {
            method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
            body: JSON.stringify({ type: 4, call_id: liveCallId, intercom: String(session.humanTransferNumber) })
          });
          if (tr.ok) {
            result = { success: true, message: 'Transferring...' };
            if (session.callLogId) {
              const { createClient } = await import('npm:@base44/sdk@0.8.23');
              createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true }).entities.CallLog.update(session.callLogId, { transferred_to: `Human (intercom: ${session.humanTransferNumber})` }).catch(()=>{});
            }
          } else { result = { error: 'Transfer failed' }; }
        } else { result = { error: 'Auth failed' }; }
      } catch (err) { result = { error: err.message }; }
      sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } });
      return;
    }
    if (functionName === 'search_knowledge_base' && session.agentId && session.kbFileUri) {
      try {
        const args = JSON.parse(argsStr);
        const { createClient } = await import('npm:@base44/sdk@0.8.23');
        const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
        const kbResp = await svc.functions.invoke('kbSearch', { agent_id: session.agentId, query: args.query || '', top_k: 3, _internal: true });
        const data = kbResp?.data || {};
        if (data.success && data.results?.length > 0) {
          result = { passages: data.results.map((r, i) => `[Passage ${i+1}]\n${r.content}`).join('\n\n'), count: data.results.length };
        } else {
          result = { passages: '', count: 0, message: 'No info found.' };
        }
      } catch (err) { result = { error: 'KB search failed' }; }
      sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: result }] } });
      return;
    }
    sendToRealtime({ toolResponse: { functionResponses: [{ id: callId, name: functionName, response: { error: 'Not implemented' } }] } });
  }

  function triggerPhase1Greeting() {
    if (session._greetingSent || session._phase1Applied) return;
    const greeting = session.greetingMessage || '';
    session._phase1Applied = true;
    session._greetingSent = true;
    if (greeting) session.transcript.push({ speaker: 'AI', text: greeting });
    
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
    const timeInjection = `\n[LIVE CLOCK] Current date and time in India (IST): ${nowIST}.\n`;
    const noiseHandling = `\n[AUDIO RULES] You are on a PHONE CALL in India. Only respond to CLEAR human speech. Keep replies SHORT (1-2 sentences).\n`;
    let transferInstr = (session.humanTransferNumber && session.enableAutoTransfer) ? `\n\nUse transfer_to_human when caller asks for a human.` : '';
    const tools = buildGeminiTools();
    const setupMsg = {
      setup: {
        model: "models/gemini-2.0-flash-lite-preview-02-27",
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceType || "Aoede" } } } },
        systemInstruction: { parts: [{ text: timeInjection + noiseHandling + session.systemPrompt + transferInstr }] }
      }
    };
    if (tools.length > 0) setupMsg.setup.tools = tools;
    sendToRealtime(setupMsg);
    
    const greetingMsg = greeting ? `[SYSTEM: Say this exact greeting: "${greeting}"]` : `[SYSTEM: The call just connected. Greet warmly.]`;
    sendToRealtime({ clientContent: { turns: [{ role: 'user', parts: [{ text: greetingMsg }] }], turnComplete: true } });
  }

  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) session.realtimeWs.send(JSON.stringify(msg));
  }

  function sendMulawToSmartflo(mulawBytes) {
    const CHUNK_SIZE = 960;
    for (let i = 0; i < mulawBytes.length; i += CHUNK_SIZE) {
      let chunk = mulawBytes.slice(i, Math.min(i + CHUNK_SIZE, mulawBytes.length));
      if (chunk.length % 160 !== 0) {
        const padded = new Uint8Array(Math.ceil(chunk.length / 160) * 160);
        padded.set(chunk); padded.fill(0xFF, chunk.length); chunk = padded;
      }
      let binary = ''; for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
      smartfloSocket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: btoa(binary) } }));
    }
  }

  function handleGeminiMessage(msg) {
    if (msg.setupComplete) { session.realtimeReady = true; return; }
    if (msg.serverContent?.modelTurn) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData && part.inlineData.data) {
          session.isSpeaking = true;
          if (smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) sendMulawToSmartflo(base64PCM16_24kToMulaw(part.inlineData.data, session._audioState));
        }
        if (part.text) session.transcript.push({ speaker: 'AI', text: part.text.trim() });
        if (part.functionCall) executeToolCall(part.functionCall.id, part.functionCall.name, JSON.stringify(part.functionCall.args || {}));
      }
    }
    if (msg.serverContent?.turnComplete) session.isSpeaking = false;
    if (msg.serverContent?.interrupted && smartfloSocket.readyState === WebSocket.OPEN && session.streamSid) {
      smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
      session.isSpeaking = false;
    }
    if (msg.toolCall) {
       for (const call of msg.toolCall.functionCalls || []) executeToolCall(call.id, call.name, JSON.stringify(call.args || {}));
    }
  }

  async function loadInboundAgent() {
    try {
      const { createClient } = await import('npm:@base44/sdk@0.8.23');
      const svc = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
      const callerDID = (session.callerNumber || '').replace(/[^0-9]/g, '').slice(-10);
      const cleanCalleeDID = (session.calleeNumber || '').replace(/[^0-9]/g, '').slice(-10);
      if (!cleanCalleeDID && !callerDID) return;

      const allDIDs = await svc.entities.DID.list('-created_date', 200).catch(()=>[]);
      const matchedDID = allDIDs.find(d => { const n = (d.number || '').replace(/\D/g, '').slice(-10); return n === cleanCalleeDID || n === callerDID; });
      
      let didAgent = null, didClient = null;
      if (matchedDID?.agent_id) didAgent = await svc.entities.Agent.get(matchedDID.agent_id).catch(()=>null);
      if (matchedDID?.client_id) didClient = await svc.entities.Client.get(matchedDID.client_id).catch(()=>null);

      if (!didAgent) {
        const allAgents = await svc.entities.Agent.list('-created_date', 100).catch(()=>[]);
        didAgent = allAgents.find(a => {
          const dids = (a.assigned_dids || []).concat(a.assigned_did ? [a.assigned_did] : []);
          return dids.some(d => { const n = (d || '').replace(/\D/g, '').slice(-10); return n === cleanCalleeDID || n === callerDID; });
        });
      }
      if (!didAgent) return;
      
      session.agentId = didAgent.id;
      session.clientId = didAgent.client_id;
      if (didAgent.persona?.voice_type) session.voiceType = didAgent.persona.voice_type;
      if (didAgent.greeting_message) session.greetingMessage = didAgent.greeting_message;
      if (didAgent.system_prompt) session.systemPrompt = didAgent.system_prompt;
      if (didAgent.human_transfer_number) session.humanTransferNumber = didAgent.human_transfer_number;
      if (didAgent.kb_file_uri) session.kbFileUri = didAgent.kb_file_uri;

      const newLog = await svc.entities.CallLog.create({
        client_id: session.clientId, agent_id: didAgent.id,
        call_sid: session.callSid || `inbound_${Date.now()}`, stream_sid: session.streamSid,
        caller_id: session.callerNumber, callee_number: session.calleeNumber,
        direction: 'inbound', status: 'answered', call_start_time: new Date().toISOString()
      }).catch(()=>null);
      
      if (newLog) session.callLogId = newLog.id;

      session._fastConfigReady = true;
      if (session.realtimeReady) triggerPhase1Greeting();
    } catch (e) {}
  }

  connectRealtime();

  smartfloSocket.onopen = () => {};
  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.event === 'connected') return;
      if (msg.event === 'start') {
        const startData = msg.start || {};
        session.streamSid = startData.streamSid; session.callSid = startData.callSid;
        session.calleeNumber = startData.customParameters?.customer_number || startData.to || '';
        session.callerNumber = startData.from || '';
        if (startData.customParameters?.customer_number) { smartfloSocket.close(); return; } // reject outbound
        loadInboundAgent();
        return;
      }
      if (msg.event === 'media' && msg.media?.payload) {
        const raw = atob(msg.media.payload);
        const mulawBytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) mulawBytes[i] = raw.charCodeAt(i);
        if (!session.realtimeReady) return;
        const pcm16Base64 = mulawToBase64PCM16_24k(mulawBytes, session._audioState);
        sendToRealtime({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=24000", data: pcm16Base64 }] } });
      }
      if (msg.event === 'stop') {
        session._callEnded = true;
        if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
        await saveCallRecord(session, reqId, Math.round((Date.now() - session.startTime) / 1000));
      }
    } catch (e) {}
  };
  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    if (session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
    if (session.callLogId) await saveCallRecord(session, reqId, Math.round((Date.now() - session.startTime) / 1000));
  };
  return response;
});