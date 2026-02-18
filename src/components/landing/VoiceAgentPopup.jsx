import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, X, Phone, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import LeadCaptureForm from './LeadCaptureForm';

const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png";

export default function VoiceAgentPopup() {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState('idle'); // idle, connecting, ready, listening, speaking, processing, error, ended
  const [transcript, setTranscript] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [showPulse, setShowPulse] = useState(true);
  const [showLeadForm, setShowLeadForm] = useState(false);

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const transcriptEndRef = useRef(null);
  const isMutedRef = useRef(false);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript]);

  const getWsUrl = useCallback(() => {
    const host = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${host}/functions/webVoiceAgent`;
  }, []);

  const playAudioChunk = useCallback((base64Data) => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;

    const raw = atob(base64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }

    const numSamples = Math.floor(bytes.length / 2);
    const view = new DataView(bytes.buffer);
    const audioBuffer = ctx.createBuffer(1, numSamples, 24000);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < numSamples; i++) {
      channelData[i] = view.getInt16(i * 2, true) / 32768;
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;
  }, []);

  const startCall = useCallback(async () => {
    setStatus('connecting');
    setTranscript([]);
    setShowPulse(false);
    setShowLeadForm(false);

    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    audioContextRef.current = ctx;
    nextPlayTimeRef.current = 0;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (err) {
      console.error('Microphone access denied:', err);
      setStatus('error');
      return;
    }
    streamRef.current = stream;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (isMutedRef.current) return;
        if (ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        ws.send(JSON.stringify({ type: 'audio', data: btoa(binary) }));
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      processorRef.current = processor;
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'ready') {
        setStatus('ready');
        setTranscript(prev => [...prev, { role: 'system', text: 'Connected! Start speaking...' }]);
      }
      if (msg.type === 'audio') {
        setStatus('speaking');
        playAudioChunk(msg.data);
      }
      if (msg.type === 'audio_done') setStatus('ready');
      if (msg.type === 'listening') setStatus('listening');
      if (msg.type === 'processing') setStatus('processing');
      if (msg.type === 'user_transcript') {
        setTranscript(prev => [...prev, { role: 'user', text: msg.text }]);
      }
      if (msg.type === 'ai_transcript') {
        setTranscript(prev => [...prev, { role: 'ai', text: msg.text }]);
      }
      if (msg.type === 'error') {
        setStatus('error');
        setTranscript(prev => [...prev, { role: 'system', text: msg.message }]);
      }
      if (msg.type === 'session_ended' || msg.type === 'conversation_complete') {
        setStatus('ended');
        setShowLeadForm(true);
      }
    };

    ws.onclose = () => {
      if (status !== 'idle' && status !== 'ended') {
        setStatus('ended');
        setShowLeadForm(true);
      }
    };

    ws.onerror = () => setStatus('error');
  }, [getWsUrl, playAudioChunk]);

  const endCall = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end' }));
      wsRef.current.close();
    }
    wsRef.current = null;

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setStatus('ended');
    setShowLeadForm(true);
  }, []);

  const handleClose = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end' }));
      wsRef.current.close();
    }
    wsRef.current = null;
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }

    setStatus('idle');
    setIsOpen(false);
    setTranscript([]);
    setShowPulse(true);
    setShowLeadForm(false);
  };

  const handleLeadSubmitted = () => {
    setShowLeadForm(false);
    setStatus('idle');
    setTranscript([]);
  };

  const handleLeadSkip = () => {
    setShowLeadForm(false);
    setStatus('idle');
    setTranscript([]);
  };

  const statusText = {
    idle: 'Tap to start a conversation',
    connecting: 'Connecting...',
    ready: 'Listening...',
    listening: '🎙️ Hearing you...',
    speaking: '🔊 Speaking...',
    processing: 'Thinking...',
    error: 'Connection error',
    ended: 'Conversation ended'
  };

  const statusColor = {
    idle: 'bg-gray-400',
    connecting: 'bg-yellow-400',
    ready: 'bg-green-500',
    listening: 'bg-blue-500',
    speaking: 'bg-orange-500',
    processing: 'bg-purple-500',
    error: 'bg-red-500',
    ended: 'bg-gray-400'
  };

  const isInCall = !['idle', 'ended', 'error'].includes(status);

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
                    <span className={`w-2 h-2 rounded-full ${statusColor[status]}`} />
                    <span className="text-white/70 text-[10px]">{statusText[status]}</span>
                  </div>
                </div>
              </div>
              <button onClick={handleClose} className="text-white/70 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Lead capture form (shown after call ends) */}
            {showLeadForm ? (
              <LeadCaptureForm
                conversationTranscript={transcript}
                onSubmitted={handleLeadSubmitted}
                onSkip={handleLeadSkip}
              />
            ) : (
              <>
                {/* Transcript area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px] max-h-[300px] bg-gray-50">
                  {transcript.length === 0 && status === 'idle' && (
                    <div className="text-center py-8">
                      <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-50 flex items-center justify-center">
                        <Mic className="w-8 h-8 text-blue-500" />
                      </div>
                      <p className="text-sm font-medium text-gray-800">Talk to VaaniAI</p>
                      <p className="text-xs text-gray-500 mt-1.5 max-w-[240px] mx-auto">
                        Ask me anything about our AI voice agent platform, pricing, features, or how to get started!
                      </p>
                    </div>
                  )}
                  {transcript.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${
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
                  <div ref={transcriptEndRef} />
                </div>

                {/* Controls */}
                <div className="p-4 bg-white border-t border-gray-100 shrink-0">
                  <div className="flex items-center justify-center gap-4">
                    {status === 'idle' ? (
                      <Button
                        onClick={startCall}
                        className="bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white rounded-full px-6 py-2.5 gap-2 shadow-lg shadow-green-200"
                      >
                        <Phone className="w-4 h-4" />
                        Start Conversation
                      </Button>
                    ) : isInCall ? (
                      <>
                        <button
                          onClick={() => setIsMuted(!isMuted)}
                          className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                            isMuted
                              ? 'bg-red-100 text-red-600 hover:bg-red-200'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                        </button>

                        <div className="relative w-16 h-16 flex items-center justify-center">
                          {(status === 'listening' || status === 'speaking') && (
                            <>
                              <span className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-20" />
                              <span className="absolute inset-1 rounded-full bg-blue-300 animate-pulse opacity-30" />
                            </>
                          )}
                          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                            status === 'listening' ? 'bg-blue-500' :
                            status === 'speaking' ? 'bg-orange-500' :
                            status === 'processing' ? 'bg-purple-500 animate-pulse' :
                            status === 'connecting' ? 'bg-yellow-500 animate-pulse' :
                            'bg-green-500'
                          }`}>
                            <Mic className="w-5 h-5 text-white" />
                          </div>
                        </div>

                        <button
                          onClick={endCall}
                          className="w-12 h-12 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors shadow-lg shadow-red-200"
                        >
                          <PhoneOff className="w-5 h-5" />
                        </button>
                      </>
                    ) : (
                      <Button
                        onClick={startCall}
                        className="bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white rounded-full px-6 py-2.5 gap-2 shadow-lg shadow-green-200"
                      >
                        <Phone className="w-4 h-4" />
                        New Conversation
                      </Button>
                    )}
                  </div>
                  {isInCall && (
                    <p className="text-center text-[10px] text-gray-400 mt-2">
                      {status === 'connecting' ? 'Setting up voice connection...' : 'Powered by VaaniAI'}
                    </p>
                  )}
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}