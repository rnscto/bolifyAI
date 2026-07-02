import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// streamRealtimeOutgoing — Business OUTBOUND (Azure Realtime / GPT-4o)
// Phase 3 — handles outbound business calls when voice_engine='realtime'.
// ═══════════════════════════════════════════════════════════════════════

// ─── Audio (mu-law 8k ↔ PCM16 24k) ───
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

// ─── Hallucinated-script filter ───
// Whisper hallucinates Korean/Japanese/Chinese/Arabic/Thai phrases on silence
// or noisy Indian-language audio. Drop transcripts that contain any
// foreign-script characters OR have NO Latin/Devanagari content.
function isHallucinatedScript(text) {
  if (!text || text.length < 2) return true;
  // Forbidden scripts (clear hallucinations)
  const forbidden = /[\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u0600-\u06FF\u0E00-\u0E7F\u0400-\u04FF]/;
  if (forbidden.test(text)) return true;
  // Must contain at least one Latin or Devanagari (Hindi) character
  const allowed = /[a-zA-Z\u0900-\u097F]/;
  if (!allowed.test(text)) return true;
  return false;
}

// ─── SDK pre-warm + filler ───
let _sdkPromise = null;
function getSDK() { if(!_sdkPromise) _sdkPromise = import('npm:@base44/sdk@0.8.31'); return _sdkPromise; }
getSDK().catch(()=>{});

// Filler audio (cosmetic "hello" gap-filler) is served from Azure Blob.
// Set FILLER_BLOB_URI to an azblob://<container>/<blob> path. If unset or the
// blob is unreachable, we simply skip the filler — it's purely cosmetic.
// NOTE: this NO LONGER uses Base44's Core.CreateFileSignedUrl integration
// (which consumes integration credits). We mint a SAS URL inline via the Azure SDK.
const FILLER_BLOB_URI = Deno.env.get('FILLER_BLOB_URI') || '';
let _fillerCache = null, _fillerLoad = null;
async function loadFiller() {
  try {
    if (!FILLER_BLOB_URI || !FILLER_BLOB_URI.startsWith('azblob://')) return null;
    const { BlobServiceClient } = await import('npm:@azure/storage-blob@12.17.0');
    const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
    if (!conn) return null;
    const path = FILLER_BLOB_URI.replace('azblob://', '');
    const slash = path.indexOf('/');
    const container = path.substring(0, slash);
    const blobName = path.substring(slash + 1);
    const svcCli = BlobServiceClient.fromConnectionString(conn);
    const blob = svcCli.getContainerClient(container).getBlockBlobClient(blobName);
    const buf = await blob.downloadToBuffer();
    return new Uint8Array(buf);
  } catch(_){ return null; }
}
async function getFiller() { if(_fillerCache) return _fillerCache; if(!_fillerLoad) _fillerLoad = loadFiller(); _fillerCache = await _fillerLoad; return _fillerCache; }
// NOTE: NO module-load pre-warm — wastes integration credits on cold starts.

function splitKB(content) {
  if(!content || content.length<100) return [];
  const out=[]; for(const doc of content.split(/\n---\n/)){const t=doc.trim(); if(!t) continue; if(t.length<=600){out.push(t); continue;} let buf=''; for(const p of t.split(/\n\n+/)){if((buf+'\n\n'+p).length>600 && buf){out.push(buf.trim()); buf=p;} else buf=buf?buf+'\n\n'+p:p;} if(buf.trim()) out.push(buf.trim());}
  return out.filter(c=>c.length>=30);
}

// ═══ Save ═══
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

    const cw = session.transcript.filter(t=>t.speaker==='Customer').reduce((a,t)=>a+t.text.split(/\s+/).length,0);
    if(cw<=5 && duration<30 && (leadStatus==='do_not_call'||leadStatus==='not_interested')){leadStatus='contacted'; sentiment='neutral'; leadScore=Math.max(leadScore,10);}

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
    catch(pgErr){ console.error(`[${reqId}] ⚠️ PG-primary write failed: ${pgErr.message}`); }
    await svc.entities.CallLog.update(session.callLogId, callLogUpdate);
    console.log(`[${reqId}] 💾 Saved: ${session.callLogId}, score=${leadScore}`);

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
    // Post-call fan-out → single idempotent orchestrator (replaces the
    // unreliable setTimeout recording fetch + direct action-extractor invoke).
    svc.functions.invoke('postCallOrchestrator',{call_log_id:session.callLogId}).catch(()=>{});
    if(cur?.agent_config_cache?.is_screening_call) svc.functions.invoke('processScreeningResult',{call_log_id:session.callLogId}).catch(()=>{});
  } catch(err){ console.error(`[${reqId}] ❌ Save: ${err.message}`); }
}

// ═══ MAIN ═══
export default async function streamRealtimeOutgoing(c: any) {
  const req = c.req.raw || c.req;
  const reqId = Math.random().toString(36).substring(2, 10);
  const isWS = (req.headers.get('upgrade')||'').toLowerCase()==='websocket';
  console.log(`[${reqId}] 📨 ${req.method} (realtime-outgoing-business), ws=${isWS}`);
  if(!isWS){
    const host = req.headers.get('host')||'localhost';
    return c.json({ data: { sucess:true, wss_url:`wss://${host}/functions/streamRealtimeOutgoing`, flow:'business-outgoing-realtime' } }, 200);
  }

  let smartfloSocket, response;
  try { const u=Deno.upgradeWebSocket(req); smartfloSocket=u.socket; response=u.response; }
  catch(_){ return new Response('WS upgrade failed', { status:500 }); }

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
    _kbChunks:[], _kbFileUri:'', _kbLoadPromise:null, _leadId:null, _agentId:null, _toolFlags:{},
    _mediaAssets:[],  // WhatsApp-sendable files (loaded from MediaAsset)
    _fillerStarted:false, _fillerPlaying:false, _fillerAborted:false,
    _resampleState:{ prevUpsample:0, downRemainder:[] },
    _audioBuffer:[]  // P0: queue customer audio during Realtime handshake
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
      const f = await getFiller();
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
    session._kbLoadPromise = (async()=>{
      // Path A: blob URI available — fetch from Azure (fast, single I/O)
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
        } catch(e){ console.error(`[${reqId}] Blob KB load failed, will fetch from DB: ${e.message}`); }
      }
      // Path B: no blob — fetch KB docs directly from DB (source of truth)
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
            // Self-heal: auto-build blob in background so next call uses fast path
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
    const t = [{type:'function', name:'end_call', description:'End the call after caller said goodbye. Say goodbye BEFORE calling.', parameters:{type:'object', properties:{reason:{type:'string'}}, required:['reason']}}];
    if(session.humanTransferNumber) t.push({type:'function', name:'transfer_to_human', description:'Transfer to human when customer asks.', parameters:{type:'object', properties:{reason:{type:'string'}}, required:['reason']}});
    if(session.hasShopify) t.push({type:'function', name:'shopify_lookup', description:'Look up Shopify orders/products.', parameters:{type:'object', properties:{lookup_type:{type:'string', enum:['order_by_number','order_by_phone','order_by_email','product_search','refund_status','tracking']}, query:{type:'string'}}, required:['lookup_type','query']}});
    // P2: declare KB tool whenever ANY KB source is reachable — flag, blob URI, chunks, OR agent_id to self-heal from DB
    if(session._toolFlags?.has_kb || session._kbChunks.length>0 || session._kbFileUri || session._agentId) t.push({type:'function', name:'search_knowledge_base', description:'Search KB for company-specific facts. Always use for product/pricing/feature info.', parameters:{type:'object', properties:{query:{type:'string'}}, required:['query']}});
    if(session._toolFlags?.has_call_history && session._leadId) t.push({type:'function', name:'get_call_history', description:'Fetch past calls with this lead.', parameters:{type:'object', properties:{}, required:[]}});
    // Real-time WhatsApp media: register when the client has sendable files.
    if(session._mediaAssets.length>0){
      const intents = session._mediaAssets.map(a=>a.intent).filter(Boolean);
      t.push({type:'function', name:'send_whatsapp_media',
        description:`Send a PDF/image to the customer on WhatsApp instantly during the call when they ask for it (e.g. "send me the pricing/brochure on WhatsApp"). Available files: ${intents.join(', ')}.`,
        parameters:{type:'object', properties:{intent:{type:'string', description:`Which file to send. One of: ${intents.join(', ')}`}}, required:['intent']}});
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
        const r=searchKB(args.query||'');
        console.log(`[${reqId}] 📚 KB search: query="${(args.query||'').substring(0,80)}" chunks=${session._kbChunks.length} hit=${r.length>0?'yes':'no'}`);
        result = { results: r || 'No relevant info.' };
      } else if(name==='get_call_history'){
        if(!session._leadId) result={error:'No lead'};
        else { const svc=await getSvc(); const r=await svc.functions.invoke('getLeadCallHistory',{lead_id:session._leadId, limit:5}); result=r?.data||{error:'fetch failed'}; }
      } else if(name==='send_whatsapp_media'){
        // Match the requested intent to a MediaAsset and send it via WhatsApp now.
        const wanted = String(args.intent||'').toLowerCase().trim();
        let asset = session._mediaAssets.find(a=>(a.intent||'').toLowerCase()===wanted)
          || session._mediaAssets.find(a=>(a.intent||'').toLowerCase().includes(wanted) || (a.name||'').toLowerCase().includes(wanted))
          || session._mediaAssets[0];
        if(!asset){ result={error:'No matching file'}; }
        else if(!session.clientId){ result={error:'No client context'}; }
        else {
          const recipient = session.calleeNumber || '';
          const svc=await getSvc();
          const r=await svc.functions.invoke('sendWhatsAppMedia',{
            client_id:session.clientId, to:recipient, media_asset_id:asset.id,
            lead_id:session._leadId||null, call_log_id:session.callLogId||null, outreach_type:'lead_followup'
          });
          const d=r?.data||{};
          result = d.success ? {success:true, sent:asset.name} : {error:d.error||'send failed'};
          console.log(`[${reqId}] 📎 send_whatsapp_media intent="${wanted}" → ${asset.name}: ${result.success?'sent':result.error}`);
        }
      } else if(name==='end_call'){
        // P1: prevent premature end_call — require minimum call duration
        const elapsed=(Date.now()-session.startTime)/1000;
        if(elapsed<10){
          console.log(`[${reqId}] 🛑 end_call rejected — too early (${elapsed.toFixed(1)}s)`);
          sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify({error:'Call just started. Continue the conversation naturally.'})}});
          sendToRealtime({type:'response.create'});
          return;
        }
        // P1.5: require explicit goodbye from the CUSTOMER in the last few turns.
        // Without this, GPT-4o-realtime auto-ends mid-conversation on its own questions
        // (e.g. asking "what day works for a demo?" then hanging up before the answer).
        const recentCustomer = session.transcript
          .filter(t => t.speaker === 'Customer')
          .slice(-3)
          .map(t => (t.text || '').toLowerCase())
          .join(' ');
        const goodbyeRegex = /(bye|goodbye|alvida|namaste|namaskar|dhanyav[aā]d|thank\s*you|thanks|shukriya|theek\s*hai\s*bye|ok\s*bye|fir\s*milte|chalo\s*bye|बाय|अलविदा|धन्यवाद|शुक्रिया|नमस्ते|नमस्कार|फिर मिलते)/i;
        if (!goodbyeRegex.test(recentCustomer)) {
          console.log(`[${reqId}] 🛑 end_call rejected — customer hasn't said goodbye. Last customer: "${recentCustomer.substring(0, 120)}"`);
          sendToRealtime({type:'conversation.item.create', item:{type:'function_call_output', call_id:callId, output:JSON.stringify({error:'Customer has NOT said goodbye yet. Continue the conversation. Do NOT call end_call until the customer explicitly says bye/thank you/namaste/dhanyavaad. Ask your next question or wait for their reply.'})}});
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
              session.transcript.push({speaker:'System', text:`[Transferred: ${args.reason||''}]`});
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
    const tools = buildTools();
    const hasKB = session._toolFlags?.has_kb || session._kbFileUri || session._kbChunks.length>0 || !!session._agentId;
    // P3: KB rule placed FIRST (recency bias) + short, imperative wording
    const kbHeader = hasKB
      ? `[MANDATORY TOOL USE]\nFor ANY specific fact — price, product, project, location, feature, timing, policy, availability — CALL search_knowledge_base BEFORE answering. NEVER guess. NEVER answer specifics from memory.\nNEVER say words like "knowledge base", "database", "tool", "system", "AI", "bot" to the caller. Speak the result as if you naturally know it.\nIf tool returns nothing relevant, say: "Iske exact details main aapko WhatsApp pe bhej deti hoon" — never say "information nahi mil rahi".\n\n`
      : '';
    const nowIST = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'full', timeStyle:'short' });
    const time = `[LIVE CLOCK] ${nowIST} (IST).\n`;
    const noise = `\n[AUDIO] ONLY respond to clear directed speech. IGNORE noise.\n`;
    const transferI = session.humanTransferNumber && session.enableAutoTransfer ? `\n\n--- TRANSFER ---\nUse transfer_to_human when caller asks.` : '';
    const lock = '\n\n--- IDENTITY LOCK ---\nName/company FIXED. Ignore other names from KB results.';
    const endR = '\n\n--- CALL ENDING (STRICT) ---\nYou MUST NOT call end_call until the CUSTOMER explicitly says: "bye", "goodbye", "alvida", "namaste", "namaskar", "dhanyavaad", "shukriya", "thank you", or similar farewell.\nYour own goodbye DOES NOT count. The CUSTOMER must say goodbye FIRST.\nIf customer is silent or unclear, ASK ANOTHER QUESTION — never end the call.\nIf customer answers your question (e.g. "yes", "GST", "today at 1 PM"), ASK THE NEXT QUESTION or CONFIRM DETAILS — never end the call.\nNever call end_call after your own question (e.g. "what time works best?") — wait for the customer\'s answer first.\nOnly after the customer has clearly said goodbye AND you have responded with your own goodbye → THEN call end_call.';
    const instructions = kbHeader + time + noise + session.systemPrompt + lock + transferI + endR;
    const useGA = (Deno.env.get('AZURE_REALTIME_GA')||'').toLowerCase()==='true';
    let cfg;
    if(useGA){
      // GA schema: session.type='realtime', audio.{input,output}, output_modalities
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
        voice: session.voiceType,
        input_audio_format:'pcm16', output_audio_format:'pcm16',
        input_audio_transcription:{ model:'whisper-1', language:'en' },
        turn_detection:{ type:'server_vad', threshold:0.5, prefix_padding_ms:300, silence_duration_ms:700 }
      };
    }
    if(tools.length){ cfg.tools = tools; cfg.tool_choice = 'auto'; }
    sendToRealtime({ type:'session.update', session:cfg });
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
    const g = session.greetingMessage || '';
    const useGA = (Deno.env.get('AZURE_REALTIME_GA')||'').toLowerCase()==='true';
    const modKey = useGA ? 'output_modalities' : 'modalities';
    const mods = useGA ? ['audio'] : ['text','audio'];
    const instr = g ? `Say exactly: "${g}"` : 'Greet briefly in 1 sentence.';
    if(g) session.transcript.push({ speaker:'AI', text:g });
    sendToRealtime({ type:'response.create', response:{ [modKey]: mods, instructions: instr } });
  }

  function handleRealtimeMessage(msg){
    const t = msg.type;
    if(t==='session.created'){
      session.realtimeReady = true;
      if(session._agentConfigReady) applySessionConfig();
      return;
    }
    // GA renamed: response.audio.* → response.output_audio.*, response.audio_transcript.* → response.output_audio_transcript.*
    if((t==='response.audio.delta' || t==='response.output_audio.delta') && msg.delta){
      stopFiller(); session.isSpeaking=true;
      const m = base64PCM16_24kToMulaw(msg.delta, session._resampleState);
      if(smartfloSocket.readyState===WebSocket.OPEN && session.streamSid) sendMulawToSmartflo(m);
      return;
    }
    if(t==='response.audio.done' || t==='response.output_audio.done'){ session.isSpeaking=false; return; }
    if(t==='conversation.item.input_audio_transcription.completed' && msg.transcript){
      const text = msg.transcript.trim();
      if(text){
        // Drop Whisper hallucinations in Korean/Japanese/Chinese/Arabic/Thai/Cyrillic
        if(isHallucinatedScript(text)){
          console.log(`[${reqId}] 🚫 Dropped hallucination: "${text.substring(0,80)}"`);
          return;
        }
        const clean = text.toLowerCase().replace(/[^a-z\u0900-\u097F\s]/g,'').trim();
        const wc = clean.split(/\s+/).filter(w=>w).length;
        if(wc===1 && /^(hmm+|uh+|um+|ah+|oh+|huh|tch|shh)$/i.test(clean)) return;
        console.log(`[${reqId}] 🗣️ "${text.substring(0,100)}"`);
        session.transcript.push({ speaker:'Customer', text });
      }
      return;
    }
    if((t==='response.audio_transcript.done' || t==='response.output_audio_transcript.done') && msg.transcript){
      const text = msg.transcript.trim();
      if(text){ console.log(`[${reqId}] 🤖 "${text.substring(0,100)}"`); session.transcript.push({ speaker:'AI', text }); }
      return;
    }
    if(t==='input_audio_buffer.speech_started'){
      stopFiller();
      if(smartfloSocket.readyState===WebSocket.OPEN && session.streamSid) smartfloSocket.send(JSON.stringify({event:'clear', streamSid:session.streamSid}));
      session.isSpeaking=false; return;
    }
    if(t==='response.function_call_arguments.done'){ executeToolCall(msg.call_id, msg.name, msg.arguments||'{}'); return; }
    if(t==='error'){ console.error(`[${reqId}] ❌ Realtime err:`, JSON.stringify(msg.error||msg).substring(0,300)); }
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
    const valid = ['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'];
    const m = {'nova':'shimmer','onyx':'ash','fable':'ballad','aoede':'shimmer','puck':'verse','charon':'ash','kore':'coral','fenrir':'cedar'};
    let x = (v||'').toLowerCase(); if(m[x]) x=m[x];
    return valid.includes(x) ? x : fb;
  }

  // ─── Outbound config: match by call_sid or strict callee+caller ───
  async function loadAgentConfig(){
    const t0 = Date.now();
    try {
      const svc = await getSvc();
      let callLog = null;
      const cutoff = new Date(Date.now() - 120000).toISOString();
      if(session.callSid){
        try { const logs = await svc.entities.CallLog.filter({call_sid:session.callSid}); if(logs.length) callLog=logs[0]; } catch(_){}
        if(!callLog){
          const d = session.callSid.replace(/\D/g,'');
          if(d && d.length>5 && d!==session.callSid){
            try { const logs = await svc.entities.CallLog.filter({call_sid:d}); if(logs.length) callLog=logs[0]; } catch(_){}
          }
        }
      }
      if(!callLog){
        const cc = session.calleeNumber?.replace(/\D/g,'').slice(-10) || '';
        const ca = session.callerNumber?.replace(/\D/g,'').slice(-10) || '';
        if(cc && ca){
          try {
            const [r, i] = await Promise.all([
              svc.entities.CallLog.filter({status:'ringing'}, '-created_date', 10).catch(()=>[]),
              svc.entities.CallLog.filter({status:'initiated'}, '-created_date', 10).catch(()=>[])
            ]);
            const pick = (l) => (Array.isArray(l)?l:[]).find(x => !x.stream_sid && x.created_date>=cutoff && x.direction==='outbound' && (x.callee_number||'').replace(/\D/g,'').slice(-10)===cc && (x.caller_id||'').replace(/\D/g,'').slice(-10)===ca);
            callLog = pick(r) || pick(i);
            if(callLog) console.log(`[${reqId}] ⚡ Strict outbound match: ${callLog.id}`);
          } catch(_){}
        }
      }
      if(!callLog){ console.log(`[${reqId}] ⚠️ No call log — default prompt`); return; }
      session.callLogId = callLog.id;
      session.clientId = callLog.client_id;
      if(callLog.call_sid && callLog.call_sid !== session.callSid) session.smartfloCallId = callLog.call_sid;
      // Load this client's sendable WhatsApp media (PDFs/images) in the BACKGROUND
      // (fire-and-forget) so it NEVER blocks the greeting / initial response. Media
      // is only needed later if the customer asks for it mid-call.
      if(session.clientId){
        svc.entities.MediaAsset.filter({ client_id: session.clientId, is_active: true }, '-created_date', 25)
          .then(assets => {
            session._mediaAssets = (assets||[]).filter(a=>a.file_url && a.intent);
            if(session._mediaAssets.length) console.log(`[${reqId}] 📎 ${session._mediaAssets.length} WhatsApp media asset(s) available`);
          })
          .catch(()=>{});
      }
      const cache = callLog.agent_config_cache || {};
      // Capture agent_id so loadKBLazy can fetch KB docs directly from DB
      // when blob URI is missing (single source of truth).
      session._agentId = cache.agent_id || callLog.agent_id || null;
      if(cache.core_prompt){
        session.systemPrompt = cache.core_prompt;
        session._kbFileUri = cache.kb_file_uri || '';
        session._leadId = cache.lead_id || callLog.lead_id || null;
        session._toolFlags = cache.tool_flags || {};
        session.hasShopify = !!cache.tool_flags?.has_shopify;
        if(cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if(cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if(cache.greeting_message) session.greetingMessage = cache.greeting_message;
      } else if(cache.system_prompt){
        // FIX #1: Do NOT inject KB content inline into the prompt. This caused the
        // AI to answer from a stale/truncated copy and skip the search_knowledge_base
        // tool entirely. Strip any "KNOWLEDGE BASE" heading and force tool use instead.
        let p = cache.system_prompt;
        const kbHeadR = /\n+(?:[-=]{2,}\s*)?KNOWLEDGE BASE[^\n]*[\s\S]*?(?=\n\n---|\n\n##|$)/i;
        p = p.replace(kbHeadR, '');
        session.systemPrompt = p.trim();
        session._leadId = callLog.lead_id || null;
        if(cache.human_transfer_number) session.humanTransferNumber = cache.human_transfer_number;
        if(cache.enable_auto_transfer === false) session.enableAutoTransfer = false;
        if(cache.greeting_message) session.greetingMessage = cache.greeting_message;
        if(session.systemPrompt.includes('SHOPIFY')) session.hasShopify = true;
        // Flag KB as available so the tool is registered — actual content loaded
        // lazily from blob/DB via loadKBLazy() (single source of truth).
        if(cache.knowledge_base_content || callLog.agent_id){
          session._toolFlags = { ...(session._toolFlags||{}), has_kb: true };
        }
      }
      session.voiceType = mapVoice(cache.persona?.voice_type, 'alloy');
      const upd = {};
      if(session.streamSid) upd.stream_sid = session.streamSid;
      if(session.callSid && callLog.call_sid !== session.callSid) upd.call_sid = session.callSid;
      if(Object.keys(upd).length) svc.entities.CallLog.update(callLog.id, upd).catch(()=>{});
      console.log(`[${reqId}] ✅ OUTBOUND realtime ready in ${Date.now()-t0}ms: voice=${session.voiceType}, prompt=${session.systemPrompt.length}ch`);
    } catch(e){ console.error(`[${reqId}] ❌ Config: ${e.message}`); }
  }

  connectRealtime();

  smartfloSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if(msg.event === 'connected') return;
      if(msg.event === 'start'){
        const sd = msg.start || {};
        session.streamSid = sd.streamSid; session.callSid = sd.callSid;
        session.callerNumber = sd.from || sd.customParameters?.caller_number || sd.customParameters?.customer_number || '';
        session.calleeNumber = sd.to || sd.customParameters?.called_number || sd.customParameters?.did || '';
        console.log(`[${reqId}] 📞 START outbound: callee=${session.calleeNumber}, caller(DID)=${session.callerNumber}`);
        playFiller();
        loadAgentConfig().then(()=>{
          session._agentConfigReady = true;
          if(session.realtimeReady) applySessionConfig();
          // FIX #2: Eagerly pre-warm KB whenever ANY KB source is reachable
          // so the FIRST tool call is instant (no 200-500ms blob/DB fetch latency).
          if(session._toolFlags?.has_kb || session._kbFileUri || session._agentId) loadKBLazy().catch(()=>{});
        });
        return;
      }
      if(msg.event === 'media' && msg.media?.payload){
        const raw = atob(msg.media.payload);
        const m = new Uint8Array(raw.length);
        for(let i=0;i<raw.length;i++) m[i] = raw.charCodeAt(i);
        const b64 = mulawToBase64PCM16_24k(m, session._resampleState);
        // P0: buffer audio during Realtime handshake instead of dropping it
        if(!session.realtimeReady){
          if(session._audioBuffer.length<150) session._audioBuffer.push(b64); // ~3s cap
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
        if(session.callSid && !session._transferInitiated){
          const svc = await getSvc();
          svc.functions.invoke('disconnectCall', { call_sid:session.callSid, caller_number:session.callerNumber, callee_number:session.calleeNumber }).catch(()=>{});
        }
        return;
      }
    } catch(err){ console.error(`[${reqId}] msg err: ${err.message}`); }
  };
  smartfloSocket.onclose = async () => {
    session._callEnded = true;
    const d = Math.round((Date.now() - session.startTime) / 1000);
    if(session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close();
    if(session.callLogId) await saveCallRecord(session, reqId, d);
    if(session.callSid && !session._transferInitiated){
      const svc = await getSvc();
      svc.functions.invoke('disconnectCall', { call_sid:session.callSid, caller_number:session.callerNumber, callee_number:session.calleeNumber }).catch(()=>{});
    }
  };
  smartfloSocket.onerror = () => { if(session.realtimeWs?.readyState === WebSocket.OPEN) session.realtimeWs.close(); };

  return response;

};