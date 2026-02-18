import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, X, Phone, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import LeadCaptureForm from './LeadCaptureForm';

const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png";

// Audio worklet processor code as a blob URL
const WORKLET_CODE = `
class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 2400; // 100ms at 24kHz
    this._buffer = new Float32Array(this._bufferSize);
    this._writeIndex = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._writeIndex++] = channelData[i];
      if (this._writeIndex >= this._bufferSize) {
        // Convert float32 to PCM16 LE
        const pcm16 = new Int16Array(this._bufferSize);
        for (let j = 0; j < this._bufferSize; j++) {
          const s = Math.max(-1, Math.min(1, this._buffer[j]));
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const bytes = new Uint8Array(pcm16.buffer);
        this.port.postMessage({ pcmBytes: bytes });
        this._writeIndex = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-recorder-processor', PCMRecorderProcessor);
`;

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export default function VoiceAgentPopup() {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState('idle'); // idle, connecting, ready, listening, processing, speaking, error, session_ended
  const [messages, setMessages] = useState([]);
  const [showPulse, setShowPulse] = useState(true);
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const messagesEndRef = useRef(null);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const workletNodeRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const playbackContextRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const sourceNodeRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAudio();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const addMessage = useCallback((role, text) => {
    setMessages(prev => [...prev, { role, text }]);
  }, []);

  // ─── Audio playback (PCM16 24kHz from Azure Realtime) ───
  const playAudioChunk = useCallback((base64Audio) => {
    audioQueueRef.current.push(base64Audio);
    drainAudioQueue();
  }, []);

  const drainAudioQueue = useCallback(() => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    isPlayingRef.current = true;

    if (!playbackContextRef.current) {
      playbackContextRef.current = new AudioContext({ sampleRate: 24000 });
    }
    const ctx = playbackContextRef.current;

    const chunks = audioQueueRef.current.splice(0, audioQueueRef.current.length);
    const allBytes = chunks.map(b64 => new Uint8Array(base64ToArrayBuffer(b64)));
    const totalLen = allBytes.reduce((s, a) => s + a.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of allBytes) {
      combined.set(arr, offset);
      offset += arr.length;
    }

    // PCM16 LE → Float32
    const numSamples = Math.floor(combined.length / 2);
    const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
    const float32 = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      float32[i] = view.getInt16(i * 2, true) / 32768;
    }

    const audioBuffer = ctx.createBuffer(1, numSamples, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = () => {
      isPlayingRef.current = false;
      drainAudioQueue();
    };
    source.start();
    sourceNodeRef.current = source;
  }, []);

  const stopPlayback = useCallback(() => {
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch (_) {}
      sourceNodeRef.current = null;
    }
  }, []);

  // ─── Microphone capture → PCM16 24kHz ───
  const startMicrophone = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    mediaStreamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: 24000 });
    audioContextRef.current = ctx;

    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const source = ctx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(ctx, 'pcm-recorder-processor');
    workletNodeRef.current = workletNode;

    workletNode.port.onmessage = (e) => {
      if (isMuted) return;
      const pcmBytes = e.data.pcmBytes;
      const b64 = arrayBufferToBase64(pcmBytes);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'audio_append', audio: b64 }));
      }
    };

    source.connect(workletNode);
    workletNode.connect(ctx.destination); // required for worklet to process
  }, [isMuted]);

  const cleanupAudio = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (playbackContextRef.current) {
      playbackContextRef.current.close();
      playbackContextRef.current = null;
    }
    stopPlayback();
  }, [stopPlayback]);

  // ─── WebSocket connection ───
  const connectWebSocket = useCallback(async () => {
    setStatus('connecting');

    // Determine WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/functions/webVoiceAgent`;

    console.log('Connecting to WS:', wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = async () => {
      console.log('WebSocket connected');
      try {
        await startMicrophone();
      } catch (err) {
        console.error('Mic error:', err);
        addMessage('system', 'Microphone access denied. Please allow microphone access and try again.');
        setStatus('error');
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (err) {
        console.error('WS message parse error:', err);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
      if (status !== 'session_ended' && status !== 'idle') {
        setStatus('session_ended');
        setShowLeadForm(true);
      }
    };

    ws.onerror = () => {
      console.error('WebSocket error');
      setStatus('error');
      addMessage('system', 'Connection error. Please try again.');
    };
  }, [startMicrophone, addMessage, status]);

  const handleServerMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'status':
        if (msg.status === 'ready') {
          setStatus('listening');
          addMessage('ai', "Hi! I'm VaaniAI's voice assistant. How can I help you today?");
        } else if (msg.status === 'session_ended') {
          setStatus('session_ended');
          setShowLeadForm(true);
          cleanupAudio();
        } else if (msg.status === 'error') {
          setStatus('error');
          addMessage('system', msg.message || 'An error occurred');
        } else if (msg.status === 'listening') {
          setStatus('listening');
        } else if (msg.status === 'processing') {
          setStatus('processing');
        } else if (msg.status === 'speaking') {
          setStatus('speaking');
        } else if (msg.status === 'connecting') {
          setStatus('connecting');
        }
        break;

      case 'audio_delta':
        playAudioChunk(msg.audio);
        break;

      case 'barge_in':
        stopPlayback();
        break;

      case 'user_transcript':
        addMessage('user', msg.text);
        break;

      case 'ai_transcript':
        addMessage('ai', msg.text);
        break;
    }
  }, [addMessage, playAudioChunk, stopPlayback, cleanupAudio]);

  // ─── Actions ───
  const handleStartConversation = () => {
    setShowPulse(false);
    setMessages([]);
    setShowLeadForm(false);
    connectWebSocket();
  };

  const handleEndConversation = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end_session' }));
    }
    cleanupAudio();
    setStatus('session_ended');
    setShowLeadForm(true);
  };

  const handleClose = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    cleanupAudio();
    setStatus('idle');
    setIsOpen(false);
    setMessages([]);
    setShowPulse(true);
    setShowLeadForm(false);
  };

  const handleLeadSubmitted = () => {
    setShowLeadForm(false);
    setStatus('idle');
    setMessages([]);
  };

  const toggleMute = () => {
    setIsMuted(prev => !prev);
  };

  const statusText = {
    idle: 'Ready',
    connecting: '🔄 Connecting...',
    ready: '✅ Connected',
    listening: '🎙️ Listening...',
    processing: '💭 Thinking...',
    speaking: '🔊 Speaking...',
    error: '⚠️ Error',
    session_ended: 'Conversation ended'
  };

  const statusColor = {
    idle: 'bg-green-500',
    connecting: 'bg-yellow-500',
    ready: 'bg-green-500',
    listening: 'bg-blue-500',
    processing: 'bg-purple-500',
    speaking: 'bg-orange-500',
    error: 'bg-red-500',
    session_ended: 'bg-gray-400'
  };

  const hasStarted = messages.length > 0 || status === 'connecting';
  const isActive = ['connecting', 'ready', 'listening', 'processing', 'speaking'].includes(status);

  return (
    <>
      {/* Floating trigger button */}
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
              <span className="absolute top-full right-6 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900" />
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Voice agent popup */}
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
                    <span className={`w-2 h-2 rounded-full ${statusColor[status]} ${status === 'connecting' ? 'animate-pulse' : ''}`} />
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
                {/* Messages area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px] max-h-[320px] bg-gray-50">
                  {!hasStarted && (
                    <div className="text-center py-8">
                      <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-50 flex items-center justify-center">
                        <Mic className="w-8 h-8 text-blue-500" />
                      </div>
                      <p className="text-sm font-medium text-gray-800">Talk to VaaniAI</p>
                      <p className="text-xs text-gray-500 mt-1.5 max-w-[240px] mx-auto">
                        Have a real-time voice conversation about our AI voice agents, pricing, and features!
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
                  {status === 'processing' && (
                    <div className="flex justify-start">
                      <div className="bg-white border border-gray-200 rounded-xl rounded-bl-sm shadow-sm px-4 py-2.5">
                        <div className="flex gap-1.5">
                          <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  )}
                  {status === 'connecting' && (
                    <div className="text-center py-4">
                      <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-blue-100 flex items-center justify-center animate-pulse">
                        <Phone className="w-5 h-5 text-blue-500" />
                      </div>
                      <p className="text-xs text-gray-500">Connecting to VaaniAI...</p>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Voice controls */}
                {isActive && (
                  <div className="p-3 bg-white border-t border-gray-100 shrink-0">
                    <div className="flex items-center justify-center gap-4">
                      <button
                        onClick={toggleMute}
                        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                          isMuted
                            ? 'bg-red-100 text-red-600 hover:bg-red-200'
                            : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
                        }`}
                        title={isMuted ? 'Unmute' : 'Mute'}
                      >
                        {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                      </button>

                      {status === 'listening' && !isMuted && (
                        <div className="flex items-center gap-1">
                          {[...Array(5)].map((_, i) => (
                            <div
                              key={i}
                              className="w-1 bg-blue-500 rounded-full animate-pulse"
                              style={{
                                height: `${12 + Math.random() * 16}px`,
                                animationDelay: `${i * 100}ms`,
                                animationDuration: '0.5s'
                              }}
                            />
                          ))}
                        </div>
                      )}

                      {status === 'speaking' && (
                        <div className="flex items-center gap-1">
                          {[...Array(5)].map((_, i) => (
                            <div
                              key={i}
                              className="w-1 bg-orange-500 rounded-full animate-pulse"
                              style={{
                                height: `${12 + Math.random() * 16}px`,
                                animationDelay: `${i * 80}ms`,
                                animationDuration: '0.4s'
                              }}
                            />
                          ))}
                        </div>
                      )}

                      <button
                        onClick={handleEndConversation}
                        className="w-12 h-12 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors shadow-lg shadow-red-200"
                        title="End conversation"
                      >
                        <PhoneOff className="w-5 h-5" />
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-400 text-center mt-2">Powered by VaaniAI</p>
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