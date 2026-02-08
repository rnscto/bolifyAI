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
  console.log('[streamAudio] Incoming request:');
  console.log('[streamAudio] Method:', req.method);
  console.log('[streamAudio] URL:', req.url);
  console.log('[streamAudio] Upgrade header:', req.headers.get('upgrade'));

  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    console.log('[streamAudio] ✗ Not a WebSocket request, responding with 400');
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 400 });
  }

  console.log('[streamAudio] ✓ WebSocket upgrade header found, upgrading...');
  let socket, response;
  try {
    const upgrade = Deno.upgradeWebSocket(req);
    socket = upgrade.socket;
    response = upgrade.response;
    console.log('[streamAudio] ✓ WebSocket upgraded successfully');
  } catch (error) {
    console.error('[streamAudio] ✗ Failed to upgrade WebSocket:', error.message);
    return Response.json({ error: 'Failed to upgrade to WebSocket' }, { status: 400 });
  }

  const url = new URL(req.url);
  const callSid = url.searchParams.get('call_sid');
  console.log('[streamAudio] Call SID:', callSid);

  let base44;
  try {
    base44 = createClientFromRequest(req);
  } catch (error) {
    console.log('[streamAudio] Base44 client creation skipped:', error.message);
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

  socket.onopen = async () => {
    console.log('[streamAudio] ✓ WebSocket connection opened for call:', callSid);
    if (base44 && callSid) {
      try {
        const callLogs = await base44.asServiceRole.entities.CallLog.filter({ call_sid: callSid });
        if (callLogs.length > 0) {
          callLog = callLogs[0];
          agent = await base44.asServiceRole.entities.Agent.get(callLog.agent_id);
          lead = await base44.asServiceRole.entities.Lead.get(callLog.lead_id);
          console.log('[streamAudio] Loaded call data - Agent:', agent?.name, 'Lead:', lead?.name);
        }
      } catch (error) {
        console.error('[streamAudio] Error loading call data:', error);
      }
    }
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[streamAudio] Message received:', data.event);

      if (data.event === 'connected') {
        console.log('[streamAudio] Smartflo stream connected');
      }

      if (data.event === 'start') {
        streamSid = data.start?.streamSid;
        console.log('[streamAudio] Call started, streamSid:', streamSid);
        callState = CALL_STATES.SPEAKING;
        const welcomeText = 'Hello, how can I help you today?';
        console.log('[streamAudio] Sending welcome message');
      }

      if (data.event === 'media' && data.media) {
        console.log('[streamAudio] Media chunk received');
      }

      if (data.event === 'mark') {
        console.log('[streamAudio] Mark received:', data.mark?.name);
        callState = CALL_STATES.LISTENING;
        audioBuffer = [];
        hasSpeechStarted = false;
        consecutiveSilentChunks = 0;
      }

      if (data.event === 'stop') {
        console.log('[streamAudio] Call stopped');
        socket.close();
      }
    } catch (error) {
      console.error('[streamAudio] Error processing message:', error);
    }
  };

  socket.onerror = (error) => {
    console.error('[streamAudio] WebSocket error:', error);
  };

  socket.onclose = () => {
    console.log('[streamAudio] WebSocket closed for call:', callSid);
  };

  return response;
});