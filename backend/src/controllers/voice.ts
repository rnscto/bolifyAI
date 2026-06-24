import { Hono } from "hono";
import { client } from "../db/index.ts";
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

    console.log(`[Smartflo] Incoming call from ${from} to ${to} (Call ID: ${callId})`);

    const agentId = c.req.query("agent_id") || "";
    const leadId = c.req.query("lead_id") || "";

    const protocol = new URL(c.req.url).protocol === "https:" ? "wss" : "ws";
    const host = new URL(c.req.url).host;
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

  // Connect to Google Gemini Multimodal Live API
  const HOST = "generativelanguage.googleapis.com";
  const WS_URL = `wss://${HOST}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
  
  const geminiSocket = new WebSocket(WS_URL);

  const agentId = c.req.query("agent_id");
  const leadId = c.req.query("lead_id");
  const callStartTime = Date.now();

  smartfloSocket.onopen = () => {
    console.log(`[Smartflo] Connected for Call ID: ${callId}`);
  };

  geminiSocket.onopen = async () => {
    console.log(`[Gemini] Connected for Call ID: ${callId}`);
    
    let systemInstructionText = "You are a helpful AI business assistant. Keep your answers concise, conversational, and friendly as if you are on a phone call.";
    let voiceName = "Aoede";

    if (agentId) {
      try {
        const agentResult = await client.queryObject(`SELECT prompt, voice_id FROM "agent" WHERE id = $1 LIMIT 1`, [agentId]);
        if (agentResult.rows.length > 0) {
           const agent = agentResult.rows[0] as any;
           if (agent.prompt) systemInstructionText = agent.prompt;
           if (agent.voice_id) voiceName = agent.voice_id;
        }
      } catch (err) {
        console.error("Error fetching agent configuration:", err);
      }
    }
    
    // Initial Setup Message for Gemini Live
    const setupMessage = {
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceName
              }
            }
          }
        },
        systemInstruction: {
          parts: [
            { text: systemInstructionText }
          ]
        }
      }
    };
    
    geminiSocket.send(JSON.stringify(setupMessage));
  };
    
  let streamId: string | null = null;
  let firstMessageLogged = false; let firstMediaLogged = false;

  smartfloSocket.onmessage = (event) => {
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
        
        if (payload.event === "media" || payload.type === "audio") {
          if (!firstMediaLogged) {
            console.log("[Smartflo] First media packet:", JSON.stringify(payload).substring(0, 300));
            firstMediaLogged = true;
          }
          const rawBase64 = payload.media?.payload || payload.data;
          
          // Decode Smartflo Mu-law Base64, upsample to PCM16 16kHz, and send to Gemini
          const rawBytes = Uint8Array.from(atob(rawBase64), c => c.charCodeAt(0));
          const pcm16kBase64 = mulawToBase64PCM16_16k(rawBytes);

          if (geminiSocket.readyState === WebSocket.OPEN) {
            geminiSocket.send(JSON.stringify({
              realtimeInput: {
                audio: {
                  mimeType: "audio/pcm;rate=16000",
                  data: pcm16kBase64
                }
              }
            }));
          }
        }
      }
    } catch (e) {
      console.error("[Smartflo] Error handling incoming media:", e);
    }
  };

  // Receive Audio from Gemini -> Send to Smartflo
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
        if (geminiSocket.readyState === WebSocket.OPEN) {
          geminiSocket.send(JSON.stringify({
            realtimeInput: {
              text: "Hello! Greet me briefly in English or Hindi to start the conversation."
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
            console.log(`[Gemini] Received audio chunk from model (${audioBase64.length} bytes)`);
            
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
      } else {
         console.log("[Gemini] Non-audio message received:", JSON.stringify(data).substring(0, 200));
      }
    } catch (e) {
      console.error("[Gemini] Error handling message:", e);
    }
  };

  smartfloSocket.onclose = async () => {
    console.log(`[Smartflo] Disconnected for Call ID: ${callId}`);
    
    if (leadId) {
      try {
         const duration = Math.round((Date.now() - callStartTime) / 1000);
         await client.queryObject(
           `INSERT INTO "calllog" (lead_id, call_duration, status, recording_url) VALUES ($1, $2, 'completed', '')`,
           [leadId, duration]
         );
         console.log(`[CallLog] Logged call for lead ${leadId} (Duration: ${duration}s)`);

         // Trigger post-call Automations
         const leadResult = await client.queryObject(`SELECT phone_number, name FROM "lead" WHERE id = $1 LIMIT 1`, [leadId]);
         if (leadResult.rows.length > 0) {
           const lead = leadResult.rows[0] as any;
           
           // Example: Send WhatsApp summary or follow-up
           // await sendWhatsAppMessage(lead.phone_number, "post_call_summary", []);

           // Example: Send SMS
           // await sendSMS(lead.phone_number, `Hi ${lead.name || 'there'}, thanks for speaking with BolifyAI! Let us know if you need any more info.`);
         }

      } catch (err) {
         console.error("[CallLog] Failed to log call or trigger automations:", err);
      }
    }

    if (geminiSocket.readyState === WebSocket.OPEN) {
      geminiSocket.close();
    }
  };

  geminiSocket.onclose = (event) => {
    console.log(`[Gemini] Disconnected for Call ID: ${callId} - Code: ${event.code}, Reason: ${event.reason}`);
    if (smartfloSocket.readyState === WebSocket.OPEN) {
      smartfloSocket.close();
    }
  };

  geminiSocket.onerror = (error) => {
    console.error("[Gemini] WebSocket error:", error);
  };

  return response;
};

voiceRouter.get("/stream/:callId", streamHandler);
voiceRouter.get("/stream", streamHandler);

import { base44ORM as base44 } from "../db/orm.ts";
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
