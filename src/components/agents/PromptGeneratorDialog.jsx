import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/api/apiClient';
import { toast } from 'sonner';
import { Loader2, Sparkles, Check, Globe, BookOpen, Mic } from 'lucide-react';
import { INDIAN_LANGUAGES, AGENT_ROLES, TONE_OPTIONS } from './IndianLanguages';

// Multi-language + Voice Mirroring + Website scraping + KB grounding.
export default function PromptGeneratorDialog({
  open, onOpenChange, onApply,
  defaultLanguage = 'en-IN', defaultTone = 'friendly', voiceEngine = 'realtime',
  clientId = null
}) {
  const [form, setForm] = useState({
    business_name: '',
    industry: '',
    agent_role: 'sales_outbound',
    goal: '',
    languages: [defaultLanguage],
    primary_language: defaultLanguage,
    voice_mirroring: false,
    tone: defaultTone,
    business_description: '',
    website_url: '',
    knowledge_base_ids: []
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [knowledgeBases, setKnowledgeBases] = useState([]);

  useEffect(() => {
    if (open && clientId) {
      apiClient.KnowledgeBase.filter({ client_id: clientId })
        .then(kbs => setKnowledgeBases(Array.isArray(kbs) ? kbs.filter(k => k.status === 'ready') : []))
        .catch(() => setKnowledgeBases([]));
    }
  }, [open, clientId]);

  const update = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const toggleLanguage = (code) => {
    setForm(p => {
      const has = p.languages.includes(code);
      let next = has ? p.languages.filter(l => l !== code) : [...p.languages, code];
      if (next.length === 0) next = [code]; // never empty
      // Auto-disable mirroring when only 1 language
      const mirroring = next.length > 1 ? p.voice_mirroring : false;
      // Ensure primary is in the list
      const primary = next.includes(p.primary_language) ? p.primary_language : next[0];
      return { ...p, languages: next, voice_mirroring: mirroring, primary_language: primary };
    });
  };

  const toggleKB = (id) => {
    setForm(p => ({
      ...p,
      knowledge_base_ids: p.knowledge_base_ids.includes(id)
        ? p.knowledge_base_ids.filter(x => x !== id)
        : [...p.knowledge_base_ids, id]
    }));
  };

  const handleGenerate = async () => {
    if (!form.business_name.trim() || !form.industry.trim() || !form.goal.trim()) {
      toast.error('Business name, industry and call goal are required');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await apiClient.functions.invoke('generatePromptAndPersona', { ...form, voice_engine: voiceEngine });
      const data = res?.data;
      if (!data?.success) {
        toast.error(data?.error || 'Generation failed');
      } else {
        setResult(data);
        const groundingNote = [];
        if (data.grounding_used?.website_chars) groundingNote.push(`website ${data.grounding_used.website_chars} chars`);
        if (data.grounding_used?.kb_chars) groundingNote.push(`KB ${data.grounding_used.kb_chars} chars`);
        toast.success(`Generated (${data.char_count}/${data.max_chars} chars)${groundingNote.length ? ' · ' + groundingNote.join(', ') : ''}`);
      }
    } catch (e) {
      toast.error('Failed to generate prompt');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (!result) return;
    const primaryEntry = INDIAN_LANGUAGES.find(l => l.value === result.primary_language) || INDIAN_LANGUAGES[0];
    const recommendedVoice = voiceEngine === 'realtime' ? primaryEntry.realtime_voice : primaryEntry.azure_voice;
    onApply({
      system_prompt: result.system_prompt,
      greeting_message: result.greeting_message,
      language: result.primary_language,
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
            Provide business info, choose languages, optionally add a website + knowledge base — we'll generate a production-ready ≤10000-char prompt with anti-hallucination, noise handling, voice stability and language rules baked in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Basics */}
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
            <Label>Call Goal *</Label>
            <Textarea value={form.goal} onChange={e => update('goal', e.target.value)} placeholder="e.g. Qualify leads for our quarterly subscription, book a free demo if interested" className="mt-1 h-20" />
          </div>

          <div>
            <Label>Business Description (optional)</Label>
            <Textarea value={form.business_description} onChange={e => update('business_description', e.target.value)} placeholder="Short description of what the business does, products, USP" className="mt-1 h-16" />
          </div>

          {/* Languages — multi-select */}
          <div className="border rounded-lg p-3 bg-cyan-50/30">
            <div className="flex items-center gap-2 mb-2">
              <Mic className="w-4 h-4 text-[#0097a7]" />
              <Label className="font-semibold">Languages Agent Can Speak *</Label>
              <Badge variant="outline" className="ml-auto">{form.languages.length} selected</Badge>
            </div>
            <p className="text-xs text-gray-500 mb-2">Pick one or more. English uses Indian accent. Regional languages use native Indian neural voices where available.</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-2">
              {INDIAN_LANGUAGES.map(l => (
                <label key={l.value} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-white rounded px-2 py-1">
                  <Checkbox checked={form.languages.includes(l.value)} onCheckedChange={() => toggleLanguage(l.value)} />
                  <span>{l.label}</span>
                </label>
              ))}
            </div>

            {form.languages.length > 1 && (
              <div className="mt-3 space-y-3 pt-3 border-t border-cyan-200">
                <div>
                  <Label className="text-xs">Primary (greeting) language</Label>
                  <Select value={form.primary_language} onValueChange={v => update('primary_language', v)}>
                    <SelectTrigger className="mt-1 bg-white"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {form.languages.map(code => {
                        const l = INDIAN_LANGUAGES.find(x => x.value === code);
                        return <SelectItem key={code} value={code}>{l?.label || code}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-start gap-3 bg-white border rounded p-2">
                  <Switch checked={form.voice_mirroring} onCheckedChange={v => update('voice_mirroring', v)} className="mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">Customer Voice Mirroring</p>
                    <p className="text-xs text-gray-500">After the caller's first response, the agent automatically mirrors their language for the rest of the call (within the allowed list above).</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Website + KB grounding */}
          <div className="border rounded-lg p-3 bg-gray-50">
            <div className="flex items-center gap-2 mb-2">
              <Globe className="w-4 h-4 text-[#0097a7]" />
              <Label className="font-semibold">Grounding (Optional) — for highly accurate prompts</Label>
            </div>
            <p className="text-xs text-gray-500 mb-3">We'll read the website (home + /about + /contact) and selected KB docs and use them as facts when writing the prompt.</p>

            <div className="space-y-3">
              <div>
                <Label className="text-xs">Website URL</Label>
                <Input
                  value={form.website_url}
                  onChange={e => update('website_url', e.target.value)}
                  placeholder="https://www.yourbusiness.com"
                  className="mt-1 bg-white"
                />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1">
                  <BookOpen className="w-3.5 h-3.5 text-gray-500" />
                  <Label className="text-xs">Knowledge Base Documents</Label>
                  {form.knowledge_base_ids.length > 0 && <Badge variant="outline" className="ml-auto text-xs">{form.knowledge_base_ids.length} selected</Badge>}
                </div>
                {knowledgeBases.length === 0 ? (
                  <p className="text-xs text-gray-500 bg-white border rounded p-2">
                    {clientId ? 'No ready KB documents found. Upload some in Knowledge Base section first.' : 'KB selection requires client context.'}
                  </p>
                ) : (
                  <div className="space-y-1 max-h-32 overflow-y-auto bg-white border rounded p-2">
                    {knowledgeBases.map(kb => (
                      <label key={kb.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
                        <Checkbox checked={form.knowledge_base_ids.includes(kb.id)} onCheckedChange={() => toggleKB(kb.id)} />
                        <span className="flex-1 truncate">{kb.title}</span>
                        <span className="text-xs text-gray-500">{kb.category || kb.file_type?.toUpperCase()}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Result */}
          {result && (
            <div className="border rounded-lg p-3 bg-cyan-50/40 space-y-3">
              <div>
                <Label className="text-xs font-semibold text-[#0097a7]">GENERATED GREETING</Label>
                <p className="text-sm bg-white border rounded p-2 mt-1">{result.greeting_message}</p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-xs font-semibold text-[#0097a7]">GENERATED SYSTEM PROMPT</Label>
                  <span className="text-xs text-gray-500">{result.char_count} / {result.max_chars} chars</span>
                </div>
                <Textarea readOnly value={result.system_prompt} className="h-56 font-mono text-xs bg-white" />
              </div>
              <div className="text-xs text-gray-600 space-y-0.5">
                <p><Check className="w-3 h-3 inline mr-1 text-green-600" /> Anti-hallucination + KB-search · Noise handling · Voice-tone lock · Human-like style</p>
                <p><Check className="w-3 h-3 inline mr-1 text-green-600" /> Languages: {result.languages.map(c => INDIAN_LANGUAGES.find(l => l.value === c)?.label || c).join(', ')} {result.voice_mirroring && <span className="font-medium">· Voice Mirroring ON</span>}</p>
                {(result.grounding_used?.website_chars > 0 || result.grounding_used?.kb_chars > 0) && (
                  <p><Check className="w-3 h-3 inline mr-1 text-green-600" /> Grounded with {result.grounding_used.website_chars > 0 ? `website (${result.grounding_used.website_chars} chars)` : ''}{result.grounding_used.website_chars > 0 && result.grounding_used.kb_chars > 0 ? ' + ' : ''}{result.grounding_used.kb_chars > 0 ? `${result.grounding_used.kb_docs} KB doc(s) (${result.grounding_used.kb_chars} chars)` : ''}</p>
                )}
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