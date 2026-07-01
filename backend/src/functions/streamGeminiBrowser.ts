import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
export default async function streamGeminiBrowser(c: any) {
  const req = c.req.raw || c.req;
  const upgrade = req.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() !== 'websocket') {
    // Self-report the direct wss:// URL of this deployment so callers (getGeminiConfig)
    // can hand it to browsers — Base44's HTTP gateway does NOT proxy WS upgrades.
    const url = new URL(req.url);
    const wsUrl = `wss://${url.host}${url.pathname}`;
    return c.json({ data: { status: 'ready', function: 'streamGeminiBrowser', ws_url: wsUrl } });
  }

  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
  let geminiWs = null;
  let sessionState = { configured: false };

  clientWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'start') {
        const freeKey = Deno.env.get('GEMINI_API_KEY');
        const paidKey = Deno.env.get('GEMINI_API_KEY_PAID');
        if (!freeKey && !paidKey) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'GEMINI_API_KEY not configured' }));
          return;
        }

        const ALLOWED_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];
        const voiceName = ALLOWED_VOICES.includes(msg.voice) ? msg.voice : 'Aoede';
        console.log(`[streamGeminiBrowser] Session voice locked: requested="${msg.voice}" → using="${voiceName}"`);
        const systemPrompt = msg.system_prompt || 'You are a helpful assistant.';
        const language = msg.language || 'English';
        const fullPrompt = `[LANGUAGE INSTRUCTION: Please speak and respond ONLY in ${language}.] ${systemPrompt}`;

        // Auto-fallback: try FREE key first, retry with PAID key on 429/quota close
        let usingPaid = !freeKey;
        let triedFallback = false;
        const isQuotaClose = (e) => {
          if (!e) return false;
          if (e.code === 1011 || e.code === 1008) return true;
          const r = (e.reason || '').toLowerCase();
          return r.includes('quota') || r.includes('resource_exhausted') || r.includes('429') || r.includes('rate limit');
        };

        const openGemini = () => {
          const key = usingPaid ? paidKey : freeKey;
          const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
          console.log(`[streamGeminiBrowser] Connecting Gemini with ${usingPaid ? 'PAID' : 'FREE'} key`);
          geminiWs = new WebSocket(url);

        geminiWs.onopen = () => {
          geminiWs.send(JSON.stringify({
            setup: {
              model: 'models/gemini-3.1-flash-live-preview',
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName }
                  }
                }
              },
              systemInstruction: {
                parts: [{ text: fullPrompt }]
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {}
            }
          }));
        };

        geminiWs.onmessage = async (gEvent) => {
          try {
            let text;
            if (typeof gEvent.data === 'string') {
              text = gEvent.data;
            } else if (gEvent.data instanceof Blob) {
              text = await gEvent.data.text();
            } else {
              text = new TextDecoder().decode(gEvent.data);
            }
            const gMsg = JSON.parse(text);

            if (gMsg.setupComplete) {
              sessionState.configured = true;
              clientWs.send(JSON.stringify({ type: 'ready' }));

              if (msg.greeting) {
                geminiWs.send(JSON.stringify({
                  clientContent: {
                    turns: [{ role: 'user', parts: [{ text: `Say: ${msg.greeting}` }] }],
                    turnComplete: true
                  }
                }));
              }
              return;
            }

            const sc = gMsg.serverContent;
            if (sc?.modelTurn?.parts) {
              for (const part of sc.modelTurn.parts) {
                if (part.inlineData && part.inlineData.data) {
                  clientWs.send(JSON.stringify({ type: 'audio', audio: part.inlineData.data }));
                }
                if (part.text) {
                  clientWs.send(JSON.stringify({ type: 'transcript_ai', text: part.text }));
                }
              }
            }

            // Gemini 3.1 emits structured input/output transcription events
            if (sc?.outputTranscription?.text) {
              clientWs.send(JSON.stringify({ type: 'transcript_ai', text: sc.outputTranscription.text }));
            }
            if (sc?.inputTranscription?.text) {
              clientWs.send(JSON.stringify({ type: 'transcript_user', text: sc.inputTranscription.text }));
            }

            if (sc?.turnComplete) {
              clientWs.send(JSON.stringify({ type: 'turn_complete' }));
            }

            if (sc?.interrupted) {
              clientWs.send(JSON.stringify({ type: 'interrupted' }));
            }

          } catch (e) {
            console.error('Gemini WS parse error', e);
          }
        };

        geminiWs.onclose = (e) => {
          console.error(`Gemini browser relay closed: code=${e.code}, reason=${e.reason || 'none'}`);
          // Auto-fallback to PAID key on quota/rate-limit close
          if (!usingPaid && paidKey && !triedFallback && isQuotaClose(e) && !sessionState.configured) {
            triedFallback = true;
            usingPaid = true;
            console.log('[streamGeminiBrowser] FREE key hit quota → retrying with PAID key');
            openGemini();
            return;
          }
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'error',
              message: `Gemini closed: ${e.reason || `code ${e.code}`}`
            }));
          }
        };

        geminiWs.onerror = () => {
          console.error('Gemini browser relay upstream WebSocket error');
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'error', message: 'Gemini upstream error' }));
          }
        };
        };

        openGemini();
        return;
      }

      if (msg.type === 'audio' && geminiWs && sessionState.configured) {
        geminiWs.send(JSON.stringify({
          realtimeInput: {
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' }
          }
        }));
        return;
      }

      if (msg.type === 'text' && geminiWs && sessionState.configured) {
        geminiWs.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: msg.text }] }],
            turnComplete: true
          }
        }));
        return;
      }

    } catch (err) {
      console.error('Client WS message error', err);
    }
  };

  clientWs.onclose = () => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  };

  return response;

};