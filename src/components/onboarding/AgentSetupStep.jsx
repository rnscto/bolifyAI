import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Bot, ArrowRight, ArrowLeft, Sparkles, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const toneOptions = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly & Warm' },
  { value: 'formal', label: 'Formal' },
  { value: 'energetic', label: 'Energetic & Enthusiastic' },
  { value: 'empathetic', label: 'Empathetic & Caring' },
];

const languageOptions = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'bilingual', label: 'Bilingual (English + Hindi)' },
];

export default function AgentSetupStep({ data, onChange, onNext, onBack, industry }) {
  const [generating, setGenerating] = useState(false);

  const generatePrompt = async () => {
    setGenerating(true);
    const res = await base44.integrations.Core.InvokeLLM({
      prompt: `Generate a concise AI voice agent system prompt for a ${industry} business named "${data.name || 'the company'}".
The agent should:
- Greet callers warmly
- Qualify leads by asking about their needs
- Answer common ${industry} questions
- Book follow-ups or demos when interested
- Handle objections politely
- Be ${data.tone || 'professional'} in tone

Keep it under 300 words. Return just the prompt text, no extra formatting.`,
    });
    onChange({ ...data, system_prompt: res });
    setGenerating(false);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onNext();
  };

  return (
    <div className="max-w-lg mx-auto">
      <div className="text-center mb-8">
        <div className="w-16 h-16 bg-purple-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Bot className="w-8 h-8 text-purple-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Configure Your AI Agent</h2>
        <p className="text-gray-500 mt-2">Set up your voice AI agent's personality and behavior</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <Label htmlFor="agent_name">Agent Name *</Label>
          <Input
            id="agent_name"
            value={data.name}
            onChange={(e) => onChange({ ...data, name: e.target.value })}
            placeholder="e.g., Sarah, Priya, Alex"
            required
            className="mt-1"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Tone</Label>
            <Select value={data.tone} onValueChange={(v) => onChange({ ...data, tone: v })}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select tone" />
              </SelectTrigger>
              <SelectContent>
                {toneOptions.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Language</Label>
            <Select value={data.language} onValueChange={(v) => onChange({ ...data, language: v })}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent>
                {languageOptions.map((l) => (
                  <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <Label htmlFor="system_prompt">System Prompt</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={generatePrompt}
              disabled={generating}
              className="text-purple-600 hover:text-purple-700"
            >
              {generating ? (
                <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Generating...</>
              ) : (
                <><Sparkles className="w-3 h-3 mr-1" /> Auto-Generate</>
              )}
            </Button>
          </div>
          <Textarea
            id="system_prompt"
            value={data.system_prompt}
            onChange={(e) => onChange({ ...data, system_prompt: e.target.value })}
            placeholder="Describe how your AI agent should behave, what it should say, and how it should handle calls..."
            className="mt-1 min-h-[160px]"
          />
        </div>

        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={onBack} className="flex-1 h-12">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
          <Button type="submit" className="flex-1 bg-blue-600 hover:bg-blue-700 h-12 text-base">
            Continue <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </form>
    </div>
  );
}