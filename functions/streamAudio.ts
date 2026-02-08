import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const CALL_STATES = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  SPEAKING: 'SPEAKING'
};

const VAD_CONFIG = {
  SPEECH_THRESHOLD: 500,
  SILENCE_CHUNKS_FOR_END: 8,
  BARGE_IN_THRESHOLD: 1500
};

Deno.serve(async (req) => {
  console.log('[streamAudio] Request:', req.method, req.url);
  console.log('[streamAudio] Upgrade header:', req.headers.get("upgrade"));

  // Check for WebSocket upgrade
  if (req.headers.get("upgrade") !== "websocket") {
    console.error('[streamAudio] No WebSocket upgrade header');
    return new Response("Expected WebSocket", { status: 426 });
  }

  try {
    const { socket, response } = Deno.upgradeWebSocket(req);
    console.log('[streamAudio] WebSocket upgraded successfully');

    const url = new URL(req.url);
    const callSid = url.searchParams.get('call_sid');
    console.log('[streamAudio] Call SID:', callSid);

    let base44;
    try {
      base44 = createClientFromRequest(req);
    } catch (error) {
      console.log('[streamAudio] Base44 client skipped:', error.message);
    }

    let callState = CALL_STATES.IDLE;
    let streamSid = null;
    let callLog = null;
    let agent = null;
    let lead = null;
    let conversationHistory = [];
    let audioBuffer = [];
    let hasSpeechStarted = false;
    let consecutiveSilentChunks = 0;
    let isProcessing = false;

    socket.onopen = () => {
      console.log('[streamAudio] Socket opened for call:', callSid);
    };

    socket.onmessage = async (event) => {
      try {
        console.log('[streamAudio] Message received:', event.data?.substring?.(0, 100));
        const data = JSON.parse(event.data);

        if (data.event === 'connected') {
          console.log('[streamAudio] Connected event');
          socket.send(JSON.stringify({ event: 'connected' }));
        }

        if (data.event === 'start') {
          streamSid = data.start?.streamSid;
          console.log('[streamAudio] Call started, streamSid:', streamSid);
          callState = CALL_STATES.LISTENING;
        }

        if (data.event === 'media' && data.media) {
          const audioPayload = data.media.payload;
          console.log('[streamAudio] Media chunk received');
          
          if (callState === CALL_STATES.LISTENING) {
            // Handle incoming audio
          }
        }

        if (data.event === 'mark') {
          console.log('[streamAudio] Mark:', data.mark?.name);
        }

        if (data.event === 'stop') {
          console.log('[streamAudio] Call stopped');
          socket.close();
        }
      } catch (error) {
        console.error('[streamAudio] Message error:', error);
      }
    };

    socket.onerror = (error) => {
      console.error('[streamAudio] Socket error:', error);
    };

    socket.onclose = () => {
      console.log('[streamAudio] Socket closed');
    };

    return response;
  } catch (error) {
    console.error('[streamAudio] Error:', error);
    return new Response('WebSocket error: ' + error.message, { status: 500 });
  }
});