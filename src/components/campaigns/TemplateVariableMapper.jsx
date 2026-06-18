import React from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const FIELD_OPTIONS = [
  { value: 'lead_name', label: 'Lead Name' },
  { value: 'lead_company', label: 'Lead Company' },
  { value: 'lead_phone', label: 'Lead Phone' },
  { value: 'lead_email', label: 'Lead Email' },
  { value: 'static', label: 'Custom text…' },
];

// Counts the numbered placeholders {{1}}…{{N}} in the template body.
function countSlots(template) {
  const nums = (String(template?.body_text || '').match(/\{\{\d+\}\}/g) || [])
    .map(m => parseInt(m.replace(/[^\d]/g, ''), 10));
  return nums.length ? Math.max(...nums) : 0;
}

// Renders a mapping editor for a template's {{1}}…{{N}} placeholders.
// `mapping` is an array of { source, value } (index = slot order). `onChange(nextArray)`.
export default function TemplateVariableMapper({ template, mapping, onChange }) {
  if (!template) return null;
  const slots = countSlots(template);

  // Named tokens ({{name}} etc.) are auto-filled from the lead — no mapping needed.
  if (slots === 0) {
    const hasNamed = /\{\{(name|company|phone|email)\}\}/i.test(template.body_text || '');
    return (
      <p className="text-xs text-gray-500 mt-2">
        {hasNamed
          ? 'This template uses named fields (e.g. {{name}}) — they are filled automatically from each lead.'
          : 'This template has no variables.'}
      </p>
    );
  }

  const current = Array.isArray(mapping) ? mapping : [];
  const slotValue = (i) => current[i] || { source: i === 0 ? 'lead_name' : 'static', value: '' };

  const setSlot = (i, patch) => {
    const next = [];
    for (let s = 0; s < slots; s++) next.push({ ...slotValue(s) });
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  const examples = Array.isArray(template.body_examples) ? template.body_examples : [];

  return (
    <div className="mt-2 space-y-2 border-l-2 border-emerald-200 pl-3">
      <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
        Map template variables
      </Label>
      {Array.from({ length: slots }).map((_, i) => {
        const slot = slotValue(i);
        return (
          <div key={i} className="grid grid-cols-5 gap-2 items-center">
            <div className="col-span-1">
              <span className="inline-block text-xs font-mono bg-gray-100 px-2 py-1 rounded">{`{{${i + 1}}}`}</span>
              {examples[i] && <p className="text-[10px] text-gray-400 mt-0.5 truncate">e.g. {examples[i]}</p>}
            </div>
            <div className="col-span-2">
              <Select value={slot.source} onValueChange={(v) => setSlot(i, { source: v })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FIELD_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              {slot.source === 'static' ? (
                <Input
                  className="h-8 text-xs"
                  placeholder="Custom text"
                  value={slot.value || ''}
                  onChange={(e) => setSlot(i, { value: e.target.value })}
                />
              ) : (
                <span className="text-xs text-gray-400">auto from lead</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}