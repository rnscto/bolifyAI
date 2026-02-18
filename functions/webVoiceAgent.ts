import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const VAANI_SYSTEM_PROMPT = `You are VaaniAI's friendly AI voice assistant on the VaaniAI website. Your job is to help visitors learn about VaaniAI.

About VaaniAI:
- VaaniAI is India's leading AI voice agent platform for sales automation and e-Governance
- It provides AI-powered outbound and inbound calling agents that can handle sales calls, lead qualification, appointment booking, and customer support
- Key features: AI Voice Agents, Smart CRM, Campaign Management, Multi-language support (English, Hindi, bilingual), Knowledge Base training, Call Analytics
- Pricing: Voice AI Agent at ₹6,500/month per channel (quarterly billing), Custom Sales CRM at ₹1,999/month
- 7-day free trial available for all new users
- Industries served: Real Estate, Healthcare, Education, Gym & Fitness, Insurance, Automotive, Travel, Retail, Financial Services
- Technology: Powered by Azure OpenAI, supports concurrent calling, real-time transcription, automated follow-ups via email
- The platform includes a built-in CRM with deal pipelines, contact management, and activity tracking
- Integration support: Salesforce, HubSpot, Zoho, and custom CRM webhooks

Be enthusiastic but professional. Keep responses concise (1-3 sentences). Encourage visitors to sign up for the free trial.
If asked about technical details you don't know, suggest they sign up or contact the team.`;

Deno.serve(async (req) => {
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  
  if (upgrade !== 'websocket') {
    return Response.json({ 
      status: 'ready', 
      type: 'web-voice-agent',
      description: 'WebSocket endpoint for browser-based voice conversations about VaaniAI'
    });
  }

  let clientSocket, response;
  try {
    const upgraded = Deno.upgradeWebSocket(req);
    clientSocket = upgraded.socket;
    response = upgraded.response;
  } catch (err) {
    return new Response('WebSocket upgrade failed', { status: 500 });
  }

  const sessionId = Math.random().toString(36).substring(2, 10);
  console.log(`[${sessionId}] 🌐 Web voice agent session started`);

  const session = {
    realtimeWs: null,
    realtimeReady: false,
    transcript: [],
  };

  function connectRealtime() {
    const realtimeUrl = Deno.env.get('AZURE_REALTIME_ENDPOINT');
    const realtimeKey = Deno.env.get('AZURE_REALTIME_KEY');

    if (!realtimeUrl || !realtimeKey) {
      console.error(`[${sessionId}] ❌ Missing Azure Realtime credentials`);
      clientSocket.send(JSON.stringify({ type: 'error', message: 'Voice service unavailable' }));
      return;
    }

    let wsUrl = realtimeUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    const separator = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${separator}api-key=${encodeURIComponent(realtimeKey)}`;

    console.log(`[${sessionId}] 🔌 Connecting to Azure Realtime...`);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[${sessionId}] ✅ Azure Realtime connected`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeMessage(msg);
      } catch (err) {
        console.error(`[${sessionId}] ❌ Parse error: ${err.message}`);
      }
    };

    ws.onclose = () => {
      console.log(`[${sessionId}] 🔴 Azure Realtime closed`);
      session.realtimeReady = false;
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'session_ended' }));
      }
    };

    ws.onerror = () => {
      console.error(`[${sessionId}] ❌ Azure Realtime error`);
    };

    session.realtimeWs = ws;
  }

  function sendToRealtime(msg) {
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.send(JSON.stringify(msg));
    }
  }

  function handleRealtimeMessage(msg) {
    const type = msg.type;

    if (type === 'session.created') {
      console.log(`[${sessionId}] ✅ Realtime session created`);
      session.realtimeReady = true;

      sendToRealtime({
        type: 'session.update',
        session: {
          instructions: VAANI_SYSTEM_PROMPT,
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600
          }
        }
      });

      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'ready' }));
      }
      return;
    }

    if (type === 'session.updated') {
      console.log(`[${sessionId}] ✅ Session configured`);
      return;
    }

    // Forward audio back to the browser
    if (type === 'response.audio.delta' && msg.delta) {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'audio', data: msg.delta }));
      }
      return;
    }

    if (type === 'response.audio.done') {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'audio_done' }));
      }
      return;
    }

    // User transcript
    if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        session.transcript.push({ speaker: 'User', text });
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({ type: 'user_transcript', text }));
        }
      }
      return;
    }

    // AI transcript
    if (type === 'response.audio_transcript.done' && msg.transcript) {
      const text = msg.transcript.trim();
      if (text) {
        session.transcript.push({ speaker: 'AI', text });
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(JSON.stringify({ type: 'ai_transcript', text }));
        }
      }
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'listening' }));
      }
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'processing' }));
      }
      return;
    }

    if (type === 'error') {
      console.error(`[${sessionId}] ❌ Realtime error:`, JSON.stringify(msg.error || msg));
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'error', message: 'Voice processing error' }));
      }
      return;
    }
  }

  // Handle messages from the browser
  clientSocket.onopen = () => {
    console.log(`[${sessionId}] 🟢 Browser socket opened`);
    connectRealtime();
  };

  clientSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'audio' && msg.data) {
        if (session.realtimeReady) {
          sendToRealtime({
            type: 'input_audio_buffer.append',
            audio: msg.data
          });
        }
        return;
      }

      if (msg.type === 'end') {
        console.log(`[${sessionId}] 📴 User ended session`);
        if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
          session.realtimeWs.close();
        }
        return;
      }
    } catch (err) {
      console.error(`[${sessionId}] ❌ Browser message error: ${err.message}`);
    }
  };

  clientSocket.onclose = () => {
    console.log(`[${sessionId}] 🔴 Browser socket closed`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  clientSocket.onerror = () => {
    console.error(`[${sessionId}] ❌ Browser socket error`);
    if (session.realtimeWs && session.realtimeWs.readyState === WebSocket.OPEN) {
      session.realtimeWs.close();
    }
  };

  return response;
});