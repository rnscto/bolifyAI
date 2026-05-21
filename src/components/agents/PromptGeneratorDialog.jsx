import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { Loader2, Sparkles, Check } from 'lucide-react';
import { INDIAN_LANGUAGES, AGENT_ROLES, TONE_OPTIONS } from './IndianLanguages';

// Generates a tight, production-ready system prompt + greeting + persona
// using the generatePromptAndPersona backend function. The result is passed
// back to the parent (AgentEditDialog) via onApply.
export default function PromptGeneratorDialog({ open, onOpenChange, onApply, defaultLanguage = 'en-IN', defaultTone = 'friendly', voiceEngine = 'realtime' }) {
  const [form, setForm] = useState({
    business_name: '',
    industry: '',
    agent_role: 'sales_outbound',
    goal: '',
    language: defaultLanguage,
    tone: defaultTone,
    business_description: ''
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const update = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleGenerate = async () => {
    if (!form.business_name.trim() || !form.industry.trim() || !form.goal.trim()) {
      toast.error('Business name, industry and call goal are required');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('generatePromptAndPersona', { ...form, voice_engine: voiceEngine });
      const data = res?.data;
      if (!data?.success) {
        toast.error(data?.error || 'Generation failed');
      } else {
        setResult(data);
        toast.success(`Generated (${data.char_count}/${data.max_chars} chars)`);
      }
    } catch (e) {
      toast.error('Failed to generate prompt');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (!result) return;
    const langEntry = INDIAN_LANGUAGES.find(l => l.value === form.language) || INDIAN_LANGUAGES[0];
    const recommendedVoice = voiceEngine === 'realtime' ? langEntry.realtime_voice : langEntry.azure_voice;
    onApply({
      system_prompt: result.system_prompt,
      greeting_message: result.greeting_message,
      language: form.language,
      tone: result.recommended_tone || form.tone,
      voice_type: recommendedVoice
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[#0097a7]" />
            Generate System Prompt & Persona
          </DialogTitle>
          <DialogDescription>
            Tell us about the business — we'll generate a production-ready prompt with anti-hallucination, noise-handling, voice-lock and language rules baked in (max 5000 chars).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Business Name *</Label>
              <Input value={form.business_name} onChange={e => update('business_name', e.target.value)} placeholder="e.g. Bolify Diagnostics" className="mt-1" />
            </div>
            <div>
              <Label>Industry *</Label>
              <Input value={form.industry} onChange={e => update('industry', e.target.value)} placeholder="e.g. Healthcare, Real Estate" className="mt-1" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Agent Role</Label>
              <Select value={form.agent_role} onValueChange={v => update('agent_role', v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGENT_ROLES.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tone</Label>
              <Select value={form.tone} onValueChange={v => update('tone', v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TONE_OPTIONS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Language (Indian) *</Label>
            <Select value={form.language} onValueChange={v => update('language', v)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {INDIAN_LANGUAGES.map(l => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label} <span className="text-xs text-gray-500 ml-2">{l.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500 mt-1">English uses Indian accent. Regional languages use native Indian neural voices where available.</p>
          </div>

          <div>
            <Label>Call Goal *</Label>
            <Textarea value={form.goal} onChange={e => update('goal', e.target.value)} placeholder="e.g. Qualify leads for our quarterly subscription, book a free demo if interested" className="mt-1 h-20" />
          </div>

          <div>
            <Label>Business Description (optional)</Label>
            <Textarea value={form.business_description} onChange={e => update('business_description', e.target.value)} placeholder="Short description of what the business does, products, USP" className="mt-1 h-20" />
          </div>

          {result && (
            <div className="border rounded-lg p-3 bg-cyan-50/40 space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-xs font-semibold text-[#0097a7]">GENERATED GREETING</Label>
                </div>
                <p className="text-sm bg-white border rounded p-2">{result.greeting_message}</p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-xs font-semibold text-[#0097a7]">GENERATED SYSTEM PROMPT</Label>
                  <span className="text-xs text-gray-500">{result.char_count} / {result.max_chars} chars</span>
                </div>
                <Textarea readOnly value={result.system_prompt} className="h-56 font-mono text-xs bg-white" />
              </div>
              <div className="text-xs text-gray-600">
                <Check className="w-3 h-3 inline mr-1 text-green-600" /> Includes: no-hallucination + KB-search rules,
                background-noise handling, voice/tone lock, language lock ({INDIAN_LANGUAGES.find(l => l.value === form.language)?.label}), and human-like conversation style.
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="outline" onClick={handleGenerate} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            {result ? 'Regenerate' : 'Generate'}
          </Button>
          <Button onClick={handleApply} disabled={!result} className="bg-[#0097a7] hover:bg-[#00838f]">
            <Check className="w-4 h-4 mr-2" /> Apply to Agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}