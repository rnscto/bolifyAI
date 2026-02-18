import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, X, Phone, PhoneOff, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { base44 } from '@/api/base44Client';
import LeadCaptureForm from './LeadCaptureForm';

const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png";
const SAMPLE_RATE = 24000;

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

  const messagesEndRef = useRef(null);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorRef = useRef(null);
  const playbackQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const sourceNodeRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // ─── Audio Playback: queue PCM16 chunks and play them sequentially ───

  const playNextChunk = useCallback(() => {
    if (playbackQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    const pcm16Data = playbackQueueRef.current.shift();

    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === 'closed') return;

    // Decode base64 → PCM16 LE → Float32
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

  // ─── WebSocket connection to backend relay ───

  const statsRef = useRef({ audioSent: 0, audioReceived: 0, audioSentBytes: 0, audioRecvBytes: 0 });

  const connectWebSocket = useCallback(async () => {
    setStatus('connecting');
    statsRef.current = { audioSent: 0, audioReceived: 0, audioSentBytes: 0, audioRecvBytes: 0 };

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/functions/webVoiceAgent`;

    vlog('info', `🔌 Connecting WebSocket: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      vlog('info', '✅ WebSocket connected, waiting for session_ready from server...');
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        vlog('error', '❌ Failed to parse server message:', err.message, event.data?.substring(0, 100));
        return;
      }

      if (msg.type === 'session_ready') {
        vlog('info', '✅ Azure Realtime session ready → starting mic capture');
        setStatus('listening');
        startMicCapture();
        return;
      }

      if (msg.type === 'audio') {
        statsRef.current.audioReceived++;
        statsRef.current.audioRecvBytes += (msg.data?.length || 0);
        if (statsRef.current.audioReceived <= 3 || statsRef.current.audioReceived % 50 === 0) {
          vlog('info', `🔊 Audio chunk #${statsRef.current.audioReceived} from server | ${msg.data?.length || 0} b64 chars | total=${(statsRef.current.audioRecvBytes/1024).toFixed(1)}KB`);
        }
        setStatus('speaking');
        enqueueAudio(msg.data);
        return;
      }

      if (msg.type === 'audio_done') {
        vlog('info', `🔊 AI audio complete | total_chunks=${statsRef.current.audioReceived}`);
        setTimeout(() => {
          if (isPlayingRef.current) return;
          setStatus('listening');
        }, 500);
        return;
      }

      if (msg.type === 'transcript') {
        vlog('info', `📝 Transcript [${msg.role}]: "${msg.text?.substring(0, 100)}"`);
        setMessages(prev => [...prev, { role: msg.role, text: msg.text }]);
        return;
      }

      if (msg.type === 'speech_started') {
        vlog('info', '🛑 Barge-in: user speaking, clearing playback');
        clearPlayback();
        setStatus('listening');
        return;
      }

      if (msg.type === 'speech_stopped') {
        vlog('info', '🔇 User speech stopped');
        return;
      }

      if (msg.type === 'error') {
        vlog('error', '❌ Server error:', msg.message);
        setMessages(prev => [...prev, { role: 'system', text: `Error: ${msg.message}` }]);
        return;
      }

      if (msg.type === 'session_ended') {
        vlog('info', '📴 Session ended by server');
        return;
      }

      vlog('warn', `⚠️ Unknown message type from server: ${msg.type}`);
    };

    ws.onclose = (event) => {
      vlog('info', `🔴 WebSocket closed | code=${event.code} reason="${event.reason || 'none'}" wasClean=${event.wasClean}`);
      vlog('info', `📊 FRONTEND STATS | audio_sent=${statsRef.current.audioSent} (${(statsRef.current.audioSentBytes/1024).toFixed(1)}KB) | audio_recv=${statsRef.current.audioReceived} (${(statsRef.current.audioRecvBytes/1024).toFixed(1)}KB)`);
    };

    ws.onerror = (err) => {
      vlog('error', '❌ WebSocket error event:', err);
      setStatus('idle');
      setMessages(prev => [...prev, { role: 'system', text: 'Connection error. Please try again.' }]);
    };
  }, [enqueueAudio, clearPlayback]);

  // ─── Mic capture: stream PCM16 24kHz to WS ───

  const startMicCapture = useCallback(async () => {
    vlog('info', '🎤 Requesting microphone access...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: SAMPLE_RATE, channelCount: 1 } });
      mediaStreamRef.current = stream;
      const tracks = stream.getAudioTracks();
      vlog('info', `✅ Mic access granted | tracks=${tracks.length} | settings=${JSON.stringify(tracks[0]?.getSettings())}`);

      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = ctx;
      vlog('info', `🔊 AudioContext created | sampleRate=${ctx.sampleRate} | state=${ctx.state}`);

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
        statsRef.current.audioSentBytes += base64.length;
        if (statsRef.current.audioSent <= 3 || statsRef.current.audioSent % 100 === 0) {
          vlog('info', `🎤 Mic→Server audio #${statsRef.current.audioSent} | ${base64.length} b64 chars | ${float32.length} samples | total=${(statsRef.current.audioSentBytes/1024).toFixed(1)}KB`);
        }

        ws.send(JSON.stringify({ type: 'audio', data: base64 }));
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      vlog('info', `✅ Mic capture pipeline started at ${ctx.sampleRate}Hz`);
    } catch (err) {
      vlog('error', `❌ Mic error: ${err.name} - ${err.message}`);
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
    // Don't close audio context — needed for playback
  }, []);

  // ─── Start / End conversation ───

  const handleStartConversation = () => {
    vlog('info', '▶️ User clicked Start Voice Chat');
    setShowPulse(false);
    setMessages([]);
    setShowLeadForm(false);
    setMessages([{ role: 'system', text: 'Connecting to VaaniAI...' }]);
    connectWebSocket();
  };

  const handleEndConversation = () => {
    vlog('info', '⏹️ User ended conversation');
    vlog('info', `📊 Final stats: audio_sent=${statsRef.current.audioSent} audio_recv=${statsRef.current.audioReceived}`);
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
    vlog('info', '✖️ User closed popup');
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
  };

  const handleTextSubmit = (e) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      vlog('warn', '⚠️ Cannot send text: WebSocket not open');
      return;
    }
    
    const text = textInput.trim();
    vlog('info', `💬 User typed: "${text}"`);
    setMessages(prev => [...prev, { role: 'user', text }]);
    ws.send(JSON.stringify({ type: 'text', text }));
    setTextInput('');
  };

  const handleLeadSubmitted = () => {
    setShowLeadForm(false);
    setStatus('idle');
    setMessages([]);
  };

  const hasStarted = messages.length > 0 && status !== 'idle';

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
            className="fixed bottom-6 right-6 z-[60] w-16 h-16 rounded-full bg-gradient-to-br from-[#1a365d] to-[#2563eb] text-white shadow-2xl flex items-center justify-center hover:scale-110 transition-transform group"
            aria-label="Talk to VaaniAI"
          >
            {showPulse && (
              <>
                <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-30" />
                <span className="absolute inset-0 rounded-full bg-blue-400 animate-pulse opacity-20" />
              </>
            )}
            <Mic className="w-7 h-7 relative z-10" />
            <span className="absolute bottom-full right-0 mb-3 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              Talk to VaaniAI Assistant
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
                <img src={LOGO_URL} alt="VaaniAI" className="h-8 brightness-0 invert" />
                <div>
                  <p className="text-white text-sm font-semibold leading-tight">Voice Assistant</p>
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${statusColor[status]}`} />
                    <span className="text-white/70 text-[10px]">{statusText[status]}</span>
                  </div>
                </div>
              </div>
              <button onClick={handleClose} className="text-white/70 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {showLeadForm ? (
              <LeadCaptureForm
                conversationTranscript={messages}
                onSubmitted={handleLeadSubmitted}
                onSkip={handleLeadSubmitted}
              />
            ) : (
              <>
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px] max-h-[320px] bg-gray-50">
                  {status === 'idle' && messages.length === 0 && (
                    <div className="text-center py-8">
                      <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-50 flex items-center justify-center">
                        <Mic className="w-8 h-8 text-blue-500" />
                      </div>
                      <p className="text-sm font-medium text-gray-800">Talk to VaaniAI</p>
                      <p className="text-xs text-gray-500 mt-1.5 max-w-[240px] mx-auto">
                        Real-time AI voice conversation. Ask about our platform, pricing, or features!
                      </p>
                      <Button
                        onClick={handleStartConversation}
                        className="mt-4 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white rounded-full px-6 gap-2 shadow-lg shadow-green-200"
                      >
                        <Phone className="w-4 h-4" />
                        Start Voice Chat
                      </Button>
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[82%] px-3 py-2 rounded-xl text-sm ${
                        msg.role === 'user'
                          ? 'bg-[#1a365d] text-white rounded-br-sm'
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
                      <p className="text-[10px] text-gray-400">Powered by VaaniAI</p>
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