import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { Loader2, Save, BookOpen, CheckCircle2, AlertCircle } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { REALTIME_VOICES, AZURE_SPEECH_VOICES, GEMINI_VOICES } from './VoiceData';
import { INDIAN_LANGUAGES } from './IndianLanguages';
import PromptGeneratorDialog from './PromptGeneratorDialog';
import { Sparkles } from 'lucide-react';

const TONE_OPTIONS = ['professional', 'friendly', 'formal', 'energetic', 'empathetic'];
const LANGUAGE_OPTIONS = INDIAN_LANGUAGES.map(l => ({ value: l.value, label: l.label }));

export default function AgentEditDialog({ agent, open, onOpenChange, onSaved, clientId }) {
  const [form, setForm] = useState({
    name: '',
    industry: '',
    greeting_message: '',
    system_prompt: '',
    persona: { voice_engine: 'realtime', voice_type: 'alloy', tone: 'friendly', language: 'en-IN' }
  });
  const [saving, setSaving] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [knowledgeBases, setKnowledgeBases] = useState([]);
  const [selectedKBs, setSelectedKBs] = useState([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    base44.auth.me().then(u => setIsAdmin(u?.role === 'admin')).catch(() => setIsAdmin(false));
  }, []);

  const handleApplyGenerated = ({ system_prompt, greeting_message, language, tone, voice_type }) => {
    setForm(p => ({
      ...p,
      system_prompt: system_prompt || p.system_prompt,
      greeting_message: greeting_message || p.greeting_message,
      persona: {
        ...p.persona,
        language: language || p.persona.language,
        tone: tone || p.persona.tone,
        voice_type: voice_type || p.persona.voice_type
      }
    }));
    toast.success('Prompt & persona applied — click Save to keep changes');
  };

  useEffect(() => {
    if (agent && open) {
      setForm({
        name: agent.name || '',
        industry: agent.industry || '',
        greeting_message: agent.greeting_message || '',
        system_prompt: agent.system_prompt || '',
        persona: {
          voice_engine: agent.persona?.voice_engine || 'realtime',
          voice_type: agent.persona?.voice_type || 'alloy',
          tone: agent.persona?.tone || 'friendly',
          language: agent.persona?.language || 'en-IN',
        }
      });
      setSelectedKBs(agent.knowledge_base_ids || []);
      // Load available KB documents for this client
      const cid = clientId || agent.client_id;
      if (cid) {
        setKbLoading(true);
        base44.entities.KnowledgeBase.filter({ client_id: cid })
          .then(docs => setKnowledgeBases(docs || []))
          .catch(() => setKnowledgeBases([]))
          .finally(() => setKbLoading(false));
      }
      // Auto-heal: if agent has KB IDs but no kb_file_uri (stale state), trigger upload silently
      if ((agent.knowledge_base_ids?.length || 0) > 0 && !agent.kb_file_uri) {
        base44.functions.invoke('uploadKBToStorage', { agent_id: agent.id }).catch(() => {});
      }
    }
  }, [agent, open, clientId]);

  const toggleKB = (kbId) => {
    setSelectedKBs(prev => prev.includes(kbId) ? prev.filter(id => id !== kbId) : [...prev, kbId]);
  };

  const updatePersona = (key, value) => {
    setForm(prev => ({
      ...prev,
      persona: { ...prev.persona, [key]: value }
    }));
  };

  const voices = form.persona.voice_engine === 'realtime' ? REALTIME_VOICES : (form.persona.voice_engine === 'gemini_realtime' ? GEMINI_VOICES : AZURE_SPEECH_VOICES);

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Agent name is required');
      return;
    }
    setSaving(true);
    const prevKBs = agent.knowledge_base_ids || [];
    const kbChanged = JSON.stringify([...prevKBs].sort()) !== JSON.stringify([...selectedKBs].sort());
    await base44.entities.Agent.update(agent.id, {
      name: form.name.trim(),
      industry: form.industry.trim(),
      greeting_message: form.greeting_message.trim(),
      system_prompt: form.system_prompt.trim(),
      persona: form.persona,
      knowledge_base_ids: selectedKBs,
    });
    // Rebuild combined KB blob in Azure if KB selection changed (fire-and-forget)
    if (kbChanged) {
      base44.functions.invoke('uploadKBToStorage', { agent_id: agent.id }).catch(() => {});
      toast.success('Agent updated — Knowledge Base is syncing in the background');
    } else {
      toast.success('Agent updated');
    }
    setSaving(false);
    onOpenChange(false);
    onSaved?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Agent</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Name & Industry */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Agent Name</Label>
              <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label>Industry</Label>
              <Input value={form.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))} placeholder="e.g. Real Estate, Healthcare" className="mt-1" />
            </div>
          </div>

          {/* Voice Engine */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Voice Engine</Label>
              <Select value={form.persona.voice_engine} onValueChange={v => {
                updatePersona('voice_engine', v);
                updatePersona('voice_type', v === 'realtime' ? 'alloy' : (v === 'gemini_realtime' ? 'Aoede' : 'en-IN-NeerjaNeural'));
              }}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="realtime">Realtime (GPT-4o built-in)</SelectItem>
                  <SelectItem value="azure_speech">Azure Speech (400+ voices)</SelectItem>
                  {isAdmin && (
                    <SelectItem value="gemini_realtime">Gemini Realtime (Gemini 2.0 Flash Lite)</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Voice</Label>
              <Select value={form.persona.voice_type} onValueChange={v => updatePersona('voice_type', v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {voices.map(v => (
                    <SelectItem key={v.name} value={v.name}>
                      {v.name} — {v.gender}, {v.style}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tone & Language */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Tone</Label>
              <Select value={form.persona.tone} onValueChange={v => updatePersona('tone', v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TONE_OPTIONS.map(t => (
                    <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Language</Label>
              <Select value={form.persona.language} onValueChange={v => updatePersona('language', v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map(l => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Greeting Message */}
          <div>
            <Label>Greeting Message</Label>
            <Textarea
              value={form.greeting_message}
              onChange={e => setForm(p => ({ ...p, greeting_message: e.target.value }))}
              placeholder="Custom greeting spoken when call connects (leave blank for AI-generated)"
              className="mt-1 h-20"
            />
            <p className="text-xs text-gray-500 mt-1">The first thing the AI says when a call connects.</p>
          </div>

          {/* Knowledge Base linking */}
          <div className="border rounded-lg p-4 bg-cyan-50/30 border-cyan-100">
            <div className="flex items-center justify-between mb-2">
              <Label className="flex items-center gap-2 text-sm font-semibold">
                <BookOpen className="w-4 h-4 text-[#0097a7]" />
                Link Knowledge Base
              </Label>
              {selectedKBs.length > 0 ? (
                <Badge className="bg-green-100 text-green-800 gap-1"><CheckCircle2 className="w-3 h-3" /> {selectedKBs.length} linked</Badge>
              ) : (
                <Badge className="bg-amber-100 text-amber-800 gap-1"><AlertCircle className="w-3 h-3" /> None linked</Badge>
              )}
            </div>
            <p className="text-xs text-gray-600 mb-3">
              Linked documents are searchable by the AI during live calls. Without a linked KB, the agent can only use its system prompt.
            </p>
            {kbLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading documents...</div>
            ) : knowledgeBases.length === 0 ? (
              <p className="text-xs text-gray-500 italic py-2">No documents uploaded yet. Add documents in the Knowledge Base section first.</p>
            ) : (
              <div className="space-y-1.5 max-h-44 overflow-y-auto">
                {knowledgeBases.map(kb => (
                  <label key={kb.id} className="flex items-center gap-3 p-2 rounded hover:bg-white cursor-pointer">
                    <Checkbox checked={selectedKBs.includes(kb.id)} onCheckedChange={() => toggleKB(kb.id)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{kb.title}</p>
                      <p className="text-xs text-gray-500">{kb.category || 'Uncategorized'} · {kb.file_type?.toUpperCase() || 'TXT'}</p>
                    </div>
                    <Badge variant="outline" className={`text-xs ${kb.status === 'ready' ? 'border-green-300 text-green-700' : 'border-yellow-300 text-yellow-700'}`}>
                      {kb.status}
                    </Badge>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* System Prompt */}
          <div>
            <div className="flex items-center justify-between">
              <Label>System Prompt / Instructions</Label>
              <Button type="button" variant="outline" size="sm" onClick={() => setGenOpen(true)} className="h-7 gap-1 text-[#0097a7] border-[#0097a7]/30 hover:bg-cyan-50">
                <Sparkles className="w-3.5 h-3.5" /> Generate with AI
              </Button>
            </div>
            <Textarea
              value={form.system_prompt}
              onChange={e => setForm(p => ({ ...p, system_prompt: e.target.value }))}
              placeholder="Instructions for the AI agent..."
              className="mt-1 h-48 font-mono text-xs"
              maxLength={10000}
            />
            <p className="text-xs text-gray-500 mt-1">
              {form.system_prompt.length} / 10000 chars · Controls the agent's behavior, anti-hallucination rules, language and voice stability.
            </p>
          </div>
        </div>

        <PromptGeneratorDialog
          open={genOpen}
          onOpenChange={setGenOpen}
          onApply={handleApplyGenerated}
          defaultLanguage={form.persona.language}
          defaultTone={form.persona.tone}
          voiceEngine={form.persona.voice_engine}
          clientId={clientId || agent?.client_id}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}