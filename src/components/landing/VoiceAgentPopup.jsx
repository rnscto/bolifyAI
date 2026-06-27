import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, X, PhoneOff, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/api/apiClient';
import LeadCaptureForm from './LeadCaptureForm';
import PreChatForm from './PreChatForm';

const LOGO_URL = "https://media.base44.com/images/public/69c78272bd33d5309cbe2b7c/77d0f07f9_WhatsAppImage2026-04-16at102149AM.jpg";
const SAMPLE_RATE = 24000;

const buildSystemPrompt = (visitorInfo) => {
  const name = visitorInfo?.name || '';
  const email = visitorInfo?.email || '';
  const phone = visitorInfo?.phone || '';
  const solution = visitorInfo?.solution || '';

  return `You are Bolify AI's friendly voice assistant on the website. Your name is Bolify.

=== LANGUAGE & VOICE INSTRUCTIONS ===
- ALWAYS speak in Indian English accent. You are an Indian assistant based in India.
- You MUST adapt to the customer's preferred language. If the customer speaks Hindi, respond in Hindi. If they speak Hinglish (mix of Hindi and English), respond in Hinglish. If they speak pure English, use Indian English.
- Use natural Indian expressions like "ji", "sure thing", "absolutely", "no problem at all".
- Keep responses concise — 2-3 sentences max.
- Be warm, friendly, and professional like a helpful Indian sales executive.

=== VISITOR INFORMATION (from pre-chat form) ===
${name ? `- Visitor Name: ${name}` : '- Name: Not provided'}
${email ? `- Email: ${email}` : '- Email: Not provided'}
${phone ? `- Phone: ${phone}` : '- Phone: Not provided'}
${solution ? `- Interested In: ${solution}` : '- Interest: General inquiry'}

=== GREETING INSTRUCTIONS ===
${name ? `START the conversation by greeting the visitor BY NAME. Say something like "Hi ${name}! Welcome to Bolify AI. ${solution ? `I see you're interested in ${solution} — ` : ''}How can I help you today?"` : 'Greet the visitor warmly and ask how you can help.'}
${email ? `You already have their email (${email}). You do NOT need to ask for it again. Use it directly with the send_email tool when needed.` : 'Try to naturally collect their email during the conversation.'}
${phone ? `You already have their phone number (${phone}). No need to ask again.` : ''}

=== YOUR GOALS ===
1. Greet the visitor personally using their name
2. Answer questions about Bolify AI using your knowledge base
3. If they shared a solution interest, tailor the conversation around that
4. Encourage the 7-day free trial
5. When appropriate, use the send_email tool to send them relevant info

=== EMAIL TOOL ===
You have a tool called "send_email" to send emails with trial links, pricing details, demo booking links, or special offers.
${email ? `The visitor's email is: ${email} — use it directly, don't ask again.` : 'Ask for their email before using this tool.'}
Available template types:
- "free_trial" — Free trial signup link
- "pricing" — Detailed pricing breakdown  
- "demo" — Demo booking link
- "offer" — Special 20% discount offer with coupon code BOLIFY20

After sending an email, confirm to the visitor that you've sent it.

=== ABOUT BOLIFY AI ===
Bolify AI is India's #1 AI-powered voice agent platform for sales automation, lead qualification, customer engagement, and e-Governance. We automate outbound and inbound calling with human-like AI voice agents in English, Hindi, and Hinglish.

=== PRICING ===
- Voice AI Agent: ₹6,500/month per channel (₹19,500/quarter)
- Each channel = 1 concurrent call line (DID number)
- Unlimited calls & minutes (NO per-minute charges)
- CRM: ₹1,999/month (optional add-on)
- 7-day free trial, no credit card required

=== CURRENT OFFERS ===
- 20% off first quarter with code BOLIFY20
- 7-day free trial, no credit card required

=== INDUSTRIES ===
Real Estate, Healthcare, Education, Gym & Fitness, Insurance, Automotive, Travel, Retail, Financial Services, Government`;
};

const TOOLS = [
  {
    type: 'function',
    name: 'send_email',
    description: 'Send an email to the visitor with links for free trial, pricing details, demo booking, or special offers. Use this when the visitor shares their email and wants information.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The visitor email address' },
        name: { type: 'string', description: 'The visitor name (if known)' },
        template_type: { 
          type: 'string', 
          enum: ['free_trial', 'pricing', 'demo', 'offer'],
          description: 'Type of email to send: free_trial (trial link), pricing (pricing details), demo (demo booking), offer (special discount)'
        }
      },
      required: ['email', 'template_type']
    }
  }
];

function vlog(level, ...args) {
  const ts = new Date().toISOString().substring(11, 23);
  const prefix = `[VoiceAgent][${ts}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

export default function VoiceAgentPopup() {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState('idle'); // idle, connecting, listening, speaking, ended
  const [messages, setMessages] = useState([]);
  const [textInput, setTextInput] = useState('');
  const [showPulse, setShowPulse] = useState(true);
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [visitorInfo, setVisitorInfo] = useState(null); // null = show pre-chat form

  const messagesEndRef = useRef(null);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorRef = useRef(null);
  const playbackQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const sourceNodeRef = useRef(null);
  const statsRef = useRef({ audioSent: 0, audioReceived: 0 });

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // ─── Audio Playback ───

  const playNextChunk = useCallback(() => {
    if (playbackQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    const pcm16Data = playbackQueueRef.current.shift();

    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === 'closed') return;

    const raw = atob(pcm16Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    
    const view = new DataView(bytes.buffer);
    const numSamples = Math.floor(bytes.length / 2);
    const float32 = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      float32[i] = view.getInt16(i * 2, true) / 32768;
    }

    const buffer = ctx.createBuffer(1, numSamples, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => playNextChunk();
    source.start();
    sourceNodeRef.current = source;
  }, []);

  const enqueueAudio = useCallback((base64Pcm16) => {
    playbackQueueRef.current.push(base64Pcm16);
    if (!isPlayingRef.current) {
      playNextChunk();
    }
  }, [playNextChunk]);

  const clearPlayback = useCallback(() => {
    playbackQueueRef.current = [];
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch (_) {}
      sourceNodeRef.current = null;
    }
    isPlayingRef.current = false;
  }, []);

  // ─── Mic capture: stream PCM16 24kHz directly to Azure ───

  const startMicCapture = useCallback(async () => {
    vlog('info', '🎤 Requesting mic...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: SAMPLE_RATE, channelCount: 1 } });
      mediaStreamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const float32 = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const bytes = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        statsRef.current.audioSent++;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      vlog('info', `✅ Mic started at ${ctx.sampleRate}Hz`);
    } catch (err) {
      vlog('error', `❌ Mic error: ${err.message}`);
      setMessages(prev => [...prev, { role: 'system', text: 'Microphone access denied. You can type instead.' }]);
      setStatus('listening');
    }
  }, []);

  const stopMicCapture = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  // ─── Direct Azure Realtime WebSocket connection ───

  const connectToAzure = useCallback(async (currentVisitorInfo) => {
    setStatus('connecting');
    statsRef.current = { audioSent: 0, audioReceived: 0 };

    vlog('info', '🔑 Fetching Azure Realtime config...');
    
    let wsUrl, apiKey;
    try {
      const res = await apiClient.functions.invoke('getRealtimeConfig', {});
      wsUrl = res.data.url;
      apiKey = res.data.key;
      vlog('info', `✅ Got config: url=${wsUrl?.substring(0, 60)}...`);
    } catch (err) {
      vlog('error', '❌ Failed to get Azure config:', err.message);
      setMessages(prev => [...prev, { role: 'system', text: 'Failed to connect. Please try again.' }]);
      setStatus('idle');
      return;
    }

    // Build full WSS URL with api-key
    const sep = wsUrl.includes('?') ? '&' : '?';
    const fullUrl = `${wsUrl}${sep}api-key=${encodeURIComponent(apiKey)}`;

    // Build personalized system prompt with visitor info
    const personalizedPrompt = buildSystemPrompt(currentVisitorInfo);
    vlog('info', `🔌 Connecting directly to Azure Realtime... visitor=${currentVisitorInfo?.name || 'anonymous'}`);
    const ws = new WebSocket(fullUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      vlog('info', '✅ Azure Realtime WebSocket connected, waiting for session.created...');
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        vlog('error', '❌ Parse error:', err.message);
        return;
      }

      const type = msg.type;

      // Session created → configure and start mic
      if (type === 'session.created') {
        vlog('info', '✅ Session created, sending config with tools and visitor context...');
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: personalizedPrompt,
            voice: 'shimmer',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600
            },
            tools: TOOLS,
            tool_choice: 'auto'
          }
        }));
        setStatus('listening');
        startMicCapture();

        // Trigger the AI to greet the visitor first
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            vlog('info', '🎙️ Triggering AI greeting...');
            ws.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['text', 'audio'],
                instructions: currentVisitorInfo?.name 
                  ? `Greet ${currentVisitorInfo.name} warmly by name. ${currentVisitorInfo.solution ? `They are interested in ${currentVisitorInfo.solution}.` : ''} Be brief and welcoming.`
                  : 'Greet the visitor warmly. Be brief and welcoming.'
              }
            }));
          }
        }, 500);

        return;
      }

      if (type === 'session.updated') {
        vlog('info', '✅ Session configured');
        return;
      }

      // AI audio
      if (type === 'response.audio.delta' && msg.delta) {
        statsRef.current.audioReceived++;
        setStatus('speaking');
        enqueueAudio(msg.delta);
        return;
      }

      if (type === 'response.audio.done') {
        vlog('info', `🔊 AI audio done | chunks=${statsRef.current.audioReceived}`);
        setTimeout(() => {
          if (!isPlayingRef.current) setStatus('listening');
        }, 500);
        return;
      }

      // User transcript
      if (type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
        const text = msg.transcript.trim();
        if (text) {
          vlog('info', `🗣️ User: "${text.substring(0, 100)}"`);
          setMessages(prev => [...prev, { role: 'user', text }]);
        }
        return;
      }

      // AI transcript
      if (type === 'response.audio_transcript.done' && msg.transcript) {
        const text = msg.transcript.trim();
        if (text) {
          vlog('info', `🤖 AI: "${text.substring(0, 100)}"`);
          setMessages(prev => [...prev, { role: 'ai', text }]);
        }
        return;
      }

      // Barge-in
      if (type === 'input_audio_buffer.speech_started') {
        vlog('info', '🛑 Barge-in detected');
        clearPlayback();
        setStatus('listening');
        return;
      }

      if (type === 'input_audio_buffer.speech_stopped') {
        return;
      }

      // Function call completed — execute the tool
      if (type === 'response.function_call_arguments.done') {
        const callId = msg.call_id;
        const fnName = msg.name;
        vlog('info', `🔧 Tool call: ${fnName} | call_id=${callId} | args=${msg.arguments}`);
        
        if (fnName === 'send_email') {
          let args;
          try { args = JSON.parse(msg.arguments); } catch (_) { args = {}; }
          
          setMessages(prev => [...prev, { role: 'system', text: `📧 Sending ${args.template_type?.replace('_', ' ')} email to ${args.email}...` }]);
          
          // Fire the email in background
          apiClient.functions.invoke('sendVoiceAgentEmail', {
            email: args.email,
            name: args.name || '',
            template_type: args.template_type || 'free_trial'
          }).then(() => {
            vlog('info', `✅ Email sent: ${args.template_type} → ${args.email}`);
            setMessages(prev => [...prev, { role: 'system', text: `✅ Email sent to ${args.email}!` }]);
          }).catch(err => {
            vlog('error', `❌ Email failed: ${err.message}`);
            setMessages(prev => [...prev, { role: 'system', text: `⚠️ Could not send email. Please try again.` }]);
          });

          // Send tool result back to Azure so AI can continue
          ws.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ success: true, message: `Email sent to ${args.email}` })
            }
          }));
          ws.send(JSON.stringify({ type: 'response.create' }));
        }
        return;
      }

      if (type === 'error') {
        vlog('error', '❌ Azure error:', JSON.stringify(msg.error || msg));
        setMessages(prev => [...prev, { role: 'system', text: `Error: ${msg.error?.message || 'AI error'}` }]);
        return;
      }

      // Ignore common event types silently
      if (['response.created', 'response.output_item.added', 'response.content_part.added',
           'response.output_item.done', 'response.content_part.done', 'response.done',
           'conversation.item.created', 'rate_limits.updated', 
           'response.function_call_arguments.delta'].includes(type)) {
        return;
      }

      vlog('info', `📩 Unhandled Azure event: ${type}`);
    };

    ws.onclose = (event) => {
      vlog('info', `🔴 Azure WS closed | code=${event.code} wasClean=${event.wasClean}`);
    };

    ws.onerror = (err) => {
      vlog('error', '❌ Azure WS error:', err);
      setStatus('idle');
      setMessages(prev => [...prev, { role: 'system', text: 'Connection error. Please try again.' }]);
    };
  }, [enqueueAudio, clearPlayback, startMicCapture]);

  // ─── Start / End conversation ───

  const handlePreChatSubmit = (info) => {
    vlog('info', `▶️ Pre-chat form submitted: name=${info.name} email=${info.email} phone=${info.phone} solution=${info.solution}`);
    setVisitorInfo(info);
    setShowPulse(false);
    setMessages([{ role: 'system', text: 'Connecting to Bolify AI...' }]);
    setShowLeadForm(false);
    connectToAzure(info);

    // Don't create lead here — will be created after conversation ends with full summary
  };

  const handleStartConversation = () => {
    vlog('info', '▶️ Start Voice Chat');
    setShowPulse(false);
    setMessages([]);
    setShowLeadForm(false);
    setMessages([{ role: 'system', text: 'Connecting to Bolify AI...' }]);
    connectToAzure(visitorInfo);
  };

  const handleEndConversation = () => {
    vlog('info', '⏹️ End conversation');
    clearPlayback();
    stopMicCapture();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
    setStatus('ended');
    setShowLeadForm(true);
  };

  const handleClose = () => {
    clearPlayback();
    stopMicCapture();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setStatus('idle');
    setIsOpen(false);
    setMessages([]);
    setShowPulse(true);
    setShowLeadForm(false);
    setVisitorInfo(null);
  };

  const handleTextSubmit = (e) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    const text = textInput.trim();
    setMessages(prev => [...prev, { role: 'user', text }]);
    // Send as conversation item + trigger response
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    setTextInput('');
  };

  const handleLeadSubmitted = () => {
    setShowLeadForm(false);
    setStatus('idle');
    setMessages([]);
  };

  const hasStarted = visitorInfo && messages.length > 0 && status !== 'idle';

  const statusText = {
    idle: 'Ready',
    connecting: '⏳ Connecting...',
    listening: '🎙️ Listening...',
    speaking: '🔊 Speaking...',
    ended: 'Conversation ended'
  };

  const statusColor = {
    idle: 'bg-green-500',
    connecting: 'bg-yellow-500',
    listening: 'bg-blue-500',
    speaking: 'bg-orange-500',
    ended: 'bg-gray-400'
  };

  return (
    <>
      {/* Floating trigger */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 2 }}
            onClick={() => setIsOpen(true)}
            className="fixed bottom-6 right-6 z-[60] w-16 h-16 rounded-full bg-gradient-to-br from-[#1a365d] to-[#2563eb] text-gray-900 shadow-2xl flex items-center justify-center hover:scale-110 transition-transform group"
            aria-label="Talk to Bolify AI"
          >
            {showPulse && (
              <>
                <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-30" />
                <span className="absolute inset-0 rounded-full bg-blue-400 animate-pulse opacity-20" />
              </>
            )}
            <Mic className="w-7 h-7 relative z-10" />
            <span className="absolute bottom-full right-0 mb-3 px-3 py-1.5 bg-gray-900 text-gray-900 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              Talk to Bolify AI Assistant
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Popup */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="fixed bottom-6 right-6 z-[60] w-[370px] max-h-[560px] bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-[#1a365d] to-[#2563eb] px-4 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <img src={LOGO_URL} alt="Bolify AI" className="h-8 brightness-0 invert" />
                <div>
                  <p className="text-gray-900 text-sm font-semibold leading-tight">Voice Assistant</p>
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${statusColor[status]}`} />
                    <span className="text-gray-900/70 text-[10px]">{statusText[status]}</span>
                  </div>
                </div>
              </div>
              <button onClick={handleClose} className="text-gray-900/70 hover:text-gray-900 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {showLeadForm ? (
              <LeadCaptureForm
                conversationTranscript={messages}
                visitorInfo={visitorInfo}
                onSubmitted={handleLeadSubmitted}
                onSkip={handleLeadSubmitted}
              />
            ) : !visitorInfo && status === 'idle' ? (
              <PreChatForm onStart={handlePreChatSubmit} />
            ) : (
              <>
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px] max-h-[320px] bg-gray-50">
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[82%] px-3 py-2 rounded-xl text-sm ${
                        msg.role === 'user'
                          ? 'bg-[#1a365d] text-gray-900 rounded-br-sm'
                          : msg.role === 'ai'
                          ? 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm'
                          : 'bg-blue-50 text-blue-600 text-xs text-center w-full rounded-lg'
                      }`}>
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  {status === 'connecting' && (
                    <div className="flex justify-center">
                      <div className="flex gap-1.5 py-2">
                        <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Controls */}
                {hasStarted && (
                  <div className="p-3 bg-white border-t border-gray-100 shrink-0 space-y-2">
                    {/* Listening indicator */}
                    {status === 'listening' && (
                      <div className="flex items-center justify-center gap-2 py-1">
                        <div className="flex gap-0.5 items-end h-4">
                          {[1,2,3,4,5].map(i => (
                            <div key={i} className="w-1 bg-blue-500 rounded-full animate-pulse" 
                              style={{ height: `${8 + Math.random() * 10}px`, animationDelay: `${i * 100}ms` }} />
                          ))}
                        </div>
                        <span className="text-xs text-blue-600 font-medium">Listening...</span>
                      </div>
                    )}
                    {status === 'speaking' && (
                      <div className="flex items-center justify-center gap-2 py-1">
                        <div className="flex gap-0.5 items-end h-4">
                          {[1,2,3,4,5].map(i => (
                            <div key={i} className="w-1 bg-orange-500 rounded-full animate-pulse"
                              style={{ height: `${8 + Math.random() * 10}px`, animationDelay: `${i * 80}ms` }} />
                          ))}
                        </div>
                        <span className="text-xs text-orange-600 font-medium">AI Speaking...</span>
                      </div>
                    )}

                    {/* Text input fallback */}
                    <form onSubmit={handleTextSubmit} className="flex gap-2">
                      <Input
                        value={textInput}
                        onChange={(e) => setTextInput(e.target.value)}
                        placeholder="Or type a message..."
                        className="flex-1 h-9 text-sm"
                      />
                      <Button
                        type="submit"
                        size="icon"
                        disabled={!textInput.trim()}
                        className="w-9 h-9 shrink-0 bg-[#1a365d] hover:bg-[#2563eb]"
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    </form>
                    <div className="flex justify-between items-center">
                      <p className="text-[10px] text-gray-500">Powered by Bolify AI</p>
                      <button
                        onClick={handleEndConversation}
                        className="text-[10px] text-red-500 hover:text-red-600 flex items-center gap-1"
                      >
                        <PhoneOff className="w-3 h-3" /> End Chat
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}