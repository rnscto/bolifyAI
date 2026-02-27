import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Plus, Variable, Sparkles } from 'lucide-react';

const CATEGORIES = [
  { value: 'followup', label: 'Follow-up' },
  { value: 'reminder', label: 'Reminder' },
  { value: 'promotion', label: 'Promotion' },
  { value: 'notification', label: 'Notification' },
  { value: 'welcome', label: 'Welcome' },
  { value: 'custom', label: 'Custom' },
];

const VARIABLE_SOURCES = [
  { value: 'manual', label: 'Manual Input' },
  { value: 'lead_name', label: 'Lead Name' },
  { value: 'lead_phone', label: 'Lead Phone' },
  { value: 'lead_email', label: 'Lead Email' },
  { value: 'lead_company', label: 'Lead Company' },
  { value: 'agent_name', label: 'Agent Name' },
  { value: 'client_company', label: 'Company Name' },
];

export default function RCSTemplateEditor({ template, onSave, onCancel }) {
  const [name, setName] = useState(template?.name || '');
  const [category, setCategory] = useState(template?.category || 'custom');
  const [body, setBody] = useState(template?.body || '');
  const [variables, setVariables] = useState(template?.variables || []);
  const [newVarKey, setNewVarKey] = useState('');

  // Auto-detect variables from body text
  useEffect(() => {
    const matches = body.match(/\{\{(\w+)\}\}/g) || [];
    const detectedKeys = matches.map(m => m.replace(/\{\{|\}\}/g, ''));
    const uniqueKeys = [...new Set(detectedKeys)];

    setVariables(prev => {
      const existing = prev.reduce((map, v) => { map[v.key] = v; return map; }, {});
      return uniqueKeys.map(key => existing[key] || { key, label: key.replace(/_/g, ' '), default_value: '', source: 'manual' });
    });
  }, [body]);

  const addVariable = () => {
    if (!newVarKey.trim()) return;
    const key = newVarKey.trim().replace(/\s+/g, '_').toLowerCase();
    if (variables.find(v => v.key === key)) return;
    setBody(prev => prev + ` {{${key}}}`);
    setNewVarKey('');
  };

  const updateVariable = (index, field, value) => {
    setVariables(prev => prev.map((v, i) => i === index ? { ...v, [field]: value } : v));
  };

  const insertVariable = (key) => {
    setBody(prev => prev + `{{${key}}}`);
  };

  const handleSave = () => {
    if (!name.trim() || !body.trim()) return;
    onSave({ name, category, body, variables, status: template?.status || 'active' });
  };

  const preview = variables.reduce((text, v) => {
    const val = v.default_value || `[${v.label}]`;
    return text.replace(new RegExp(`\\{\\{${v.key}\\}\\}`, 'g'), val);
  }, body);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Template Name</Label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Follow-up after call" />
        </div>
        <div>
          <Label>Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label className="flex items-center justify-between">
          <span>Message Body</span>
          <span className="text-xs text-gray-400 font-normal">Use {"{{variable_name}}"} for dynamic content</span>
        </Label>
        <Textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Hi {{customer_name}}, thanks for your interest! Your order {{order_id}} is confirmed."
          className="min-h-[120px] font-mono text-sm"
        />
        <div className="flex items-center gap-2 mt-2">
          <Input
            value={newVarKey}
            onChange={e => setNewVarKey(e.target.value)}
            placeholder="Add variable name..."
            className="flex-1 h-8 text-sm"
            onKeyDown={e => e.key === 'Enter' && addVariable()}
          />
          <Button variant="outline" size="sm" onClick={addVariable} className="gap-1 h-8">
            <Plus className="w-3 h-3" /> Insert
          </Button>
        </div>
      </div>

      {variables.length > 0 && (
        <div>
          <Label className="flex items-center gap-1 mb-2">
            <Variable className="w-4 h-4" /> Variables ({variables.length})
          </Label>
          <div className="space-y-2">
            {variables.map((v, i) => (
              <div key={v.key} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
                <Badge variant="outline" className="font-mono text-xs shrink-0 cursor-pointer hover:bg-purple-50" onClick={() => insertVariable(v.key)}>
                  {`{{${v.key}}}`}
                </Badge>
                <Input
                  value={v.label}
                  onChange={e => updateVariable(i, 'label', e.target.value)}
                  placeholder="Label"
                  className="h-8 text-sm flex-1"
                />
                <Input
                  value={v.default_value}
                  onChange={e => updateVariable(i, 'default_value', e.target.value)}
                  placeholder="Default value"
                  className="h-8 text-sm flex-1"
                />
                <Select value={v.source} onValueChange={val => updateVariable(i, 'source', val)}>
                  <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VARIABLE_SOURCES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      )}

      {body && (
        <div>
          <Label className="flex items-center gap-1 text-xs text-gray-500 mb-1">
            <Sparkles className="w-3 h-3" /> Preview
          </Label>
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm whitespace-pre-wrap">{preview}</div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSave} disabled={!name.trim() || !body.trim()}>
          {template?.id ? 'Update Template' : 'Save Template'}
        </Button>
      </div>
    </div>
  );
}