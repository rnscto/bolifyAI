import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { User, Mail, Phone, Briefcase, Loader2, CheckCircle2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const SOLUTIONS = [
  { value: 'ai_voice_agent', label: 'AI Voice Agent for Sales' },
  { value: 'lead_qualification', label: 'Automated Lead Qualification' },
  { value: 'appointment_booking', label: 'Appointment Booking Agent' },
  { value: 'customer_support', label: 'Customer Support Automation' },
  { value: 'campaign_calling', label: 'Bulk Campaign Calling' },
  { value: 'crm', label: 'Sales CRM' },
  { value: 'egovernance', label: 'e-Governance Solutions' },
  { value: 'other', label: 'Other / Custom Solution' },
];

export default function LeadCaptureForm({ conversationTranscript, onSubmitted, onSkip }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', solution: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name && !form.email && !form.phone) {
      onSkip?.();
      return;
    }
    setSubmitting(true);

    // Analyze conversation for intent/sentiment using LLM
    let intent = 'exploring';
    let sentiment = 'neutral';
    let summary = '';

    if (conversationTranscript && conversationTranscript.length > 0) {
      const transcriptText = conversationTranscript
        .map(t => `${t.role === 'user' ? 'Visitor' : t.role === 'ai' ? 'AI' : 'System'}: ${t.text}`)
        .join('\n');

      try {
        const analysis = await base44.integrations.Core.InvokeLLM({
          prompt: `Analyze this conversation between a website visitor and VaaniAI's voice assistant. Extract:
1. Intent: Is the visitor "exploring" (just learning), "comparing" (evaluating options), "ready_to_buy" (wants to purchase), or "curious" (casual interest)?
2. Sentiment: Is the visitor "positive", "neutral", "skeptical", or "negative"?
3. Summary: A 2-3 sentence summary of the conversation and visitor's needs.
4. Industry: What industry does the visitor seem to be from?

Conversation:
${transcriptText}`,
          response_json_schema: {
            type: 'object',
            properties: {
              intent: { type: 'string', enum: ['exploring', 'comparing', 'ready_to_buy', 'curious'] },
              sentiment: { type: 'string', enum: ['positive', 'neutral', 'skeptical', 'negative'] },
              summary: { type: 'string' },
              industry: { type: 'string' }
            }
          }
        });

        intent = analysis.intent || 'exploring';
        sentiment = analysis.sentiment || 'neutral';
        summary = analysis.summary || '';
        if (analysis.industry && !form.industry) {
          form.industry = analysis.industry;
        }
      } catch (err) {
        console.log('Analysis skipped:', err.message);
        summary = conversationTranscript.map(t => `${t.role}: ${t.text}`).join(' | ');
      }
    }

    // Submit lead via backend
    try {
      await base44.functions.invoke('webVoiceAgent', {
        action: 'create_lead',
        name: form.name,
        email: form.email,
        phone: form.phone,
        solution: SOLUTIONS.find(s => s.value === form.solution)?.label || form.solution,
        industry: form.industry || '',
        intent,
        sentiment,
        conversation_summary: summary
      });
      setSubmitted(true);
      setTimeout(() => onSubmitted?.(), 2000);
    } catch (err) {
      console.error('Lead submission error:', err);
      // Still close the form
      onSubmitted?.();
    }

    setSubmitting(false);
  };

  if (submitted) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="p-6 text-center"
      >
        <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
        <p className="font-semibold text-gray-800">Thank You!</p>
        <p className="text-sm text-gray-500 mt-1">Our team will reach out to you shortly.</p>
      </motion.div>
    );
  }

  return (
    <motion.form
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      onSubmit={handleSubmit}
      className="p-4 space-y-3"
    >
      <div className="text-center mb-2">
        <p className="text-sm font-semibold text-gray-800">Before you go...</p>
        <p className="text-xs text-gray-500">Share your details for a personalized follow-up</p>
      </div>

      <div className="relative">
        <User className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Your Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="pl-9 h-9 text-sm"
        />
      </div>

      <div className="relative">
        <Mail className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
        <Input
          type="email"
          placeholder="Email Address"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className="pl-9 h-9 text-sm"
        />
      </div>

      <div className="relative">
        <Phone className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Mobile Number"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          className="pl-9 h-9 text-sm"
        />
      </div>

      <Select value={form.solution} onValueChange={(v) => setForm({ ...form, solution: v })}>
        <SelectTrigger className="h-9 text-sm">
          <div className="flex items-center gap-2">
            <Briefcase className="w-4 h-4 text-gray-400" />
            <SelectValue placeholder="Solution you're looking for" />
          </div>
        </SelectTrigger>
        <SelectContent>
          {SOLUTIONS.map(s => (
            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          className="flex-1 text-xs h-9"
          onClick={onSkip}
        >
          Skip
        </Button>
        <Button
          type="submit"
          disabled={submitting}
          className="flex-1 bg-gradient-to-r from-[#e67e22] to-[#f39c12] hover:from-[#d35400] hover:to-[#e67e22] text-white text-xs h-9"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit & Get Demo'}
        </Button>
      </div>
    </motion.form>
  );
}