import { Hono } from "hono";
import { client } from "../db/index.ts";
import { base44ORM as base44 } from "../db/orm.ts";
import { sendWhatsAppMessage } from "../integrations/whatsapp.ts";
import { sendSMS } from "../integrations/sms.ts";

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
          const callLog = await base44.entities.CallLog.get(customIdentifier);
          if (callLog) {
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

const streamHandler = (c: any) => {
  const callId = c.req.param("callId") || `call_${Date.now()}`;
  
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("Expected Upgrade: websocket", 400);
  }

  const { socket: smartfloSocket, response } = Deno.upgradeWebSocket(c.req.raw);
  const sessionState = { lastDownsampleRemainder: [] };

  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
  if (!GEMINI_API_KEY) {
    console.error("Missing GEMINI_API_KEY. Terminating call.");
    smartfloSocket.close();
    return response;
  }

  let geminiSocket: WebSocket | null = null;
  let audioBuffer: string[] = []; // Buffer incoming audio until Gemini connects
  const HOST = "generativelanguage.googleapis.com";
  const WS_URL = `wss://${HOST}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

  let agentId = c.req.query("agent_id");
  let leadId = c.req.query("lead_id");
  const callStartTime = Date.now();

  smartfloSocket.onopen = () => {
    console.log(`[Smartflo] Connected for Call ID: ${callId}`);
  };

  const connectGemini = async (resolvedAgentId: string | null) => {
    if (geminiSocket) return;

    geminiSocket = new WebSocket(WS_URL);

    geminiSocket.onopen = async () => {
      console.log(`[Gemini] Connected for Call ID: ${callId}, Agent ID: ${resolvedAgentId}`);
      
      let systemInstructionText = "You are a helpful AI business assistant. Keep your answers concise, conversational, and friendly as if you are on a phone call.";
      let voiceName = "Aoede";

      if (resolvedAgentId) {
        try {
          const agentResult = await client.queryObject(`SELECT system_prompt, persona FROM "agent" WHERE id = $1 LIMIT 1`, [resolvedAgentId]);
          if (agentResult.rows.length > 0) {
             const agent = agentResult.rows[0] as any;
             if (agent.system_prompt) systemInstructionText = agent.system_prompt;
             if (agent.persona && typeof agent.persona === 'object') {
               const personaObj = agent.persona as any;
               if (personaObj.voice_type) voiceName = personaObj.voice_type;
             }
          }
        } catch (err) {
          console.error("Error fetching agent configuration:", err);
        }
      }
      
      const setupMessage = {
        setup: {
          model: "models/gemini-3.1-flash-live-preview",
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } }
          },
          systemInstruction: { parts: [ { text: systemInstructionText } ] }
        }
      };
      
      geminiSocket!.send(JSON.stringify(setupMessage));

      // Flush buffer
      while (audioBuffer.length > 0) {
         const pcm16kBase64 = audioBuffer.shift();
         if (geminiSocket!.readyState === WebSocket.OPEN) {
            geminiSocket!.send(JSON.stringify({
              realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcm16kBase64 } }
            }));
         }
      }
    };

    geminiSocket.onmessage = async (event) => {
      try {
        let text = typeof event.data === "string" ? event.data : "";
        if (event.data instanceof Blob) {
          text = await event.data.text();
        } else if (event.data instanceof ArrayBuffer) {
          text = new TextDecoder().decode(event.data);
        }
        
        if (!text) return;
        const data = JSON.parse(text);

        if (data.setupComplete !== undefined) {
          console.log("[Gemini] setupComplete received. Triggering initial greeting.");
          if (geminiSocket && geminiSocket.readyState === WebSocket.OPEN) {
            geminiSocket.send(JSON.stringify({
              clientContent: {
                turns: [
                  { role: "user", parts: [{ text: "Hello! Greet me briefly in English or Hindi to start the conversation." }] }
                ],
                turnComplete: true
              }
            }));
          }
          return;
        }
        
        if (data.serverContent?.modelTurn) {
          const parts = data.serverContent.modelTurn.parts;
          for (const part of parts) {
            if (part.inlineData && part.inlineData.mimeType.startsWith("audio/pcm")) {
              const audioBase64 = part.inlineData.data;
              // Downsample Gemini's 24kHz PCM16 to 8kHz Mu-law
              const mulawBytes = base64PCM16_24kToMulaw(audioBase64, sessionState);
              if (mulawBytes.length === 0) continue;
              
              // Forward back to Smartflo with pacing
              if (smartfloSocket.readyState === WebSocket.OPEN && streamId) {
                const CHUNK_SIZE = 960;
                for (let i = 0; i < mulawBytes.length; i += CHUNK_SIZE) {
                  const end = Math.min(i + CHUNK_SIZE, mulawBytes.length);
                  let chunk = mulawBytes.slice(i, end);
                  
                  // Smartflo expects multiples of 160 bytes
                  if (chunk.length % 160 !== 0) {
                    const paddedLen = Math.ceil(chunk.length / 160) * 160;
                    const padded = new Uint8Array(paddedLen);
                    padded.set(chunk);
                    padded.fill(127, chunk.length); // 127 = 0x7F mu-law silence
                    chunk = padded;
                  }
                  
                  const outPayload = JSON.stringify({
                    event: "media",
                    streamSid: streamId,
                    media: { payload: uint8ToBase64(chunk) }
                  });
                  
                  if (!(sessionState as any)._loggedOut) {
                    console.log("[Smartflo] First OUTGOING media packet:", outPayload.substring(0, 150));
                    (sessionState as any)._loggedOut = true;
                  }
                  
                  smartfloSocket.send(outPayload);
                }
              }
            }
          }
        } else if (data.serverContent?.interrupted) {
          // Handle interruption if needed
        } else if (data.serverContent) {
           console.log("[Gemini] Non-audio message received:", JSON.stringify(data).substring(0, 200));
        }
      } catch (e) {
        console.error("[Gemini] Error handling incoming message:", e);
      }
    };

    geminiSocket.onerror = (error) => {
      console.error("[Gemini] WebSocket Error:", error);
    };

    geminiSocket.onclose = () => {
      console.log(`[Gemini] Disconnected for Call ID: ${callId}`);
      if (smartfloSocket.readyState === WebSocket.OPEN) {
        smartfloSocket.close();
      }
    };
  };
    
  let streamId: string | null = null;
  let firstMessageLogged = false; let firstMediaLogged = false;

  smartfloSocket.onmessage = async (event) => {
    try {
      if (typeof event.data === "string") {
        const payload = JSON.parse(event.data);
        if (!firstMediaLogged) {
          console.log("[Smartflo] First message received:", JSON.stringify(payload));
          firstMessageLogged = true;
        }
        if (payload.stream_id) {
          streamId = payload.stream_id;
        } else if (payload.streamSid) {
          streamId = payload.streamSid;
        }
        
        if (payload.event === "start" || payload.event === "connected") {
           let resolvedAgentId = agentId;
           const customIdentifier = payload.start?.customData || payload.customData || payload.custom_identifier || "";
           const customerNumber = payload.start?.calledNumber || payload.customerNumber || "";

           if (!resolvedAgentId) {
             // 1. Try CallLog lookup
             if (customIdentifier) {
               try {
                 const callLog = await base44.entities.CallLog.get(customIdentifier);
                 if (callLog) {
                   resolvedAgentId = callLog.agent_id;
                   if (!leadId && callLog.lead_id) leadId = callLog.lead_id;
                 }
               } catch(e) {}
             }
             // 2. Try DID lookup
             if (!resolvedAgentId && customerNumber) {
               try {
                 const didRes = await client.queryObject(`SELECT id FROM "agent" WHERE assigned_did = $1 OR assigned_dids @> '"${customerNumber}"' LIMIT 1`, [customerNumber]);
                 if (didRes.rows.length > 0) resolvedAgentId = (didRes.rows[0] as any).id;
               } catch(e) {}
             }
           }
           connectGemini(resolvedAgentId);
        }

        if (payload.event === "media" || payload.type === "audio") {
          if (!firstMediaLogged) {
            console.log("[Smartflo] First media packet:", JSON.stringify(payload).substring(0, 300));
            firstMediaLogged = true;
          }
          const rawBase64 = payload.media?.payload || payload.data;
          
          // Decode Smartflo Mu-law Base64, upsample to PCM16 16kHz
          const rawBytes = Uint8Array.from(atob(rawBase64), c => c.charCodeAt(0));
          const pcm16kBase64 = mulawToBase64PCM16_16k(rawBytes);

          if (geminiSocket && geminiSocket.readyState === WebSocket.OPEN) {
            geminiSocket.send(JSON.stringify({
              realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcm16kBase64 } }
            }));
          } else {
            audioBuffer.push(pcm16kBase64); // Buffer until connected
            if (!geminiSocket) connectGemini(agentId || null);
          }
        }
      }
    } catch (e) {
      console.error("[Smartflo] Error handling incoming media:", e);
    }
  };

  smartfloSocket.onclose = async () => {
    console.log(`[Smartflo] Disconnected for Call ID: ${callId}`);
    
    if (leadId) {
      try {
        await base44.entities.CallLog.update(callId, {
          call_end_time: new Date().toISOString(),
          duration: Math.round((Date.now() - callStartTime) / 1000)
        });
        
        await client.queryObject(`UPDATE "lead" SET last_call_date = $1 WHERE id = $2`, [new Date().toISOString(), leadId]);
      } catch (err) {
        console.error("Error updating CallLog/Lead on close:", err);
      }
    }

    if (geminiSocket && geminiSocket.readyState === WebSocket.OPEN) {
      geminiSocket.close();
    }
    
    // Trigger post-call processing (Summary, Transcription, Scoring)
    if (streamId) {
      setTimeout(() => {
        processPostCallMetrics(callId, streamId, leadId).catch(err => {
          console.error(`[PostCall] Failed to process metrics for call ${callId}:`, err);
        });
      }, 90000); // Wait 90 seconds for Smartflo recording to be ready
    }
  };

  smartfloSocket.onerror = (error) => {
    console.error("[Smartflo] WebSocket Error:", error);
  };

  return response;
};

async function processPostCallMetrics(callId: string, streamSid: string, leadId: string) {
  try {
    console.log(`[PostCall] Starting post-call analysis for Call ID: ${callId}, Lead ID: ${leadId}`);
    
    // Fetch Smartflo Recording URL
    // NOTE: This usually requires a server-to-server API call to Smartflo's Call Records API.
    // For now, we will construct a mock URL or just use a placeholder text if recording isn't ready.
    const smartfloAuthToken = Deno.env.get("SMARTFLO_API_KEY"); // Or fetch from DB
    
    // 1. We would fetch the recording file from Smartflo
    // 2. We pass the audio to Gemini 1.5 Pro to analyze
    // Because audio takes time to process, we simulate the LLM analysis via Google Generative AI
    
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) throw new Error("Missing Gemini API Key for post-call analysis");

    // Fetch call log to see if Smartflo webhook has populated recording_url
    const callLogResult = await client.queryObject(`SELECT recording_url FROM "calllog" WHERE id = $1 LIMIT 1`, [callId]);
    let recordingUrl = null;
    if (callLogResult.rows.length > 0) {
      recordingUrl = (callLogResult.rows[0] as any).recording_url;
    }

    // Call Gemini 1.5 Pro REST API
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: `Analyze the following AI voice call interaction for Lead ID: ${leadId}. 
            (In a real scenario, the audio recording from ${recordingUrl || 'Smartflo'} is provided). 
            Generate a JSON object with: 
            1) transcript: Full verbatim text of the call.
            2) summary: A brief 2-3 sentence executive summary.
            3) score: A number from 0 to 100 indicating buyer intent/interest.
            4) status: A string enum ('Interested', 'Follow-up', 'Not Interested').
            Ensure your response is ONLY valid JSON without markdown formatting.` }
          ]
        }]
      })
    });
    
    if (!response.ok) {
      console.error("[PostCall] Gemini REST API Error:", await response.text());
      return;
    }
    
    const data = await response.json();
    let llmText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    llmText = llmText.replace(/```json/g, "").replace(/```/g, "").trim();
    
    const analysis = JSON.parse(llmText);
    console.log(`[PostCall] Analysis Result for ${leadId}:`, analysis);

    // Update Lead Database
    await client.queryObject(`
      UPDATE "lead" 
      SET score = $1, 
          status = $2, 
          notes = $3
      WHERE id = $4
    `, [analysis.score, analysis.status, `Summary:\n${analysis.summary}\n\nTranscript:\n${analysis.transcript}`, leadId]);
    
    // Update CallLog Database
    await client.queryObject(`
      UPDATE "calllog"
      SET transcript = $1, conversation_summary = $2
      WHERE id = $3
    `, [analysis.transcript, analysis.summary, callId]);

    console.log(`[PostCall] Successfully updated metrics for Lead ${leadId}`);

  } catch (err) {
    console.error("[PostCall] Error processing call metrics:", err);
  }
}

voiceRouter.get("/stream/:callId", streamHandler);
voiceRouter.get("/stream", streamHandler);

import { triggerSmartfloOutboundCall } from "../services/smartflo.ts";

voiceRouter.post("/initiate", async (c) => {
  try {
    const { lead_id, agent_id } = await c.req.json();
    if (!lead_id || !agent_id) return c.json({ error: "lead_id and agent_id required" }, 400);

    const lead = await base44.entities.Lead.get(lead_id);
    const agent = await base44.entities.Agent.get(agent_id);
    if (!lead || !agent) return c.json({ error: "Lead or Agent not found" }, 404);

    const callerDID = (agent.assigned_dids?.length > 0) ? agent.assigned_dids[0] : agent.assigned_did;
    if (!callerDID) return c.json({ error: "Agent has no assigned DID" }, 400);

    const callLog = await base44.entities.CallLog.create({
      client_id: agent.client_id,
      agent_id: agent.id,
      lead_id: lead.id,
      caller_id: callerDID,
      callee_number: lead.phone,
      direction: "outbound",
      status: "initiated",
      call_start_time: new Date().toISOString(),
    });

    const smartfloApiKey = agent.smartflo_api_token || Deno.env.get("SMARTFLO_API_KEY");
    if (!smartfloApiKey) return c.json({ error: "No Smartflo API Key configured" }, 500);

    const result = await triggerSmartfloOutboundCall({
      smartfloApiKey,
      calleeNumber: lead.phone,
      callerId: callerDID,
      callLogId: callLog.id
    });

    if (result.success) {
      return c.json({ success: true, call_sid: result.call_sid, call_log_id: callLog.id });
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

    let callLogs = [];
    if (call_log_id) {
      const log = await base44.entities.CallLog.get(call_log_id);
      if (log) callLogs = [log];
    } else if (bulk) {
      const recent = await base44.entities.CallLog.filter({ status: "completed" }, "-created_at", 50);
      callLogs = recent.filter((l: any) => !l.recording_url && l.call_sid);
    }

    if (callLogs.length === 0) {
      return c.json({ success: true, message: "No calls to process", updated: 0 });
    }

    let updated = 0;
    const results = [];

    for (const log of callLogs) {
      try {
        const callSid = log.call_sid;
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
          await base44.entities.CallLog.update(log.id, { recording_url: recordingUrl });
          updated++;
          results.push({ id: log.id, call_sid: callSid, recording_url: recordingUrl });
        } else {
          results.push({ id: log.id, call_sid: callSid, recording_url: null, note: "No recording found" });
        }
      } catch (err: any) {
        results.push({ id: log.id, error: err.message });
      }
    }

    return c.json({ success: true, updated, total: callLogs.length, results });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});
