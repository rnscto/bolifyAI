import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { Loader2, Save } from 'lucide-react';
import { REALTIME_VOICES, AZURE_SPEECH_VOICES } from './VoiceData';

const TONE_OPTIONS = ['professional', 'friendly', 'formal', 'energetic', 'empathetic'];
const LANGUAGE_OPTIONS = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'bilingual', label: 'Bilingual (Hindi + English)' },
];

export default function AgentEditDialog({ agent, open, onOpenChange, onSaved }) {
  const [form, setForm] = useState({
    name: '',
    industry: '',
    greeting_message: '',
    system_prompt: '',
    persona: { voice_engine: 'realtime', voice_type: 'alloy', tone: 'friendly', language: 'en-IN' }
  });
  const [saving, setSaving] = useState(false);

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
    }
  }, [agent, open]);

  const updatePersona = (key, value) => {
    setForm(prev => ({
      ...prev,
      persona: { ...prev.persona, [key]: value }
    }));
  };

  const voices = form.persona.voice_engine === 'realtime' ? REALTIME_VOICES : AZURE_SPEECH_VOICES;

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Agent name is required');
      return;
    }
    setSaving(true);
    await base44.entities.Agent.update(agent.id, {
      name: form.name.trim(),
      industry: form.industry.trim(),
      greeting_message: form.greeting_message.trim(),
      system_prompt: form.system_prompt.trim(),
      persona: form.persona,
    });
    toast.success('Agent updated');
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
                updatePersona('voice_type', v === 'realtime' ? 'alloy' : 'en-IN-NeerjaNeural');
              }}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="realtime">Realtime (GPT-4o built-in)</SelectItem>
                  <SelectItem value="azure_speech">Azure Speech (400+ voices)</SelectItem>
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

          {/* System Prompt */}
          <div>
            <Label>System Prompt / Instructions</Label>
            <Textarea
              value={form.system_prompt}
              onChange={e => setForm(p => ({ ...p, system_prompt: e.target.value }))}
              placeholder="Instructions for the AI agent..."
              className="mt-1 h-48 font-mono text-xs"
            />
            <p className="text-xs text-gray-500 mt-1">Controls the agent's behavior, personality, and knowledge during calls.</p>
          </div>
        </div>

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