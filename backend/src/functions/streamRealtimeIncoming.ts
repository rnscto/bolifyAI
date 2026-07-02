import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { azureChatCompletionsCompat, azureFetchCompat } from "../lib/azureOpenAI.ts";
// ═══════════════════════════════════════════════════════════════════════
// streamRealtimeIncoming — Business INBOUND (Azure Realtime / GPT-4o)
// Phase 3 — handles inbound business DIDs when voice_engine='realtime'.
// ═══════════════════════════════════════════════════════════════════════

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
  // Proper 3:1 downsample (24kHz → 8kHz) with boxcar low-pass.
  // Each output sample = average of 3 consecutive input samples — uses
  // EVERY sample (no skipping), preventing aliasing artifacts that cause
  // choppy/robotic/glitchy phone audio.
  const raw=atob(b64); const bytes=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  const num=Math.floor(bytes.length/2); const view=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rem=st.downRemainder; const total=rem.length+num; const all=new Int16Array(total);
  for(let i=0;i<rem.length;i++)all[i]=rem[i];
  for(let i=0;i<num;i++)all[rem.length+i]=view.getInt16(i*2, true);
  const outLen=Math.floor(total/3); const mu=new Uint8Array(outLen);
  for(let i=0;i<outLen;i++){const c=i*3; const f=Math.round((all[c]+all[c+1]+all[c+2])/3); mu[i]=encodeMulaw(Math.max(-32768, Math.min(32767, f)));}
  const consumed=outLen*3; const newRem=[]; for(let i=consumed;i<total;i++)newRem.push(all[i]); st.downRemainder=newRem;
  return mu;
}
function uint8ToBase64(b) { let bin=''; for(let i=0;i<b.length;i++)bin+=String.fromCharCode(b[i]); return btoa(bin); }

// ─── Hallucinated-script filter ───
// Whisper hallucinates Korean/Japanese/Chinese/Arabic/Thai phrases on silence
// or noisy Indian-language audio. Drop transcripts that contain any
// foreign-script characters OR have NO Latin/Devanagari content.
function isHallucinatedScript(text) {
  if (!text || text.length < 2) return true;
  const forbidden = /[\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u0600-\u06FF\u0E00-\u0E7F\u0400-\u04FF]/;
  if (forbidden.test(text)) return true;
  const allowed = /[a-zA-Z\u0900-\u097F]/;
  if (!allowed.test(text)) return true;
  return false;
}

let _sdkPromise=null;
function getSDK(){ if(!_sdkPromise) _sdkPromise=import('npm:@base44/sdk@0.8.31'); return _sdkPromise; }
getSDK().catch(()=>{});

// Azure Blob URI for filler (Phase 3 — moved off Base44 storage to avoid integration credits).
const FILLER_URI='azblob://vaani-private/filler/filler_hello_1778132145341.mulaw';
let _fillerCache=null, _fillerLoad=null;
async function loadFiller(){
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
    return new Uint8Array(await blob.downloadToBuffer());
  } catch(_){ return null; }
}
async function getFiller(){ if(_fillerCache) return _fillerCache; if(!_fillerLoad) _fillerLoad=loadFiller(); _fillerCache=await _fillerLoad; return _fillerCache; }
// NOTE: NO module-load pre-warm — wastes integration credits on cold starts.

function splitKB(content){
  if(!content||content.length<100) return [];
  const out=[]; for(const doc of content.split(/\n---\n/)){const t=doc.trim(); if(!t) continue; if(t.length<=600){out.push(t); continue;} let buf=''; for(const p of t.split(/\n\n+/)){if((buf+'\n\n'+p).length>600 && buf){out.push(buf.trim()); buf=p;} else buf=buf?buf+'\n\n'+p:p;} if(buf.trim()) out.push(buf.trim());}
  return out.filter(c=>c.length>=30);
}

async function saveCallRecord(session, reqId, duration) {
  if(!session.callLogId || session._saved) return; session._saved=true;
  try {
    const transcript = session.transcript.map(t=>`${t.speaker}: ${t.text}`).join('\n');
    const {createClient}=await getSDK();
    const svc = base44;;
        const oi=baseUrl.indexOf('/openai/'); if(oi>0) baseUrl=baseUrl.substring(0,oi);
    const pi=baseUrl.indexOf('/api/projects'); if(pi>0) baseUrl=baseUrl.substring(0,pi);
    const dep=Deno.env.get('AZURE_OPENAI_DEPLOYMENT'), key=Deno.env.get('AZURE_OPENAI_KEY');
    let summary='', leadStatus='contacted', sentiment='neutral', leadScore=0, intentSignals=[], scoreBreakdown={}, keyTopics=[];
    if(transcript.trim().length>30 && baseUrl && dep && key){
      try {
        const r=await azureFetchCompat("__CHAT_COMPLETIONS_MIGRATED__", {
          method:'POST', headers:{'api-key':key, 'Content-Type':'application/json'},
          body: JSON.stringify({
            messages:[
              {role:'system', content:'Expert call analyst. Score 0-100. JSON only.'},
              {role:'user', content:`Transcript:\n${transcript}\n\nReturn JSON: {"summary":"2-3 sentences","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":0-100,"intent_signals":[],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":[],"objections":[],"recommended_next_action":"..."}`}
            ], max_completion_tokens:800, response_format:{type:'json_object'}
          })
        });
        if(r.ok){
          const a=JSON.parse((await r.json()).choices?.[0]?.message?.content||'{}');
          summary=a.summary||''; leadStatus=a.lead_status||'contacted'; sentiment=a.sentiment||'neutral';
          leadScore=Math.min(100, Math.max(0, a.lead_score||0)); intentSignals=a.intent_signals||[];
          scoreBreakdown={...(a.score_breakdown||{}), objections:a.objections||[], recommended_next_action:a.recommended_next_action||'', key_topics:a.key_topics||[]};
          keyTopics=a.key_topics||[];
        }
      } catch(_){}
    } else summary='Call ended with minimal conversation.';

    const cw=session.transcript.filter(t=>t.speaker==='Customer').reduce((a,t)=>a+t.text.split(/\s+/).length,0);
    if(cw<=5 && duration<30 && (leadStatus==='do_not_call'||leadStatus==='not_interested')){leadStatus='contacted'; sentiment='neutral'; leadScore=Math.max(leadScore, 10);}

    let qTier='cold', qReason='';
    if(leadScore>=75 && ['very_positive','positive'].includes(sentiment)){qTier='hot'; qReason=`${leadScore}/100, ${sentiment}`;}
    else if(leadScore>=50){qTier='warm'; qReason=`${leadScore}/100`;}
    else if(leadScore>=25){qTier='nurture'; qReason=`${leadScore}/100`;}
    else if(['negative','very_negative'].includes(sentiment)) qTier='disqualified';
    if(leadStatus==='converted') qTier='hot'; if(leadStatus==='do_not_call') qTier='disqualified';

    const enriched=summary?`${summary}\n\n---\nScore: ${leadScore}/100 | ${sentiment} | ${qTier} | ${intentSignals.join(', ')}`:'';
    const cur=await svc.entities.CallLog.get(session.callLogId);
    const term=cur && ['completed','failed','no_answer'].includes(cur.status);
    const callLogUpdate={
      ...(term?{}:{status:'completed', call_end_time:new Date().toISOString()}),
      transcript:transcript||'', duration, lead_status_updated:leadStatus,
      ...(enriched?{conversation_summary:enriched}:{})
    };
    // ── POSTGRES-PRIMARY WRITE ── transcript + summary survive a Base44 429.
    try { await svc.functions.invoke('pgLeadSync', { call_log: { ...cur, ...callLogUpdate } }); }
    catch(pgErr){ console.error(`[${reqId}] ⚠️ PG-primary write failed: ${pgErr.message}`); }
    await svc.entities.CallLog.update(session.callLogId, callLogUpdate);

    const lid=cur.lead_id || session._inboundLeadId;
    if(lid){
      try {
        const ex=await svc.entities.Lead.get(lid);
        const merged=[...new Set([...(ex.tags||[]), ...keyTopics.slice(0,10)])];
        await svc.entities.Lead.update(lid, {
          status:leadStatus, score:leadScore, sentiment, intent_signals:intentSignals, score_breakdown:scoreBreakdown,
          qualification_tier:qTier, qualification_reason:qReason, tags:merged,
          last_call_date:new Date().toISOString(), last_engagement_date:new Date().toISOString(),
          engagement_count:(ex.engagement_count||0)+1,
          notes:`[Score: ${leadScore}/100 | ${sentiment} | ${qTier}] ${summary.substring(0,300)}`
        });
      } catch(_){}
    }

    setTimeout(()=>svc.functions.invoke('fetchCallRecording',{call_log_id:session.callLogId}).catch(()=>{}), 20000);
    if(transcript.length>50) svc.functions.invoke('postCallActionExtractor',{call_log_id:session.callLogId}).catch(()=>{});
    if(cur?.direction==='inbound' && !cur?.lead_id && !session._inboundLeadId && transcript.length>50 && !session._isScreeningAgent && !cur?.agent_config_cache?.is_screening_call){
      svc.functions.invoke('autoCreateLeadFromInbound',{call_log_id:session.callLogId}).catch(()=>{});
    }
    if(cur?.agent_config_cache?.is_screening_call) svc.functions.invoke('processScreeningResult',{call_log_id:session.callLogId}).catch(()=>{});
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

export default async function streamRealtimeIncoming(c: any) {
  const req = c.req.raw || c.req;
  const reqId = Math.random().toString(36).substring(2,10);
  const isWS = (req.headers.get('upgrade')||'').toLowerCase()==='websocket';
  console.log(`[${reqId}] 📨 ${req.method} (realtime-incoming-business), ws=${isWS}`);
  if(!isWS){
    const host=req.headers.get('host')||'localhost';
    return c.json({ data: {sucess:true, wss_url:`wss://${host}/functions/streamRealtimeIncoming`, flow:'business-incoming-realtime'} }, 200);
  }
  let smartfloSocket, response;
  try { const u=Deno.upgradeWebSocket(req); smartfloSocket=u.socket; response=u.response; }
  catch(_){ return new Response('WS upgrade failed', {status:500}); }

  const session = {
    streamSid:null, callSid:null, callLogId:null, clientId:null, smartfloCallId:null,
    transcript:[], startTime:Date.now(),
    systemPrompt:'You are a professional AI voice assistant.',
    greetingMessage:'', voiceType:'alloy',
    _saved:false, realtimeWs:null, realtimeReady:false,
    isSpeaking:false, tools:[], hasShopify:false,
    humanTransferNumber:'', enableAutoTransfer:true,
    _realtimeReconnectAttempts:0, _callEnded:false, _agentConfigReady:false,
    _transferInitiated:false,
    calleeNumber:'', callerNumber:'',
    _kbChunks:[], _kbFileUri:'', _kbLoadPromise:null, _leadId:null, _inboundLeadId:null, _toolFlags:{},
    _isScreeningAgent:false,
    _fillerStarted:false, _fillerPlaying:false, _fillerAborted:false,
    _resampleState:{prevUpsample:0, downRemainder:[]},
    _audioBuffer:[],  // P0: queue customer audio during Realtime handshake
    // ── Personal-account state (for personal-mode inbound calls) ──
    _personalMode:null, _personalClientId:null, _ownerName:'', _ownerReachable:false,
    _isTrustedCaller:false, _trustedContactName:'',
    _midCallTgSent:false, _midCallChecking:false, _awaitingOwnerDecision:false
  };

  let _svc=null;
  async function getSvc(){ if(_svc) return _svc; const {createClient}=await getSDK(); _svc=createClient({appId:Deno.env.get('BASE44_APP_ID'), asServiceRole:true}); return _svc; }

  async function playFiller(){
    if(session._fillerPlaying||session._fillerStarted) return;
    session._fillerStarted=true;
    await new Promise(r=>setTimeout(r,800));
    if(session._fillerAborted||session.isSpeaking||session._callEnded) return;
    if(smartfloSocket.readyState!==WebSocket.OPEN||!session.streamSid) return;
    session._fillerPlaying=true;
    try {
      const f=await getFiller();
      if(!f||session._fillerAborted||session.isSpeaking){session._fillerPlaying=false; return;}
      for(let i=0;i<f.length;i+=160){
        if(session._fillerAborted||session.isSpeaking||session._callEnded) break;
        if(smartfloSocket.readyState!==WebSocket.OPEN) break;
        let chunk=f.slice(i, Math.min(i+160, f.length));
        if(chunk.length<160){const p=new Uint8Array(160); p.set(chunk); p.fill(0xFF, chunk.length); chunk=p;}
        smartfloSocket.send(JSON.stringify({event:'media', streamSid:session.streamSid, media:{payload:uint8ToBase64(chunk)}}));
        await new Promise(r=>setTimeout(r,20));
      }
    } catch(_){} finally { session._fillerPlaying=false; }
  }
  function stopFiller(){
    const wp=session._fillerPlaying; session._fillerAborted=true;
    if(wp && smartfloSocket.readyState===WebSocket.OPEN && session.streamSid){
      smartfloSocket.send(JSON.stringify({event:'clear', streamSid:session.streamSid}));
    }
  }

  async function loadKBLazy(){
    if(session._kbChunks.length>0) return;
    if(session._kbLoadPromise){ await session._kbLoadPromise; return; }
    session._kbLoadPromise=(async()=>{
      // Path A: blob URI available — direct Azure Blob read (fast)
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
          console.log(`[${reqId}] 📚 KB loaded from blob: ${text.length}ch → ${session._kbChunks.length} chunks`);
          if(session._kbChunks.length>0) return;
        } catch(e){ console.error(`[${reqId}] Blob KB load failed, will fall back to DB: ${e.message}`); }
      }
      // Path B: no blob (or blob empty) — fetch KB docs from DB and auto-build blob in background
      if(session._agentId){
        try {
          const svc = await getSvc();
          const ag = await svc.entities.Agent.get(session._agentId);
          const kbIds = ag?.knowledge_base_ids || [];
          if(!kbIds.length) return;
          const docs = await Promise.all(kbIds.map(id => svc.entities.KnowledgeBase.get(id).catch(()=>null)));
          let text = '';
          docs.filter(Boolean).forEach(d => { if(d.content) text += `[${d.title}]\n${d.content}\n\n---\n\n`; });
          if(text.length >= 100){
            session._kbChunks = splitKB(text);
            console.log(`[${reqId}] 📚 KB loaded from DB: ${text.length}ch → ${session._kbChunks.length} chunks`);
            if(!session._kbFileUri || !session._kbFileUri.startsWith('azblob://')){
              svc.functions.invoke('uploadKBToStorage', { agent_id: session._agentId }).catch(()=>{});
              console.log(`[${reqId}] 🔧 Auto-rebuilding KB blob for agent=${session._agentId}`);
            }
          }
        } catch(e){ console.error(`[${reqId}] DB KB load err: ${e.message}`); }
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
    const t=[{type:'function', name:'end_call', description:'End the call after caller said goodbye.', parameters:{type:'object', properties:{reason:{type:'string'}}, required:['reason']}}];
    if(session.humanTransferNumber) t.push({type:'function', name:'transfer_to_human', description:'Transfer to human.', parameters:{type:'object', properties:{reason:{type:'string'}}, required:['reason']}});
    if(session.hasShopify) t.push({type:'function', name:'shopify_lookup', description:'Look up Shopify orders/products.', parameters:{type:'object', properties:{lookup_type:{type:'string', enum:['order_by_number','order_by_phone','order_by_email','product_search','refund_status','tracking']}, query:{type:'string'}}, required:['lookup_type','query']}});
    // P2: declare KB tool whenever ANY KB source is reachable — flag, blob URI, chunks, OR agent_id to self-heal from DB
    if(session._toolFlags?.has_kb || session._kbChunks.length>0 || session._kbFileUri || session._agentId) t.push({type:'function', name:'search_knowledge_base', description:'Search KB for company-specific facts.', parameters:{type:'object', properties:{query:{type:'string'}}, required:['query']}});
    if(session._toolFlags?.has_call_history && session._leadId) t.push({type:'function', name:'get_call_history', description:'Fetch past calls with this lead.', parameters:{type:'object', properties:{}, required:[]}});
    session.tools=t; return t;
  }

  async function executeToolCall(callId, name, argsStr){
    let result={error:`Unknown: ${name}`};
    try {
      const args=JSON.parse(argsStr||'{}');
      if(name==='search_knowledge_base'){
        if(!session._kbChunks.length) await loadKBLazy();
        const r=searchKB(args.query||'');
        console.log(`[${reqId}] 📚 KB search: query="${(args.query||'').substring(0,80)}" chunks=${session._kbChunks.length} hit=${r.length>0?'yes':'no'}`);
        result={results: r || 'No relevant info.'};
      } else if(name==='get_call_history'){
        if(!session._leadId) result={error:'No lead'};
        else { const svc=await getSvc(); const r=await svc.functions.invoke('getLeadCallHistory',{lead_id:session._leadId, limit:5}); result=r?.data||{error:'fetch failed'}; }
      } else if(name==='end_call'){
        // P1: prevent premature end_call — require minimum call duration
        const elapsed=(Date.now()-session.startTime)/1000;
        if(elapsed<10){
          console.log(`[${reqId}] 🛑 end_call rejected — too early (${elapsed.toFixed(1)}s)`);
          sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify({error:'Call just started. Continue the conversation naturally.'})}});
          sendToRealtime({type:'response.create'});
          return;
        }
        result={success:true};
        sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify(result)}});
        session.transcript.push({speaker:'System', text:`[Ended: ${args.reason||''}]`});
        getSvc().then(svc=>svc.functions.invoke('disconnectCall',{call_sid:session.callSid, caller_number:session.callerNumber, callee_number:session.calleeNumber}).catch(()=>{}));
        setTimeout(()=>{
          session._callEnded=true;
          if(session.realtimeWs?.readyState===WebSocket.OPEN) session.realtimeWs.close();
          const d=Math.round((Date.now()-session.startTime)/1000);
          saveCallRecord(session, reqId, d).then(()=>{ if(smartfloSocket.readyState===WebSocket.OPEN) smartfloSocket.close(); });
        }, 1500);
        return;
      } else if(name==='transfer_to_human' && session.humanTransferNumber){
        const sfE=Deno.env.get('SMARTFLO_EMAIL'), sfP=Deno.env.get('SMARTFLO_PASSWORD');
        if(sfE && sfP){
          const lr=await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:sfE, password:sfP})});
          const tk=(await lr.json()).access_token;
          if(tk){
            const tr=await fetch('https://api-smartflo.tatateleservices.com/v1/call/options', {method:'POST', headers:{'Content-Type':'application/json', 'Authorization':`Bearer ${tk}`}, body:JSON.stringify({type:4, call_id:session.smartfloCallId||session.callSid, intercom:String(session.humanTransferNumber)})});
            if(tr.ok){
              result={success:true}; session._transferInitiated=true;
              session.transcript.push({speaker:'System', text:`[Transferred]`});
              const svc=await getSvc();
              if(session.callLogId) svc.entities.CallLog.update(session.callLogId, {transferred_to:`Intercom ${session.humanTransferNumber}`}).catch(()=>{});
            } else result={error:`Transfer failed: ${tr.status}`};
          } else result={error:'auth failed'};
        } else result={error:'Not configured'};
      } else if(name==='shopify_lookup' && session.clientId){
        const svc=await getSvc();
        const ints=await svc.entities.MarketplaceIntegration.filter({client_id:session.clientId, platform:'shopify', status:'active'});
        if(ints.length){
          const sh=ints[0];
          const url=`https://${sh.store_url.replace(/^https?:\/\//,'').replace(/\/$/,'')}/admin/api/${sh.api_version||'2024-01'}`;
          const h={'X-Shopify-Access-Token':sh.api_access_token, 'Content-Type':'application/json'};
          if(args.lookup_type==='order_by_number'){
            const oN=args.query.startsWith('#')?args.query:`#${args.query}`;
            const r=await fetch(`${url}/orders.json?name=${encodeURIComponent(oN)}&status=any&limit=3`, {headers:h});
            if(r.ok){const d=await r.json(); result={orders:(d.orders||[]).map(o=>({order_number:o.name, status:o.fulfillment_status||'unfulfilled', total:`${o.currency} ${o.total_price}`}))};}
          } else result={message:'processed'};
        } else result={error:'No Shopify'};
      }
    } catch(e){ result={error:e.message}; }
    sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify(result)}});
    sendToRealtime({type:'response.create'});
  }

  function connectRealtime(){
    // GA kill-switch: when AZURE_REALTIME_GA=true, use the new Foundry GA endpoint
    // (gpt-realtime / gpt-realtime-2) at /openai/v1/realtime?model=... Otherwise keep
    // the existing preview endpoint (/openai/realtime?api-version=...&deployment=...).
    const useGA = (Deno.env.get('AZURE_REALTIME_GA')||'').toLowerCase()==='true';
    const url = useGA ? (Deno.env.get('AZURE_REALTIME_ENDPOINT_GA')||Deno.env.get('AZURE_REALTIME_ENDPOINT')) : Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const key = useGA ? (Deno.env.get('AZURE_REALTIME_KEY_GA')||Deno.env.get('AZURE_REALTIME_KEY')) : Deno.env.get('AZURE_REALTIME_KEY');
    if(!url||!key){ console.error(`[${reqId}] ❌ Missing AZURE_REALTIME_* (ga=${useGA})`); return; }
    let host=url.replace(/^https?:\/\//,'').replace(/^wss?:\/\//,''); const si=host.indexOf('/'); if(si>0) host=host.substring(0,si);
    const dep = useGA
      ? (Deno.env.get('AZURE_REALTIME_DEPLOYMENT_GA')||Deno.env.get('AZURE_REALTIME_DEPLOYMENT')||'gpt-realtime-2')
      : (Deno.env.get('AZURE_REALTIME_DEPLOYMENT')||'gpt-4o-realtime-preview');
    const apiV = Deno.env.get('AZURE_REALTIME_API_VERSION')||'2024-10-01-preview';
    const wsUrl = useGA
      ? `wss://${host}/openai/v1/realtime?model=${encodeURIComponent(dep)}&api-key=${encodeURIComponent(key)}`
      : `wss://${host}/openai/realtime?api-version=${apiV}&deployment=${dep}&api-key=${encodeURIComponent(key)}`;
    console.log(`[${reqId}] 🔌 Realtime connect (ga=${useGA}, dep=${dep})`);
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
    const tools=buildTools();
    const hasKB = !session._personalMode && (session._toolFlags?.has_kb || session._kbFileUri || session._kbChunks.length>0 || !!session._agentId);
    // Universal preamble (Phase 3) — skipped KB rule for personal-mode (scripted screening flow).
    const transferI=session.humanTransferNumber && session.enableAutoTransfer ? `\n\n--- TRANSFER ---\nUse transfer_to_human when caller asks.` : '';
    const lock='\n\n--- IDENTITY LOCK ---\nName/company FIXED.';
    const endR='\n\n--- CALL ENDING ---\nCall end_call ONLY after caller explicitly says goodbye/bye/namaste/dhanyavaad/thank you AND you have responded. Never call end_call on silence or hesitation.';
    const instructions = buildRealtimePreamble({ hasKB, voiceType: session.voiceType }) + session.systemPrompt + lock + transferI + endR;
    const useGA = (Deno.env.get('AZURE_REALTIME_GA')||'').toLowerCase()==='true';
    let cfg;
    if(useGA){
      cfg = {
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
    } else {
      cfg = {
        modalities:['text','audio'],
        instructions,
        voice:session.voiceType,
        input_audio_format:'pcm16', output_audio_format:'pcm16',
        input_audio_transcription:{model:'whisper-1', language:'en'},
        turn_detection:{type:'server_vad', threshold:0.5, prefix_padding_ms:300, silence_duration_ms:700}
      };
    }
    if(tools.length){ cfg.tools=tools; cfg.tool_choice='auto'; }
    sendToRealtime({type:'session.update', session:cfg});
    console.log(`[${reqId}] 📤 Setup: tools=${tools.length}, voice=${session.voiceType}, kb=${hasKB}, ga=${useGA}`);
    triggerGreeting();
    // P0: flush buffered customer audio that arrived during handshake
    if(session._audioBuffer.length>0){
      console.log(`[${reqId}] 🔄 Flushing ${session._audioBuffer.length} buffered audio frames`);
      for(const b64 of session._audioBuffer) sendToRealtime({type:'input_audio_buffer.append', audio:b64});
      session._audioBuffer=[];
    }
  }
  function triggerGreeting(){
    const g=session.greetingMessage||'';
    const useGA = (Deno.env.get('AZURE_REALTIME_GA')||'').toLowerCase()==='true';
    const modKey = useGA ? 'output_modalities' : 'modalities';
    const mods = useGA ? ['audio'] : ['text','audio'];
    const instr = g ? `Say exactly: "${g}"` : 'Greet briefly.';
    if(g) session.transcript.push({speaker:'AI', text:g});
    sendToRealtime({type:'response.create', response:{ [modKey]: mods, instructions: instr }});
  }

  function handleRealtimeMessage(msg){
    const t=msg.type;
    if(t==='session.created'){ session.realtimeReady=true; if(session._agentConfigReady) applySessionConfig(); return; }
    // GA renamed: response.audio.* → response.output_audio.*, response.audio_transcript.* → response.output_audio_transcript.*
    if((t==='response.audio.delta' || t==='response.output_audio.delta') && msg.delta){
      stopFiller(); session.isSpeaking=true;
      const m=base64PCM16_24kToMulaw(msg.delta, session._resampleState);
      if(smartfloSocket.readyState===WebSocket.OPEN && session.streamSid) sendMulawToSmartflo(m);
      return;
    }
    if(t==='response.audio.done' || t==='response.output_audio.done'){ session.isSpeaking=false; return; }
    if(t==='conversation.item.input_audio_transcription.completed' && msg.transcript){
      const text=msg.transcript.trim();
      if(text){
        // Drop Whisper hallucinations in Korean/Japanese/Chinese/Arabic/Thai/Cyrillic
        if(isHallucinatedScript(text)){
          console.log(`[${reqId}] 🚫 Dropped hallucination: "${text.substring(0,80)}"`);
          return;
        }
        const clean=text.toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g,'').trim();
        const wc=clean.split(/\s+/).filter(w=>w).length;
        if(wc===1 && /^(hmm+|uh+|um+|ah+|oh+|huh|tch|shh)$/i.test(clean)) return;
        console.log(`[${reqId}] 🗣️ "${text.substring(0,100)}"`);
        session.transcript.push({speaker:'Customer', text});
        // Personal-mode: mid-call action buttons + live transcript updates to Telegram
        if(session._personalMode && session._personalClientId){
          const c = session.transcript.filter(x=>x.speaker==='Customer').length;
          if(session._ownerReachable && !session._midCallTgSent && !session._midCallChecking){
            const min = session._isTrustedCaller ? 1 : 2;
            if(c >= min) checkCallerInfoAndNotify();
          }
          if(session._midCallTgSent && c % 2 === 0) sendLiveTranscriptUpdate();
        }
      }
      return;
    }
    if((t==='response.audio_transcript.done' || t==='response.output_audio_transcript.done') && msg.transcript){
      const text=msg.transcript.trim();
      if(text){ console.log(`[${reqId}] 🤖 "${text.substring(0,100)}"`); session.transcript.push({speaker:'AI', text}); }
      return;
    }
    if(t==='input_audio_buffer.speech_started'){
      stopFiller();
      if(smartfloSocket.readyState===WebSocket.OPEN && session.streamSid) smartfloSocket.send(JSON.stringify({event:'clear', streamSid:session.streamSid}));
      session.isSpeaking=false; return;
    }
    if(t==='response.function_call_arguments.done'){ executeToolCall(msg.call_id, msg.name, msg.arguments||'{}'); return; }
    if(t==='error') console.error(`[${reqId}] ❌ Realtime err:`, JSON.stringify(msg.error||msg).substring(0,300));
  }

  function sendMulawToSmartflo(b){
    const C=960;
    for(let i=0;i<b.length;i+=C){
      let chunk=b.slice(i, Math.min(i+C, b.length));
      if(chunk.length%160!==0){const p=new Uint8Array(Math.ceil(chunk.length/160)*160); p.set(chunk); p.fill(0x7F, chunk.length); chunk=p;}
      smartfloSocket.send(JSON.stringify({event:'media', streamSid:session.streamSid, media:{payload:uint8ToBase64(chunk)}}));
    }
  }

  function mapVoice(v, fb='alloy'){
    const valid=['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'];
    const m={'nova':'shimmer','onyx':'ash','fable':'ballad','aoede':'shimmer','puck':'verse','charon':'ash','kore':'coral','fenrir':'cedar'};
    let x=(v||'').toLowerCase(); if(m[x]) x=m[x];
    return valid.includes(x)?x:fb;
  }

  // ─── Inbound config: DID → Agent → Client (BUSINESS only) ───
  async function loadAgentConfig(){
    const t0=Date.now();
    try {
      const svc=await getSvc();
      const cands=[session.calleeNumber, session.callerNumber].filter(Boolean);
      let didAgent=null, didClient=null, resolvedDID='';

      for(const cand of cands){
        if(didAgent) break;
        const cleanDID=cand.replace(/[^0-9]/g,'').slice(-10);
        if(!cleanDID) continue;
        const allDIDs=await svc.entities.DID.list('-created_date', 200);
        const m=allDIDs.find(d=>(d.number||'').replace(/\D/g,'').slice(-10)===cleanDID);
        if(m?.agent_id){
          const [a,c]=await Promise.all([
            svc.entities.Agent.get(m.agent_id).catch(()=>null),
            m.client_id?svc.entities.Client.get(m.client_id).catch(()=>null):Promise.resolve(null)
          ]);
          if(a){ didAgent=a; didClient=c; resolvedDID=cand; break; }
        }
        if(!didAgent){
          const allAgents=await svc.entities.Agent.list('-created_date', 100);
          didAgent=allAgents.find(a=>{
            const dids=a.assigned_dids||(a.assigned_did?[a.assigned_did]:[]);
            return dids.some(d=>(d||'').replace(/\D/g,'').slice(-10)===cleanDID);
          });
          if(didAgent){
            resolvedDID=cand;
            if(!didClient && didAgent.client_id) try { didClient=await svc.entities.Client.get(didAgent.client_id); } catch(_){}
            break;
          }
        }
      }

      if(!didAgent){ console.log(`[${reqId}] ⚠️ No agent matched`); return; }

      // ═══ PERSONAL ACCOUNT FLOW — screening, trusted contacts, owner Telegram decisions ═══
      if(didClient?.account_type === 'personal'){
        session.clientId = didClient.id;
        session._personalClientId = didClient.id;
        session._ownerName = didClient.company_name || '';
        if(didAgent.greeting_message) session.greetingMessage = didAgent.greeting_message;
        if(didAgent.human_transfer_number) session.humanTransferNumber = didAgent.human_transfer_number;
        else if(didClient.phone) session.humanTransferNumber = didClient.phone;
        if(didAgent.enable_auto_transfer === false) session.enableAutoTransfer = false;
        session.voiceType = mapVoice(didAgent.persona?.voice_type, 'shimmer');

        // Build personal-mode prompt (trusted contacts + screening script)
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
              flow_type: 'personal-incoming-realtime'
            }
          });
          if(newLog) session.callLogId = newLog.id;
        } catch(e){ console.error(`[${reqId}] CallLog err: ${e.message}`); }

        // Initial Telegram heads-up
        if(didClient.telegram_connected && didClient.telegram_chat_id && !didClient.dnd_enabled && didClient.owner_notification_channel === 'telegram'){
          const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
          if(tgT){
            const nm = session._trustedContactName || session.callerNumber || 'Unknown';
            fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: didClient.telegram_chat_id, text: `📞 <b>Incoming Call</b>\n\n📱 From: <b>${nm}</b>\n\n💬 AI is screening — actions appear shortly...`, parse_mode: 'HTML' })
            }).catch(()=>{});
          }
        }

        console.log(`[${reqId}] ✅ INBOUND personal-realtime ready in ${Date.now()-t0}ms: agent="${didAgent.name}", trusted=${session._isTrustedCaller}, ownerReachable=${session._ownerReachable}`);
        return;
      }

      session.clientId = didClient?.id || didAgent.client_id;

      // Trial gate
      if(didClient && (didClient.account_status==='trial'||didClient.account_status==='expired')){
        const now=new Date();
        const tEnd=didClient.trial_end_date?new Date(didClient.trial_end_date):null;
        const uUntil=didClient.trial_topup_unlimited_until?new Date(didClient.trial_topup_unlimited_until):null;
        const isUnlim=uUntil && uUntil>now;
        const used=Number(didClient.trial_calls_used||0);
        const lim=Number(didClient.trial_call_limit??10);
        const expired=didClient.account_status==='expired'||(tEnd && tEnd<=now && !isUnlim);
        const capHit=!isUnlim && used>=lim;
        if(expired||capHit){
          console.log(`[${reqId}] 🚫 Trial blocked: ${expired?'expired':'cap'}`);
          try { smartfloSocket.close(); } catch(_){}
          session._callEnded=true;
          return;
        }
        if(!isUnlim) svc.entities.Client.update(didClient.id, {trial_calls_used:used+1}).catch(()=>{});
      }

      if(didAgent.greeting_message) session.greetingMessage=didAgent.greeting_message;
      if(didAgent.human_transfer_number) session.humanTransferNumber=didAgent.human_transfer_number;
      if(didAgent.enable_auto_transfer===false) session.enableAutoTransfer=false;
      session.voiceType=mapVoice(didAgent.persona?.voice_type, 'alloy');

      const kbIds=didAgent.knowledge_base_ids||[];
      const cleanCaller=session.callerNumber?.replace(/\D/g,'').slice(-10)||'';
      const [kbDocs, leads, shopifyInt]=await Promise.all([
        kbIds.length?Promise.all(kbIds.map(id=>svc.entities.KnowledgeBase.get(id).catch(()=>null))):Promise.resolve([]),
        cleanCaller && didClient?svc.entities.Lead.filter({client_id:didClient.id}).catch(()=>[]):Promise.resolve([]),
        session.clientId?svc.entities.MarketplaceIntegration.filter({client_id:session.clientId, platform:'shopify', status:'active'}).catch(()=>[]):Promise.resolve([])
      ]);

      let kbContent='';
      (Array.isArray(kbDocs)?kbDocs:[]).filter(Boolean).forEach(d=>{ if(d.content) kbContent+=`[${d.title}]\n${d.content}\n\n---\n\n`; });

      let callerContext='';
      if(cleanCaller && Array.isArray(leads)){
        const ml=leads.find(l=>l.phone && l.phone.replace(/\D/g,'').slice(-10)===cleanCaller);
        if(ml){
          session._inboundLeadId=ml.id; session._leadId=ml.id;
          callerContext=`\n\n--- INBOUND - RETURNING LEAD ---\n- Name: ${ml.name||'Unknown'}\n- Status: ${ml.status||'new'}\n- Score: ${ml.score||0}/100\nAddress by name "${ml.name||'Sir/Madam'}". For past-chat references, call get_call_history.`;
        }
      }

      // Seed in-memory KB chunks directly from the docs we just loaded.
      // This is the source of truth for inbound calls — kb_file_uri is just
      // an optimization for slim-cache outbound calls.
      if(kbContent && kbContent.length>=100) session._kbChunks = splitKB(kbContent);
      if(didAgent.kb_file_uri) session._kbFileUri=didAgent.kb_file_uri;
      // Capture agent_id so loadKBLazy can self-heal from DB if blob is missing
      session._agentId = didAgent.id;
      session._toolFlags={
        has_kb: session._kbChunks.length>0 || !!session._kbFileUri,
        has_shopify:false, has_unicommerce:false,
        has_call_history: !!session._leadId,
        has_transfer: !!didAgent.human_transfer_number,
        has_end_call: true
      };
      console.log(`[${reqId}] 📚 KB ready: chunks=${session._kbChunks.length}, content=${kbContent.length}ch`);
      // Strip any pre-existing "KNOWLEDGE BASE" heading from the agent's system_prompt
      // (the AI was parroting it back to callers as "hamare knowledge base mein...")
      let basePrompt = didAgent.system_prompt || 'You are a helpful AI voice assistant.';
      const kbHeadR = /\n+(?:[-=]{2,}\s*)?KNOWLEDGE BASE[^\n]*\n/i;
      basePrompt = basePrompt.replace(kbHeadR, '\n\n--- COMPANY INFORMATION ---\n');
      const kbBlock = kbContent
        ? `\n\n--- COMPANY INFORMATION (TREAT AS YOUR OWN KNOWLEDGE) ---\nThe following are facts about the company. Speak them naturally as if you know them. NEVER mention the words "knowledge base", "database", "system", or "look up" to the caller.\n\n${kbContent}`
        : '';
      session.systemPrompt = basePrompt + callerContext + kbBlock;

      if(Array.isArray(shopifyInt) && shopifyInt.length>0){
        session.hasShopify=true; session._toolFlags.has_shopify=true;
        session.systemPrompt+='\n\n[SHOPIFY ACTIVE] Use shopify_lookup tool for real-time data.';
      }

      try {
        const newLog=await svc.entities.CallLog.create({
          client_id:session.clientId, agent_id:didAgent.id,
          lead_id:session._inboundLeadId||null,
          call_sid:session.callSid||`inbound_${Date.now()}`,
          stream_sid:session.streamSid||null,
          caller_id:session.callerNumber||'', callee_number:session.calleeNumber,
          direction:'inbound', status:'answered', call_start_time:new Date().toISOString(),
          agent_config_cache:{
            agent_name:didAgent.name, system_prompt:session.systemPrompt,
            persona:didAgent.persona||{}, knowledge_base_content:kbContent.substring(0,2000),
            greeting_message:didAgent.greeting_message||'',
            flow_type:'business-incoming-realtime'
          }
        });
        if(newLog) session.callLogId=newLog.id;
      } catch(e){ console.error(`[${reqId}] CallLog err: ${e.message}`); }

      console.log(`[${reqId}] ✅ INBOUND realtime ready in ${Date.now()-t0}ms: agent="${didAgent.name}", DID=${resolvedDID}, voice=${session.voiceType}`);
    } catch(e){ console.error(`[${reqId}] ❌ Config: ${e.message}`); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PERSONAL-MODE HELPERS (screening, trusted contacts, owner Telegram flow)
  // ═══════════════════════════════════════════════════════════════════════
  async function applyPersonalMode(svc, ownerClient, callerPhone){
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
      callerClean ? svc.entities.TrustedContact.filter({ client_id: ownerClient.id }).catch(()=>[]) : Promise.resolve([]),
      svc.entities.OwnerStatus.filter({ client_id: ownerClient.id, is_active: true }).catch(()=>[])
    ]);

    let isTrusted = false, trustedName = '', rel = '', famRel = '';
    if(callerClean){
      const m = trustedContacts.find(tc => tc.phone && tc.phone.replace(/\D/g,'').slice(-10) === callerClean);
      if(m){ isTrusted = true; trustedName = m.name || ''; rel = m.relationship || 'other'; famRel = m.family_relation || ''; }
    }

    const owner = ownerClient.company_name || 'Sir';
    let pi = '\n\n--- PERSONAL AI ASSISTANT MODE ---';
    if(aiMode === 'block_all') pi += '\nMODE: BLOCK ALL. Politely tell the caller the owner is unavailable and end quickly.';
    else if(aiMode === 'take_messages') pi += '\nMODE: TAKE MESSAGES. Take a message from every caller.';
    else if(isTrusted) pi += `\nMODE: TRUSTED CALLER "${trustedName}" (${rel}). Greet warmly by name.`;
    else pi += '\nMODE: SCREEN ALL. Classify as family/business/promotional/spam.';

    if(!isTrusted && aiMode !== 'block_all'){
      if(ownerReachable){
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
NEVER say "main confirm karke aati hoon" — owner is not reachable. Keep call SHORT (under 60s).`;
      }
    }

    if(isTrusted && ['family','friend'].includes(rel)){
      const greetMap = { wife:'Bhabhiji', mother:'Mummy ji', father:'Papa ji', brother:`${trustedName} Bhaiya`, sister:`${trustedName} Didi`, son:`${trustedName} Beta`, daughter:`${trustedName} Beta`, uncle:'Uncle ji', aunt:'Aunty ji', cousin:`${trustedName} ji`, in_law:`${trustedName} ji` };
      const honorific = greetMap[famRel || rel] || `${trustedName} ji`;
      if(ownerReachable){
        pi += `\n\n--- TRUSTED FAMILY/FRIEND: ${trustedName} (${rel}) — OWNER REACHABLE ---
STEP 1: "Namaste ${honorific}! Main ${owner} ji ki personal assistant hoon. ${owner} ji abhi available nahi hain — main aapki call le rahi hoon."
STEP 2: "${honorific}, koi urgent kaam hai ya main message le lun?"
STEP 3: "Theek hai ${honorific}, ek minute hold kariye — main ${owner} ji se confirm karke abhi bataati hoon."
STEP 4: SILENT WAIT for [OWNER INSTRUCTION]. NEVER fabricate.`;
      } else {
        pi += `\n\n--- TRUSTED FAMILY/FRIEND: ${trustedName} — OWNER UNREACHABLE ---
STEP 1: "Namaste ${honorific}! ${owner} ji abhi available nahi hain. Aap mujhe bata dijiye, main unhe message pahuncha dungi."
STEP 2: Take their message warmly.
STEP 3: "Theek hai ${honorific}, maine note kar liya hai. Dhanyavaad, namaste." → end_call.`;
      }
    }

    if(dndEnabled) pi += '\nDND IS ON: Handle silently and politely.';
    pi += '\nClassify call in summary as family/business/promotional/spam/unknown.';

    try {
      for(const s of ownerStatuses){
        if(s.title){
          pi += `\n\n--- OWNER STATUS: ${s.icon || ''} ${s.title} ---\nTell callers in Hindi: "${s.caller_message_hindi || ''}"`;
          break;
        }
      }
    } catch(_){}

    session.systemPrompt = pi;
    session._personalMode = aiMode;
    session._isTrustedCaller = isTrusted;
    session._trustedContactName = trustedName;
    console.log(`[${reqId}] 🛡️ Personal: mode=${aiMode}, dnd=${dndEnabled}, trusted=${isTrusted}, ownerReachable=${ownerReachable}`);
  }

  async function checkCallerInfoAndNotify(){
    session._midCallChecking = true;
    const bUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const dep = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
    const ak = Deno.env.get('AZURE_OPENAI_KEY');
    let callerName = session._trustedContactName || '';
    let reason = '';
    if(bUrl && dep && ak){
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
        if(r.ok){
          const j = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
          if(j.caller_name) callerName = j.caller_name;
          reason = j.reason || '';
        }
      } catch(_){}
    }
    session._midCallTgSent = true;
    sendMidCallTgButtons(callerName || session.callerNumber || 'Unknown', reason || 'Not yet specified');
  }

  async function sendMidCallTgButtons(name, reason){
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if(!tgT || !session.callLogId) return;
    try {
      const svc = await getSvc();
      const cl = await svc.entities.Client.get(session._personalClientId);
      if(!cl?.telegram_connected || !cl?.telegram_chat_id || cl.dnd_enabled || cl.owner_notification_channel !== 'telegram') return;
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
      if((await r.json()).ok){
        session._awaitingOwnerDecision = true;
        pollOwnerDecision(svc);
      }
    } catch(e){ console.error(`[${reqId}] TG buttons err: ${e.message}`); }
  }

  async function sendLiveTranscriptUpdate(){
    const tgT = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if(!tgT || !session._personalClientId) return;
    try {
      const svc = await getSvc();
      const cl = await svc.entities.Client.get(session._personalClientId);
      if(!cl?.telegram_connected || !cl?.telegram_chat_id || cl.owner_notification_channel !== 'telegram') return;
      const recent = session.transcript.slice(-4).map(t => `${t.speaker === 'Customer' ? '🗣️' : '🤖'} <b>${t.speaker}:</b> ${t.text.substring(0, 200)}`).join('\n');
      const msg = `📞 <b>Live Call Update</b>\n\n${recent}\n\n💬 <i>Type any message to instruct the AI</i>`;
      fetch(`https://api.telegram.org/bot${tgT}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cl.telegram_chat_id, text: msg, parse_mode: 'HTML' })
      }).catch(()=>{});
    } catch(_){}
  }

  async function pollOwnerDecision(svc){
    if(!session.callLogId) return;
    let polls = 0, reass = 0, fb = false;
    const start = Date.now();
    const iv = setInterval(async () => {
      polls++;
      if(polls > 120 || session._callEnded){ clearInterval(iv); return; }
      try {
        const decs = await svc.entities.CallDecision.filter({ call_log_id: session.callLogId, status: 'pending' });
        const ready = decs.filter(d => d.custom_message !== '__AWAITING_TIME__' && d.custom_message !== '__AWAITING_MESSAGE__');
        if(ready.length > 0){
          for(const d of ready){
            await svc.entities.CallDecision.update(d.id, { status: 'delivered' });
            executeOwnerDecision(d);
          }
          clearInterval(iv);
          return;
        }
        const elapsed = Date.now() - start;
        if(!fb && elapsed >= 60000){ fb = true; sendWaitingFallback(); clearInterval(iv); }
        else if(elapsed >= (reass + 1) * 15000 && reass < 3){ reass++; sendWaitingReassurance(); }
      } catch(_){}
    }, 2000);
  }

  function sendWaitingReassurance(){
    const o = session._ownerName || 'Sir';
    const useGA1 = (Deno.env.get('AZURE_REALTIME_GA')||'').toLowerCase()==='true';
    const k1 = useGA1 ? 'output_modalities' : 'modalities';
    const m1 = useGA1 ? ['audio'] : ['text','audio'];
    sendToRealtime({ type: 'response.create', response: { [k1]: m1, instructions: `[WAITING UPDATE] Owner ne abhi tak reply nahi diya. Caller ko gently reassure karo: "Abhi ${o} ji se koi update nahi aaya hai, aap line par rahiye — main phir se pooch rahi hoon." Sirf 1 line bolo, phir wapas chup ho jao.` } });
  }

  function sendWaitingFallback(){
    const o = session._ownerName || 'Sir';
    const useGA2 = (Deno.env.get('AZURE_REALTIME_GA')||'').toLowerCase()==='true';
    const k2 = useGA2 ? 'output_modalities' : 'modalities';
    const m2 = useGA2 ? ['audio'] : ['text','audio'];
    sendToRealtime({ type: 'response.create', response: { [k2]: m2, instructions: `[WAITING TIMEOUT] Owner ne reply nahi diya. Caller ko boliye: "Lagta hai ${o} ji abhi busy hain. Maine aapka message unhe pahuncha diya hai. Wo free hote hi aapko khud call kar lenge. Dhanyavaad, namaste." Yeh bolne ke baad end_call tool use karo with reason="owner_unresponsive".` } });
  }

  function executeOwnerDecision(dec){
    const owner = session._ownerName || 'Sir';
    let inst = '';
    if(dec.decision === 'transfer'){
      inst = session.humanTransferNumber
        ? `[OWNER INSTRUCTION] ${owner} ji ne call transfer karne bola hai. Caller ko boliye: "Sir, ${owner} ji aapka call apne paas transfer kar rahe hain." Phir transfer_to_human tool use karo.`
        : `[OWNER INSTRUCTION] ${owner} ji jald call back karenge.`;
    } else if(dec.decision === 'callback'){
      const t = dec.callback_time || dec.custom_message || 'kuch der mein';
      inst = `[OWNER INSTRUCTION] ${owner} ji ${t} mein call back karenge. Caller ko batao.`;
    } else if(dec.decision === 'take_message'){
      inst = `[OWNER INSTRUCTION] ${owner} ji busy hain. Caller ka message lo — naam, purpose, details.`;
    } else if(dec.decision === 'block'){
      inst = `[OWNER INSTRUCTION] Politely end: "${owner} ji abhi available nahi hain. Dhanyavaad. Namaste."`;
    } else if(dec.custom_message){
      inst = `[OWNER INSTRUCTION] ${owner} ji ka message: "${dec.custom_message}". Relay naturally.`;
    }
    if(!inst) return;
    if(smartfloSocket.readyState === WebSocket.OPEN && session.streamSid){
      smartfloSocket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    session.isSpeaking = false;
    const useGA3 = (Deno.env.get('AZURE_REALTIME_GA')||'').toLowerCase()==='true';
    const k3 = useGA3 ? 'output_modalities' : 'modalities';
    const m3 = useGA3 ? ['audio'] : ['text','audio'];
    sendToRealtime({ type: 'response.create', response: { [k3]: m3, instructions: inst } });
  }

  connectRealtime();

  smartfloSocket.onmessage = async (event) => {
    try {
      const msg=JSON.parse(event.data);
      if(msg.event==='connected') return;
      if(msg.event==='start'){
        const sd=msg.start||{};
        session.streamSid=sd.streamSid; session.callSid=sd.callSid;
        session.callerNumber=sd.from||sd.customParameters?.caller_number||sd.customParameters?.customer_number||'';
        session.calleeNumber=sd.to||sd.customParameters?.called_number||sd.customParameters?.did||'';
        console.log(`[${reqId}] 📞 START inbound: callee(DID)=${session.calleeNumber}, caller=${session.callerNumber}`);
        playFiller();
        loadAgentConfig().then(()=>{
          session._agentConfigReady=true;
          if(session.realtimeReady) applySessionConfig();
          // Eagerly pre-warm KB in background so first tool call is instant
          if(session._kbFileUri || session._agentId) loadKBLazy().catch(()=>{});
        });
        return;
      }
      if(msg.event==='media' && msg.media?.payload){
        const raw=atob(msg.media.payload);
        const m=new Uint8Array(raw.length);
        for(let i=0;i<raw.length;i++) m[i]=raw.charCodeAt(i);
        const b64=mulawToBase64PCM16_24k(m, session._resampleState);
        // P0: buffer audio during Realtime handshake instead of dropping it
        if(!session.realtimeReady){
          if(session._audioBuffer.length<150) session._audioBuffer.push(b64); // ~3s cap
          return;
        }
        sendToRealtime({type:'input_audio_buffer.append', audio:b64});
        return;
      }
      if(msg.event==='stop'){
        session._callEnded=true;
        const d=Math.round((Date.now()-session.startTime)/1000);
        if(session.realtimeWs?.readyState===WebSocket.OPEN) session.realtimeWs.close();
        await saveCallRecord(session, reqId, d);
        return;
      }
    } catch(err){ console.error(`[${reqId}] msg err: ${err.message}`); }
  };
  smartfloSocket.onclose = async () => {
    session._callEnded=true;
    const d=Math.round((Date.now()-session.startTime)/1000);
    if(session.realtimeWs?.readyState===WebSocket.OPEN) session.realtimeWs.close();
    if(session.callLogId) await saveCallRecord(session, reqId, d);
  };
  smartfloSocket.onerror = () => { if(session.realtimeWs?.readyState===WebSocket.OPEN) session.realtimeWs.close(); };

  return response;

};