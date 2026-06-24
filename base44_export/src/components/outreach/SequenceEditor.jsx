import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, ArrowLeft, Save, GripVertical, Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const OUTREACH_TYPES = [
  { value: 'lead_followup', label: 'Lead Follow-up' },
  { value: 'retention', label: 'Retention' },
  { value: 're_engagement', label: 'Re-engagement' },
  { value: 'thank_you', label: 'Thank You' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'callback_reminder', label: 'Callback Reminder' }
];

const TIER_TARGETS = [
  { value: 'all', label: 'All Tiers' },
  { value: 'hot', label: '🔥 Hot Leads' },
  { value: 'warm', label: '🟡 Warm Leads' },
  { value: 'nurture', label: '🟢 Nurture Leads' },
  { value: 'cold', label: '❄️ Cold Leads' }
];

const DEFAULT_STEP = { step_number: 1, delay_days: 1, subject: '', body_html: '', use_ai_personalization: false };

export default function SequenceEditor({ sequence, onSave, onCancel }) {
  const isNew = !sequence;
  const [form, setForm] = useState({
    name: sequence?.name || '',
    outreach_type: sequence?.outreach_type || 'lead_followup',
    description: sequence?.description || '',
    status: sequence?.status || 'draft',
    tier_target: sequence?.tier_target || 'all',
    steps: sequence?.steps?.length > 0 ? sequence.steps : [{ ...DEFAULT_STEP }]
  });
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(null);

  const updateStep = (index, field, value) => {
    const steps = [...form.steps];
    steps[index] = { ...steps[index], [field]: value };
    setForm({ ...form, steps });
  };

  const addStep = () => {
    const lastStep = form.steps[form.steps.length - 1];
    setForm({
      ...form,
      steps: [...form.steps, {
        step_number: form.steps.length + 1,
        delay_days: (lastStep?.delay_days || 1) + 2,
        subject: '',
        body_html: '',
        use_ai_personalization: false
      }]
    });
  };

  const removeStep = (index) => {
    if (form.steps.length <= 1) return;
    const steps = form.steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, step_number: i + 1 }));
    setForm({ ...form, steps });
  };

  const handleGenerateWithAI = async (index) => {
    setGenerating(index);
    const step = form.steps[index];
    const stepNum = index + 1;
    const totalSteps = form.steps.length;

    const result = await base44.integrations.Core.InvokeLLM({
      prompt: `Generate a professional follow-up email for step ${stepNum} of ${totalSteps} in a "${form.outreach_type.replace(/_/g, ' ')}" email sequence called "${form.name}".
${form.description ? `Sequence description: ${form.description}` : ''}

This email will be sent ${step.delay_days} day(s) after ${stepNum === 1 ? 'enrollment' : 'the previous step'}.

Guidelines:
- Step ${stepNum} of ${totalSteps} — ${stepNum === 1 ? 'introduce/remind' : stepNum === totalSteps ? 'final follow-up with urgency' : 'reinforce value proposition'}
- Keep it concise (under 150 words)
- Professional Indian business English tone
- Include clear CTA
- Use {{name}} for the recipient name placeholder
- Use {{company}} for the company name placeholder
- Format body as HTML (just content, no full html/head tags)

Return subject and body_html.`,
      response_json_schema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          body_html: { type: "string" }
        }
      }
    });

    updateStep(index, 'subject', result.subject);
    updateStep(index, 'body_html', result.body_html);
    setGenerating(null);
    toast.success('Email content generated');
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Sequence name is required'); return; }
    if (form.steps.some(s => !s.subject.trim())) { toast.error('All steps need a subject'); return; }

    setSaving(true);
    const data = {
      ...form,
      steps: form.steps.map((s, i) => ({ ...s, step_number: i + 1 }))
    };

    if (isNew) {
      await base44.entities.EmailSequence.create(data);
    } else {
      await base44.entities.EmailSequence.update(sequence.id, data);
    }
    toast.success(isNew ? 'Sequence created' : 'Sequence updated');
    setSaving(false);
    onSave();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onCancel}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold">{isNew ? 'Create Sequence' : 'Edit Sequence'}</h2>
      </div>

      {/* Basic Info */}
      <Card>
        <CardHeader><CardTitle className="text-base">Sequence Details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Lead Nurture - 5 Day" />
            </div>
            <div>
              <Label>Outreach Type</Label>
              <Select value={form.outreach_type} onValueChange={v => setForm({ ...form, outreach_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OUTREACH_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Target Tier (Auto-enrollment)</Label>
              <Select value={form.tier_target || 'all'} onValueChange={v => setForm({ ...form, tier_target: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIER_TARGETS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Brief description of this sequence's purpose" rows={2} />
          </div>
        </CardContent>
      </Card>

      {/* Steps */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Email Steps ({form.steps.length})</CardTitle>
          <Button variant="outline" size="sm" onClick={addStep} className="gap-1">
            <Plus className="w-3.5 h-3.5" /> Add Step
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {form.steps.map((step, i) => (
            <div key={i} className="border rounded-lg p-4 space-y-3 bg-gray-50/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GripVertical className="w-4 h-4 text-gray-300" />
                  <span className="text-sm font-semibold text-gray-700">Step {i + 1}</span>
                  <span className="text-xs text-gray-400">
                    — sends {step.delay_days} day{step.delay_days !== 1 ? 's' : ''} after {i === 0 ? 'enrollment' : `step ${i}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1 text-xs"
                    disabled={generating === i}
                    onClick={() => handleGenerateWithAI(i)}
                  >
                    {generating === i ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    AI Generate
                  </Button>
                  {form.steps.length > 1 && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400" onClick={() => removeStep(i)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs">Delay (days)</Label>
                  <Input type="number" min={0} value={step.delay_days} onChange={e => updateStep(i, 'delay_days', parseInt(e.target.value) || 0)} />
                </div>
                <div className="md:col-span-3">
                  <Label className="text-xs">Subject</Label>
                  <Input value={step.subject} onChange={e => updateStep(i, 'subject', e.target.value)} placeholder="Email subject line..." />
                </div>
              </div>

              <div>
                <Label className="text-xs">Body (HTML)</Label>
                <Textarea
                  value={step.body_html}
                  onChange={e => updateStep(i, 'body_html', e.target.value)}
                  placeholder="<p>Hi {{name}},</p><p>...</p>"
                  rows={4}
                  className="font-mono text-xs"
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={step.use_ai_personalization || false}
                  onCheckedChange={v => updateStep(i, 'use_ai_personalization', v)}
                />
                <Label className="text-xs text-gray-500">AI-personalize at send time (uses lead/client context)</Label>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {isNew ? 'Create Sequence' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}