import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════════
// streamSignalWireOutgoing — Bridges SignalWire Media Streams ↔ Azure
// GPT-Realtime GA. Wire-compatible clone of streamTwilioOutgoing because
// SignalWire's LaML <Stream> protocol matches Twilio's exactly (mulaw 8kHz,
// 160-byte / 20ms frames, same JSON event shape).
// ═══════════════════════════════════════════════════════════════════════════

function decodeMulaw(b) { const BIAS=33; let mu=~b&0xFF; const sign=(mu&0x80)?-1:1, exp=(mu>>4)&0x07, mant=mu&0x0F; let s=((mant<<3)+BIAS)<<exp; s-=BIAS; return sign*s; }
function encodeMulaw(s) { const MAX=32635, BIAS=33; const sign=s<0?0x80:0; if(s<0)s=-s; if(s>MAX)s=MAX; s+=BIAS; let exp=7; for(;exp>0;exp--){if(s&0x4000)break; s<<=1;} const mant=(s>>10)&0x0F; return ~(sign|(exp<<4)|mant)&0xFF; }
function mulawToBase64PCM16_24k(mb, st) {
  const len=mb.length; const p8=new Int16Array(len); for(let i=0;i<len;i++)p8[i]=decodeMulaw(mb[i]);
  const p24=new Int16Array(len*3);
  for(let i=0;i<len;i++){const prev=i===0?st.prevUpsample:p8[i-1], curr=p8[i]; p24[i*3]=Math.round(prev+(curr-prev)*(1/3)); p24[i*3+1]=Math.round(prev+(curr-prev)*(2/3)); p24[i*3+2]=curr;}
  if(len>0)st.prevUpsample=p8[len-1];
  const buf=new Uint8Array(p24.length*2); const dv=new DataView(buf.buffer);
  for(let i=0;i<p24.length;i++)dv.setInt16(i*2,p24[i],true);
  let bin=''; for(let i=0;i<buf.length;i++)bin+=String.fromCharCode(buf[i]); return btoa(bin);
}
function base64PCM16_24kToMulaw(b64, st) {
  const raw=atob(b64); const bytes=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  const num=Math.floor(bytes.length/2); const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const rem=st.downRemainder; const total=rem.length+num; const all=new Int16Array(total);
  for(let i=0;i<rem.length;i++)all[i]=rem[i];
  for(let i=0;i<num;i++)all[rem.length+i]=view.getInt16(i*2,true);
  const outLen=Math.floor(total/3); const mu=new Uint8Array(outLen);
  for(let i=0;i<outLen;i++){const c=i*3; const f=Math.round((all[c]+all[c+1]+all[c+2])/3); mu[i]=encodeMulaw(Math.max(-32768,Math.min(32767,f)));}
  const consumed=outLen*3; const newRem=[]; for(let i=consumed;i<total;i++)newRem.push(all[i]); st.downRemainder=newRem;
  return mu;
}
function uint8ToBase64(b) { let bin=''; for(let i=0;i<b.length;i++)bin+=String.fromCharCode(b[i]); return btoa(bin); }

function isHallucinatedScript(text) {
  if (!text || text.length < 2) return true;
  const forbidden = /[\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u0600-\u06FF\u0E00-\u0E7F\u0400-\u04FF]/;
  if (forbidden.test(text)) return true;
  const allowed = /[a-zA-Z\u0900-\u097F]/;
  if (!allowed.test(text)) return true;
  return false;
}

let _sdkPromise = null;
function getSDK() { if(!_sdkPromise) _sdkPromise = import('npm:@base44/sdk@0.8.31'); return _sdkPromise; }
getSDK().catch(()=>{});

function splitKB(content) {
  if(!content || content.length<100) return [];
  const out=[]; for(const doc of content.split(/\n---\n/)){const t=doc.trim(); if(!t) continue; if(t.length<=600){out.push(t); continue;} let buf=''; for(const p of t.split(/\n\n+/)){if((buf+'\n\n'+p).length>600 && buf){out.push(buf.trim()); buf=p;} else buf=buf?buf+'\n\n'+p:p;} if(buf.trim()) out.push(buf.trim());}
  return out.filter(c=>c.length>=30);
}

async function saveCallRecord(session, reqId, duration) {
  if(!session.callLogId || session._saved) return; session._saved = true;
  try {
    const transcript = session.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
    const { createClient } = await getSDK();
    const svc = base44;;
    let baseUrl = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
    const oi = baseUrl.indexOf('/openai/'); if(oi>0) baseUrl = baseUrl.substring(0, oi);
    const pi = baseUrl.indexOf('/api/projects'); if(pi>0) baseUrl = baseUrl.substring(0, pi);
    const dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT'), key = Deno.env.get('AZURE_OPENAI_KEY');
    let summary='', leadStatus='contacted', sentiment='neutral', leadScore=0, intentSignals=[], scoreBreakdown={}, keyTopics=[];
    if(transcript.trim().length>30 && baseUrl && dep && key){
      try {
        const r = await fetch(`${baseUrl}/openai/deployments/${dep}/chat/completions?api-version=2025-04-01-preview`, {
          method:'POST', headers:{'api-key':key,'Content-Type':'application/json'},
          body: JSON.stringify({
            messages: [
              { role:'system', content:'Expert sales call analyst. Score 0-100. JSON only.' },
              { role:'user', content:`Transcript:\n${transcript}\n\nReturn JSON: {"summary":"2-3 sentences","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":[],"objections":[],"recommended_next_action":"..."}` }
            ], max_completion_tokens: 800, response_format:{type:'json_object'}
          })
        });
        if(r.ok){
          const a = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
          summary=a.summary||''; leadStatus=a.lead_status||'contacted'; sentiment=a.sentiment||'neutral';
          leadScore=Math.min(100,Math.max(0,a.lead_score||0)); intentSignals=a.intent_signals||[];
          scoreBreakdown={...(a.score_breakdown||{}), objections:a.objections||[], recommended_next_action:a.recommended_next_action||'', key_topics:a.key_topics||[]};
          keyTopics=a.key_topics||[];
        }
      } catch(_){}
    } else summary='Call ended with minimal conversation.';

    let qTier='cold', qReason='';
    if(leadScore>=75 && ['very_positive','positive'].includes(sentiment)){qTier='hot'; qReason=`${leadScore}/100, ${sentiment}`;}
    else if(leadScore>=50){qTier='warm'; qReason=`${leadScore}/100`;}
    else if(leadScore>=25){qTier='nurture'; qReason=`${leadScore}/100`;}
    else if(['negative','very_negative'].includes(sentiment)) qTier='disqualified';
    if(leadStatus==='converted') qTier='hot'; if(leadStatus==='do_not_call') qTier='disqualified';

    const enriched = summary?`${summary}\n\n---\nScore: ${leadScore}/100 | ${sentiment} | ${qTier} | ${intentSignals.join(', ')}`:'';
    const cur = await svc.entities.CallLog.get(session.callLogId);
    const term = cur && ['completed','failed','no_answer'].includes(cur.status);
    const callLogUpdate = {
      ...(term?{}:{status:'completed', call_end_time:new Date().toISOString()}),
      transcript: transcript||'', duration, lead_status_updated: leadStatus,
      ...(enriched?{conversation_summary: enriched}:{})
    };
    // ── POSTGRES-PRIMARY WRITE ── transcript + summary survive a Base44 429.
    try { await svc.functions.invoke('pgLeadSync', { call_log: { ...cur, ...callLogUpdate } }); }
    catch (pgErr) { console.error(`[${reqId}] ⚠️ PG-primary write failed: ${pgErr.message}`); }
    await svc.entities.CallLog.update(session.callLogId, callLogUpdate);
    console.log(`[${reqId}] 💾 Saved (signalwire): ${session.callLogId}, score=${leadScore}`);

    const lid = cur.lead_id || session._leadId;
    if(lid){
      try {
        const ex = await svc.entities.Lead.get(lid);
        const merged = [...new Set([...(ex.tags||[]), ...keyTopics.slice(0,10)])];
        await svc.entities.Lead.update(lid, {
          status:leadStatus, score:leadScore, sentiment, intent_signals:intentSignals, score_breakdown:scoreBreakdown,
          qualification_tier:qTier, qualification_reason:qReason, tags:merged,
          last_call_date:new Date().toISOString(), last_engagement_date:new Date().toISOString(),
          engagement_count: (ex.engagement_count||0)+1,
          notes: `[Score: ${leadScore}/100 | ${sentiment} | ${qTier}] ${summary.substring(0,300)}`
        });
      } catch(_){}
    }
    if(transcript.length>50) svc.functions.invoke('postCallActionExtractor',{call_log_id:session.callLogId}).catch(()=>{});
  } catch(err){ console.error(`[${reqId}] ❌ Save: ${err.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════
// UNIVERSAL BEHAVIOR PREAMBLE (Phase 3) — shared across all Realtime streams.
// ═══════════════════════════════════════════════════════════════════════
const REALTIME_FEMALE_VOICES = new Set(['shimmer','coral','sage','ballad']);
function buildRealtimePreamble({ hasKB, voiceType }) {
  const isFemale = REALTIME_FEMALE_VOICES.has((voiceType || '').toLowerCase());
  const now = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const lines = [
    `[LIVE CLOCK] ${now}.`,
    `[BEHAVIOR]`,
    `• MIRROR the caller: reply in the SAME language they use. If they switch, you switch.`,
    `• Sound warm, natural and human — vary your tone, never robotic or monotone.`,
    `• Only respond to clear directed speech. Ignore background noise/chatter.`,
    `• Identity (name/company) is FIXED — never change.`,
    `• Address the caller respectfully — "Sir" (male) or "Ma'am" (female) when unsure of their name; neutral if unsure of gender.`,
    isFemale ? `• You have a female voice.` : `• You have a male voice.`,
    hasKB ? `[MANDATORY TOOL USE]\nFor ANY specific fact — price, product, feature, policy, location — CALL search_knowledge_base BEFORE answering. NEVER guess. NEVER mention "knowledge base", "database", "tool", "system", "AI", "bot" to the caller. If it returns nothing, offer to send details on WhatsApp.` : ''
  ];
  return lines.filter(l => l !== '').join('\n') + '\n\n';
}

export default async function streamSignalWireOutgoing(c: any) {
  const req = c.req.raw || c.req;
  const reqId = Math.random().toString(36).substring(2, 10);
  const isWS = (req.headers.get('upgrade')||'').toLowerCase()==='websocket';
  console.log(`[${reqId}] 📨 ${req.method} (signalwire-outgoing), ws=${isWS}`);
  if(!isWS){
    const host = req.headers.get('host')||'localhost';
    return c.json({ data: { success:true, wss_url:`wss://${host}/functions/streamSignalWireOutgoing`, flow:'signalwire-outgoing-realtime-ga' } }, 200);
  }

  let swSocket, response;
  try { const u=Deno.upgradeWebSocket(req); swSocket=u.socket; response=u.response; }
  catch(_){ return new Response('WS upgrade failed', { status:500 }); }

  const session = {
    streamSid:null, callSid:null, callLogId:null, clientId:null,
    transcript:[], startTime:Date.now(),
    systemPrompt:'You are a professional AI voice assistant.',
    greetingMessage:'', voiceType:'alloy',
    _saved:false, realtimeWs:null, realtimeReady:false,
    isSpeaking:false, tools:[],
    humanTransferNumber:'', enableAutoTransfer:true,
    _realtimeReconnectAttempts:0, _callEnded:false, _agentConfigReady:false,
    calleeNumber:'', callerNumber:'',
    _kbChunks:[], _kbFileUri:'', _kbLoadPromise:null, _leadId:null, _agentId:null, _toolFlags:{},
    _resampleState:{ prevUpsample:0, downRemainder:[] },
    _audioBuffer:[]
  };

  let _svc=null;
  async function getSvc(){ if(_svc) return _svc; const {createClient}=await getSDK(); _svc=createClient({appId:Deno.env.get('BASE44_APP_ID'), asServiceRole:true}); return _svc; }

  async function loadKBLazy(){
    if(session._kbChunks.length>0) return;
    if(session._kbLoadPromise){ await session._kbLoadPromise; return; }
    session._kbLoadPromise = (async()=>{
      if(session._kbFileUri && session._kbFileUri.startsWith('azblob://')){
        try {
          const { BlobServiceClient } = await import('npm:@azure/storage-blob@12.17.0');
          const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
          if(!conn) throw new Error('No Azure conn');
          const path = session._kbFileUri.replace('azblob://','');
          const slash = path.indexOf('/');
          const container = path.substring(0, slash);
          const blobName = path.substring(slash+1);
          const svcCli = BlobServiceClient.fromConnectionString(conn);
          const blob = svcCli.getContainerClient(container).getBlockBlobClient(blobName);
          const buf = await blob.downloadToBuffer();
          const text = new TextDecoder().decode(buf);
          session._kbChunks = splitKB(text);
          if(session._kbChunks.length>0) return;
        } catch(e){ console.error(`[${reqId}] Blob KB load failed: ${e.message}`); }
      }
      if(session._agentId){
        try {
          const svc = await getSvc();
          const ag = await svc.entities.Agent.get(session._agentId);
          const kbIds = ag?.knowledge_base_ids || [];
          if(!kbIds.length) return;
          const docs = await Promise.all(kbIds.map(id => svc.entities.KnowledgeBase.get(id).catch(()=>null)));
          let text = '';
          docs.filter(Boolean).forEach(d => { if(d.content) text += `[${d.title}]\n${d.content}\n\n---\n\n`; });
          if(text.length >= 100) session._kbChunks = splitKB(text);
        } catch(_){}
      }
    })();
    await session._kbLoadPromise;
  }
  function searchKB(query){
    if(!session._kbChunks?.length) return '';
    const kws=(query||'').toLowerCase().replace(/[^\w\s\u0900-\u097F]/g,' ').split(/\s+/).filter(w=>w.length>=3);
    if(!kws.length) return session._kbChunks.slice(0,2).join('\n\n---\n\n');
    const sc=session._kbChunks.map(c=>{const lo=c.toLowerCase(); let s=0; for(const k of kws) s+=lo.split(k).length-1; return {c,s};});
    const top=sc.filter(x=>x.s>0).sort((a,b)=>b.s-a.s).slice(0,3);
    return top.length?top.map(x=>x.c).join('\n\n---\n\n'):session._kbChunks.slice(0,2).join('\n\n---\n\n');
  }

  function buildTools(){
    const t = [{type:'function', name:'end_call', description:'End the call after caller said goodbye. Say goodbye BEFORE calling.', parameters:{type:'object', properties:{reason:{type:'string'}}, required:['reason']}}];
    if(session._toolFlags?.has_kb || session._kbChunks.length>0 || session._kbFileUri || session._agentId) {
      t.push({type:'function', name:'search_knowledge_base', description:'Search KB for company-specific facts.', parameters:{type:'object', properties:{query:{type:'string'}}, required:['query']}});
    }
    if(session._toolFlags?.has_call_history && session._leadId) {
      t.push({type:'function', name:'get_call_history', description:'Fetch past calls with this lead.', parameters:{type:'object', properties:{}, required:[]}});
    }
    session.tools=t; return t;
  }

  async function executeToolCall(callId, name, argsStr){
    console.log(`[${reqId}] 🔧 ${name}`);
    let result = { error:`Unknown: ${name}` };
    try {
      const args = JSON.parse(argsStr || '{}');
      if(name==='search_knowledge_base'){
        if(!session._kbChunks.length) await loadKBLazy();
        result = { results: searchKB(args.query||'') || 'No relevant info.' };
      } else if(name==='get_call_history'){
        if(!session._leadId) result={error:'No lead'};
        else { const svc=await getSvc(); const r=await svc.functions.invoke('getLeadCallHistory',{lead_id:session._leadId, limit:5}); result=r?.data||{error:'fetch failed'}; }
      } else if(name==='end_call'){
        const elapsed=(Date.now()-session.startTime)/1000;
        if(elapsed<10){
          sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify({error:'Call just started. Continue.'})}});
          sendToRealtime({type:'response.create'});
          return;
        }
        const recentCustomer = session.transcript.filter(t => t.speaker === 'Customer').slice(-3).map(t => (t.text || '').toLowerCase()).join(' ');
        const goodbyeRegex = /(bye|goodbye|alvida|namaste|namaskar|dhanyav[aā]d|thank\s*you|thanks|shukriya|theek\s*hai\s*bye|ok\s*bye|fir\s*milte|chalo\s*bye|have a good|take care|cheers|see you|phone\s*(kaat|kat|rakh)|kaat\s*do|kat\s*do|rakh\s*do|rakhta\s*hoon|rakhti\s*hoon|abhi\s*baat\s*nahi|baat\s*nahi\s*karni|busy\s*hoon|baad\s*mein|nahi\s*chahiye|mat\s*karo\s*call|call\s*mat|pareshan\s*mat|already\s*(le|liya)|le\s*chuka|le\s*chuki|subscription\s*le|बाय|अलविदा|धन्यवाद|शुक्रिया|नमस्ते|नमस्कार|फिर मिलते|फ़ोन\s*(काट|रख)|काट\s*दो|रख\s*दो|अभी\s*बात\s*नहीं|बात\s*नहीं\s*करनी|बाद\s*में|नहीं\s*चाहिए|परेशान\s*मत)/i;
        if (!goodbyeRegex.test(recentCustomer)) {
          console.log(`[${reqId}] 🛑 end_call rejected — customer hasn't signalled end. Last customer: "${recentCustomer.substring(0, 120)}"`);
          sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify({error:'Customer has NOT signalled they want to end yet. Continue. Only call end_call after the customer says bye/thanks/namaste/dhanyavaad OR a hang-up cue like "phone kaat do", "rakh do", "abhi baat nahi karni", "baad mein", "nahi chahiye". Ask your next question.'})}});
          sendToRealtime({type:'response.create'});
          return;
        }
        result={success:true};
        sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify(result)}});
        session.transcript.push({speaker:'System', text:`[Ended: ${args.reason||''}]`});
        setTimeout(()=>{
          session._callEnded=true;
          if(session.realtimeWs?.readyState===WebSocket.OPEN) session.realtimeWs.close();
          const d=Math.round((Date.now()-session.startTime)/1000);
          saveCallRecord(session, reqId, d).then(()=>{ if(swSocket.readyState===WebSocket.OPEN) swSocket.close(); });
        }, 1500);
        return;
      }
    } catch(e){ result={error:e.message}; }
    sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify(result)}});
    sendToRealtime({type:'response.create'});
  }

  function connectRealtime(){
    const url = Deno.env.get('AZURE_REALTIME_ENDPOINT_GA')||Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const key = Deno.env.get('AZURE_REALTIME_KEY_GA')||Deno.env.get('AZURE_REALTIME_KEY');
    if(!url||!key){ console.error(`[${reqId}] ❌ Missing AZURE_REALTIME_*_GA secrets`); return; }
    let host=url.replace(/^https?:\/\//,'').replace(/^wss?:\/\//,''); const si=host.indexOf('/'); if(si>0) host=host.substring(0,si);
    const dep = Deno.env.get('AZURE_REALTIME_DEPLOYMENT_GA')||'gpt-realtime-2';
    const wsUrl = `wss://${host}/openai/v1/realtime?model=${encodeURIComponent(dep)}&api-key=${encodeURIComponent(key)}`;
    console.log(`[${reqId}] 🔌 Realtime GA connect (dep=${dep})`);
    const ws=new WebSocket(wsUrl);
    ws.onopen=()=>{ session._realtimeReconnectAttempts=0; };
    ws.onmessage=e=>{ try{ handleRealtimeMessage(JSON.parse(e.data)); } catch(err){ console.error(`[${reqId}] parse: ${err.message}`); } };
    ws.onclose=()=>{
      session.realtimeReady=false;
      if(!session._callEnded && session._realtimeReconnectAttempts<3){
        session._realtimeReconnectAttempts++;
        setTimeout(()=>{ if(!session._callEnded) connectRealtime(); }, session._realtimeReconnectAttempts*1000);
      }
    };
    ws.onerror=()=>{};
    session.realtimeWs=ws;
  }
  function sendToRealtime(m){ if(session.realtimeWs?.readyState===WebSocket.OPEN) session.realtimeWs.send(JSON.stringify(m)); }

  function applySessionConfig(){
    const tools = buildTools();
    const hasKB = session._toolFlags?.has_kb || session._kbFileUri || session._kbChunks.length>0 || !!session._agentId;
    const instructions = buildRealtimePreamble({ hasKB, voiceType: session.voiceType }) + session.systemPrompt
      + '\n\n--- CALL ENDING (STRICT) ---\nDo NOT call end_call until the CUSTOMER explicitly says goodbye/thank you/bye. Your own goodbye does NOT count.';

    const cfg = {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'whisper-1', language: 'en' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 }
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice: session.voiceType
        }
      }
    };
    if(tools.length){ cfg.tools = tools; cfg.tool_choice = 'auto'; }
    sendToRealtime({ type:'session.update', session:cfg });
    console.log(`[${reqId}] 📤 Setup: tools=${tools.length}, voice=${session.voiceType}, kb=${hasKB}`);
    triggerGreeting();
    if(session._audioBuffer.length>0){
      for(const b64 of session._audioBuffer) sendToRealtime({type:'input_audio_buffer.append', audio:b64});
      session._audioBuffer=[];
    }
  }

  function triggerGreeting(){
    const g = session.greetingMessage || '';
    const instr = g ? `Say exactly: "${g}"` : 'Greet briefly in 1 sentence.';
    if(g) session.transcript.push({ speaker:'AI', text:g });
    sendToRealtime({ type:'response.create', response:{ output_modalities:['audio'], instructions: instr } });
  }

  function handleRealtimeMessage(msg){
    const t = msg.type;
    if(t==='session.created'){
      session.realtimeReady = true;
      if(session._agentConfigReady) applySessionConfig();
      return;
    }
    if((t==='response.output_audio.delta' || t==='response.audio.delta') && msg.delta){
      session.isSpeaking=true;
      const m = base64PCM16_24kToMulaw(msg.delta, session._resampleState);
      if(swSocket.readyState===WebSocket.OPEN && session.streamSid) sendMulawToSW(m);
      return;
    }
    if(t==='response.output_audio.done' || t==='response.audio.done'){ session.isSpeaking=false; return; }
    if(t==='conversation.item.input_audio_transcription.completed' && msg.transcript){
      const text = msg.transcript.trim();
      if(text && !isHallucinatedScript(text)){
        const clean = text.toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g,'').trim();
        const wc = clean.split(/\s+/).filter(w=>w).length;
        if(wc===1 && /^(hmm+|uh+|um+|ah+|oh+|huh)$/i.test(clean)) return;
        console.log(`[${reqId}] 🗣️ "${text.substring(0,100)}"`);
        session.transcript.push({ speaker:'Customer', text });
      }
      return;
    }
    if((t==='response.output_audio_transcript.done' || t==='response.audio_transcript.done') && msg.transcript){
      const text = msg.transcript.trim();
      if(text){ console.log(`[${reqId}] 🤖 "${text.substring(0,100)}"`); session.transcript.push({ speaker:'AI', text }); }
      return;
    }
    if(t==='input_audio_buffer.speech_started'){
      if(swSocket.readyState===WebSocket.OPEN && session.streamSid){
        swSocket.send(JSON.stringify({event:'clear', streamSid:session.streamSid}));
      }
      session.isSpeaking=false; return;
    }
    if(t==='response.function_call_arguments.done'){ executeToolCall(msg.call_id, msg.name, msg.arguments||'{}'); return; }
    if(t==='error'){ console.error(`[${reqId}] ❌ Realtime err:`, JSON.stringify(msg.error||msg).substring(0,300)); }
  }

  function sendMulawToSW(b){
    const C = 960;
    for(let i=0;i<b.length;i+=C){
      let chunk=b.slice(i, Math.min(i+C, b.length));
      if(chunk.length%160!==0){const p=new Uint8Array(Math.ceil(chunk.length/160)*160); p.set(chunk); p.fill(0x7F, chunk.length); chunk=p;}
      swSocket.send(JSON.stringify({event:'media', streamSid:session.streamSid, media:{payload:uint8ToBase64(chunk)}}));
    }
  }

  function mapVoice(v, fb='alloy'){
    const valid = ['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'];
    const m = {'nova':'shimmer','onyx':'ash','fable':'ballad','aoede':'shimmer','puck':'verse','charon':'ash','kore':'coral','fenrir':'cedar'};
    let x = (v||'').toLowerCase(); if(m[x]) x=m[x];
    return valid.includes(x) ? x : fb;
  }

  async function loadAgentConfigFromCallLogId(callLogId){
    const t0 = Date.now();
    try {
      const svc = await getSvc();
      const callLog = await svc.entities.CallLog.get(callLogId);
      if(!callLog){ console.log(`[${reqId}] ⚠️ No call log for ${callLogId}`); return; }
      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      const cache = callLog.agent_config_cache || {};
      session._agentId = cache.agent_id || callLog.agent_id || null;
      if(cache.core_prompt){
        session.systemPrompt = cache.core_prompt;
        session._kbFileUri = cache.kb_file_uri || '';
        session._leadId = cache.lead_id || callLog.lead_id || null;
        session._toolFlags = cache.tool_flags || {};
        if(cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if(cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if(cache.greeting_message) session.greetingMessage = cache.greeting_message;
      } else if(cache.system_prompt){
        session.systemPrompt = cache.system_prompt;
        session._leadId = callLog.lead_id || null;
        if(cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if(cache.greeting_message) session.greetingMessage = cache.greeting_message;
      }
      session.voiceType = mapVoice(cache.persona?.voice_type, 'alloy');
      if(session.streamSid) svc.entities.CallLog.update(callLog.id, { stream_sid: session.streamSid }).catch(()=>{});
      console.log(`[${reqId}] ✅ Config ready in ${Date.now()-t0}ms: voice=${session.voiceType}, prompt=${session.systemPrompt.length}ch`);
    } catch(e){ console.error(`[${reqId}] ❌ Config: ${e.message}`); }
  }

  connectRealtime();

  swSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if(msg.event === 'connected') return;
      if(msg.event === 'start'){
        const sd = msg.start || {};
        session.streamSid = sd.streamSid;
        session.callSid = sd.callSid;
        const cp = sd.customParameters || {};
        const callLogId = cp.call_log_id;
        session.callerNumber = cp.from || sd.from || '';
        session.calleeNumber = cp.to || sd.to || '';
        console.log(`[${reqId}] 📞 START signalwire outbound: streamSid=${session.streamSid}, call_log_id=${callLogId}`);
        if(callLogId){
          loadAgentConfigFromCallLogId(callLogId).then(()=>{
            session._agentConfigReady = true;
            if(session.realtimeReady) applySessionConfig();
            if(session._toolFlags?.has_kb || session._kbFileUri || session._agentId) loadKBLazy().catch(()=>{});
          });
        }
        return;
      }
      if(msg.event === 'media' && msg.media?.payload){
        const raw = atob(msg.media.payload);
        const m = new Uint8Array(raw.length);
        for(let i=0;i<raw.length;i++) m[i] = raw.charCodeAt(i);
        const b64 = mulawToBase64PCM16_24k(m, session._resampleState);
        if(!session.realtimeReady){
          if(session._audioBuffer.length<150) session._audioBuffer.push(b64);
          return;
        }
        sendToRealtime({ type:'input_audio_buffer.append', audio:b64 });
        return;
      }
      if(msg.event === 'stop'){
        session._callEnded = true;
        const d = Math.round((Date.now() - session.startTime) / 1000);
        if(session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
        await saveCallRecord(session, reqId, d);
        return;
      }
    } catch(err){ console.error(`[${reqId}] msg err: ${err.message}`); }
  };
  swSocket.onclose = async () => {
    session._callEnded = true;
    const d = Math.round((Date.now() - session.startTime) / 1000);
    if(session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
    if(session.callLogId) await saveCallRecord(session, reqId, d);
  };
  swSocket.onerror = () => { if(session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close(); };

  return response;

};