import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, X, Phone, PhoneOff, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { base44 } from '@/api/base44Client';
import LeadCaptureForm from './LeadCaptureForm';

const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png";

export default function VoiceAgentPopup() {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState('idle'); // idle, listening, processing, speaking, ended
  const [messages, setMessages] = useState([]);
  const [textInput, setTextInput] = useState('');
  const [showPulse, setShowPulse] = useState(true);
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const messagesEndRef = useRef(null);
  const recognitionRef = useRef(null);
  const synthRef = useRef(window.speechSynthesis);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Initialize speech recognition
  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      addMessage('system', 'Speech recognition not supported in this browser. Please type your message.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      setIsRecording(true);
      setStatus('listening');
    };

    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript;
      if (text.trim()) {
        handleUserMessage(text.trim());
      }
    };

    recognition.onerror = (event) => {
      console.log('Speech recognition error:', event.error);
      setIsRecording(false);
      setStatus('idle');
      if (event.error === 'not-allowed') {
        addMessage('system', 'Microphone access denied. Please type your message instead.');
      }
    };

    recognition.onend = () => {
      setIsRecording(false);
      if (status === 'listening') setStatus('idle');
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
    setStatus('idle');
  };

  const speakText = (text) => {
    if (!synthRef.current) return;
    synthRef.current.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-IN';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Try to find an Indian English voice
    const voices = synthRef.current.getVoices();
    const indianVoice = voices.find(v => v.lang === 'en-IN') || voices.find(v => v.lang.startsWith('en'));
    if (indianVoice) utterance.voice = indianVoice;

    utterance.onstart = () => setStatus('speaking');
    utterance.onend = () => setStatus('idle');

    synthRef.current.speak(utterance);
  };

  const addMessage = (role, text) => {
    setMessages(prev => [...prev, { role, text }]);
  };

  const handleUserMessage = async (text) => {
    addMessage('user', text);
    setStatus('processing');

    const updatedMessages = [...messages, { role: 'user', text }];

    try {
      const response = await base44.functions.invoke('webVoiceAgent', {
        action: 'chat',
        messages: updatedMessages.filter(m => m.role === 'user' || m.role === 'ai')
      });

      const reply = response.data.reply;
      addMessage('ai', reply);
      speakText(reply);
    } catch (err) {
      console.error('Chat error:', err);
      const fallback = "I'm having trouble connecting. Please try again or type your question.";
      addMessage('ai', fallback);
      setStatus('idle');
    }
  };

  const handleTextSubmit = (e) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    handleUserMessage(textInput.trim());
    setTextInput('');
  };

  const handleStartConversation = () => {
    setShowPulse(false);
    setMessages([]);
    setShowLeadForm(false);
    const greeting = "Hi! I'm VaaniAI's assistant. I can help you learn about our AI voice agent platform, pricing, and features. What would you like to know?";
    addMessage('ai', greeting);
    speakText(greeting);
  };

  const handleEndConversation = () => {
    synthRef.current?.cancel();
    stopListening();
    setStatus('ended');
    setShowLeadForm(true);
  };

  const handleClose = () => {
    synthRef.current?.cancel();
    stopListening();
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

  const statusText = {
    idle: 'Ready',
    listening: '🎙️ Listening...',
    processing: 'Thinking...',
    speaking: '🔊 Speaking...',
    ended: 'Conversation ended'
  };

  const statusColor = {
    idle: 'bg-green-500',
    listening: 'bg-blue-500',
    processing: 'bg-purple-500',
    speaking: 'bg-orange-500',
    ended: 'bg-gray-400'
  };

  const hasStarted = messages.length > 0;

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
                        Ask about our AI voice agents, pricing, features, or how to get started!
                      </p>
                      <Button
                        onClick={handleStartConversation}
                        className="mt-4 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white rounded-full px-6 gap-2 shadow-lg shadow-green-200"
                      >
                        <Phone className="w-4 h-4" />
                        Start Conversation
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
                  <div ref={messagesEndRef} />
                </div>

                {/* Input controls */}
                {hasStarted && (
                  <div className="p-3 bg-white border-t border-gray-100 shrink-0 space-y-2">
                    <form onSubmit={handleTextSubmit} className="flex gap-2">
                      <Input
                        value={textInput}
                        onChange={(e) => setTextInput(e.target.value)}
                        placeholder="Type or tap mic to speak..."
                        className="flex-1 h-9 text-sm"
                        disabled={status === 'processing'}
                      />
                      <button
                        type="button"
                        onClick={isRecording ? stopListening : startListening}
                        disabled={status === 'processing'}
                        className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                          isRecording
                            ? 'bg-red-500 text-white animate-pulse'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      </button>
                      <Button
                        type="submit"
                        size="icon"
                        disabled={!textInput.trim() || status === 'processing'}
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