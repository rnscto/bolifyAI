import React, { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/api/apiClient';
import { ChevronDown, ChevronUp, Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const SCRIPT_SECTIONS = [
  {
    key: 'opening',
    label: 'Opening / Greeting',
    placeholder: 'e.g. "Hello [Lead Name], this is [Agent Name] from [Company]. I\'m calling because..."',
    color: 'border-l-blue-500',
    hint: 'First impression — introduce yourself and state the reason for calling.'
  },
  {
    key: 'pitch',
    label: 'Main Pitch / Value Proposition',
    placeholder: 'e.g. "We help businesses like yours reduce costs by 40% through our AI-powered solution..."',
    color: 'border-l-green-500',
    hint: 'Present your product/service benefits clearly and concisely.'
  },
  {
    key: 'objection_handling',
    label: 'Objection Handling',
    placeholder: 'e.g.\n"Too expensive" → "I understand budget is a concern. Our ROI typically covers the cost within 2 months..."\n"Not interested" → "I appreciate your time. May I ask what solution you currently use for..."\n"Send me an email" → "Absolutely, I\'ll send that right over. Just to make sure I include the right info..."',
    color: 'border-l-yellow-500',
    hint: 'List common objections and how the agent should respond.'
  },
  {
    key: 'closing',
    label: 'Closing / Call-to-Action',
    placeholder: 'e.g. "Based on what we discussed, I\'d love to schedule a quick demo. Would Tuesday or Thursday work better for you?"',
    color: 'border-l-purple-500',
    hint: 'Wrap up the call with a clear next step or ask.'
  },
];

export default function CallScriptEditor({ script, onChange, agentName, campaignType }) {
  const [expanded, setExpanded] = useState(true);
  const [generating, setGenerating] = useState(false);

  const handleChange = (key, value) => {
    onChange({ ...script, [key]: value });
  };

  const handleAIGenerate = async () => {
    setGenerating(true);
    try {
      const result = await apiClient.integrations.Core.InvokeLLM({
        prompt: `Generate a professional cold calling script for a ${campaignType === 'followup' ? 'follow-up' : 'cold call'} campaign.
${agentName ? `Agent name: ${agentName}` : ''}

Generate a structured call script with these 4 sections. Be specific, natural-sounding, and persuasive. Use [Lead Name] as placeholder for the lead's name and [Company] for the company.

Return JSON with keys: opening, pitch, objection_handling, closing. Each should be a detailed script text (2-4 paragraphs each). For objection_handling, list at least 3 common objections with responses.`,
        response_json_schema: {
          type: "object",
          properties: {
            opening: { type: "string" },
            pitch: { type: "string" },
            objection_handling: { type: "string" },
            closing: { type: "string" }
          }
        }
      });
      onChange(result);
      toast.success('AI script generated! Review and customize as needed.');
    } catch (err) {
      toast.error('Failed to generate script');
      console.error(err);
    } finally {
      setGenerating(false);
    }
  };

  const hasContent = script && Object.values(script).some(v => v && v.trim());

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm text-gray-700">📋 Call Script</span>
          {hasContent && (
            <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Configured</span>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
      </button>

      {expanded && (
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">Define what the AI agent should say during calls. Leave empty to use the agent's default prompt.</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleAIGenerate}
              disabled={generating}
              className="text-xs gap-1.5"
            >
              {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-amber-500" />}
              {generating ? 'Generating...' : 'AI Generate Script'}
            </Button>
          </div>

          {SCRIPT_SECTIONS.map(section => (
            <div key={section.key} className={`border-l-4 ${section.color} pl-3 space-y-1`}>
              <Label className="text-sm font-medium">{section.label}</Label>
              <p className="text-[11px] text-gray-400">{section.hint}</p>
              <Textarea
                value={script?.[section.key] || ''}
                onChange={(e) => handleChange(section.key, e.target.value)}
                placeholder={section.placeholder}
                className="min-h-[80px] text-sm"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}