import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, Trash2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'en_US', name: 'English (US)' },
  { code: 'en_GB', name: 'English (UK)' },
  { code: 'hi', name: 'Hindi' },
  { code: 'mr', name: 'Marathi' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'bn', name: 'Bengali' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'pa', name: 'Punjabi' },
];

export default function CreateTemplateDialog({ clientId, open, onOpenChange, onCreated }) {
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en');
  const [category, setCategory] = useState('UTILITY');
  const [headerType, setHeaderType] = useState('NONE');
  const [headerText, setHeaderText] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [footerText, setFooterText] = useState('');
  const [examples, setExamples] = useState([]);
  const [buttons, setButtons] = useState([]);
  const [saving, setSaving] = useState(false);
  const [aiGoal, setAiGoal] = useState('');
  const [aiDrafting, setAiDrafting] = useState(false);

  const handleAiDraft = async () => {
    if (!aiGoal.trim()) return toast.error('Describe what the message should achieve');
    setAiDrafting(true);
    try {
      const res = await base44.functions.invoke('aiTemplateDraft', {
        goal: aiGoal, language, category, tone: 'friendly'
      });
      if (res.data.success && res.data.draft) {
        const d = res.data.draft;
        setName(d.name || '');
        setBodyText(d.body_text || '');
        setExamples(d.body_examples || []);
        setFooterText(d.footer_text || '');
        setHeaderType(d.header_type || 'NONE');
        setHeaderText(d.header_text || '');
        setButtons((d.buttons || []).slice(0, 3).map(b => ({ type: b.type, text: b.text || '', url: b.url || '', phone_number: b.phone_number || '' })));
        toast.success('AI draft loaded — review and edit before submitting');
      } else toast.error(res.data.error || 'AI draft failed');
    } catch (e) { toast.error(e.message); }
    setAiDrafting(false);
  };

  // Detect placeholders
  const placeholderCount = (bodyText.match(/\{\{\d+\}\}/g) || []).length;

  // Sync examples array with placeholder count
  useEffect(() => {
    setExamples(prev => {
      const next = [...prev];
      while (next.length < placeholderCount) next.push('');
      return next.slice(0, placeholderCount);
    });
  }, [placeholderCount]);

  const addButton = () => {
    if (buttons.length >= 3) return toast.error('Max 3 buttons allowed');
    setButtons([...buttons, { type: 'QUICK_REPLY', text: '', url: '', phone_number: '' }]);
  };

  const updateButton = (i, key, val) => {
    const next = [...buttons];
    next[i] = { ...next[i], [key]: val };
    setButtons(next);
  };

  const removeButton = (i) => setButtons(buttons.filter((_, idx) => idx !== i));

  const handleSubmit = async () => {
    if (!name.trim()) return toast.error('Template name required');
    if (!bodyText.trim()) return toast.error('Body text required');
    if (placeholderCount > 0 && examples.some(e => !e.trim())) {
      return toast.error('All placeholder examples are required by Meta');
    }

    setSaving(true);
    try {
      const res = await base44.functions.invoke('whatsappCreateTemplate', {
        client_id: clientId,
        name: name.trim(),
        language,
        category,
        header_type: headerType,
        header_text: headerText,
        body_text: bodyText,
        body_examples: examples,
        footer_text: footerText,
        buttons: buttons.filter(b => b.text.trim()),
        linked_actions: []
      });
      if (res.data.success) {
        toast.success('Template submitted to Meta for review (24-48 hrs)');
        onCreated?.();
        // Reset
        setName(''); setBodyText(''); setHeaderText(''); setFooterText('');
        setExamples([]); setButtons([]); setHeaderType('NONE');
        onOpenChange(false);
      } else {
        toast.error(res.data.error || 'Creation failed');
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create WhatsApp Template</DialogTitle>
          <DialogDescription>
            Submit a new template to Meta for approval. Approval takes 24-48 hours. Use {`{{1}}`}, {`{{2}}`} for variables.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 rounded-lg p-3 space-y-2">
            <Label className="flex items-center gap-1.5 text-purple-900"><Sparkles className="w-4 h-4" /> AI Draft (optional)</Label>
            <div className="flex gap-2">
              <Input value={aiGoal} onChange={e => setAiGoal(e.target.value)} placeholder="e.g. Confirm a demo booking with date and time" />
              <Button onClick={handleAiDraft} disabled={aiDrafting || !aiGoal.trim()} variant="outline" className="gap-1 whitespace-nowrap">
                {aiDrafting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Draft with AI
              </Button>
            </div>
            <p className="text-xs text-purple-700">Generates a Meta-compliant draft body, sample values and buttons. You can still edit everything below.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Name (lowercase, no spaces)</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. order_confirmation" />
            </div>
            <div>
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MARKETING">Marketing</SelectItem>
                  <SelectItem value="UTILITY">Utility (transactional)</SelectItem>
                  <SelectItem value="AUTHENTICATION">Authentication (OTP)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Language</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LANGUAGES.map(l => <SelectItem key={l.code} value={l.code}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="border-t pt-3">
            <Label>Header (optional)</Label>
            <Select value={headerType} onValueChange={setHeaderType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">No header</SelectItem>
                <SelectItem value="TEXT">Text header</SelectItem>
              </SelectContent>
            </Select>
            {headerType === 'TEXT' && (
              <Input
                className="mt-2"
                value={headerText}
                onChange={e => setHeaderText(e.target.value)}
                placeholder="Header text (max 60 chars)"
                maxLength={60}
              />
            )}
          </div>

          <div>
            <Label>Body Text *</Label>
            <Textarea
              value={bodyText}
              onChange={e => setBodyText(e.target.value)}
              placeholder="Hi {{1}}, your order #{{2}} is confirmed. Thank you!"
              rows={4}
              maxLength={1024}
            />
            <p className="text-xs text-gray-500 mt-1">
              {bodyText.length}/1024 chars · {placeholderCount} placeholder(s) detected
            </p>
          </div>

          {placeholderCount > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-yellow-900">
                Sample values for placeholders (required by Meta for review)
              </p>
              {examples.map((e, i) => (
                <div key={i}>
                  <Label className="text-xs">{`{{${i + 1}}}`} sample value</Label>
                  <Input
                    value={e}
                    onChange={ev => {
                      const next = [...examples];
                      next[i] = ev.target.value;
                      setExamples(next);
                    }}
                    placeholder={`e.g. John`}
                  />
                </div>
              ))}
            </div>
          )}

          <div>
            <Label>Footer (optional)</Label>
            <Input
              value={footerText}
              onChange={e => setFooterText(e.target.value)}
              placeholder="e.g. Reply STOP to unsubscribe"
              maxLength={60}
            />
          </div>

          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <Label>Buttons (optional, max 3)</Label>
              <Button type="button" size="sm" variant="outline" onClick={addButton} className="gap-1">
                <Plus className="w-3 h-3" /> Add Button
              </Button>
            </div>
            {buttons.map((b, i) => (
              <div key={i} className="border rounded p-2 mb-2 space-y-2">
                <div className="flex gap-2">
                  <Select value={b.type} onValueChange={v => updateButton(i, 'type', v)}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="QUICK_REPLY">Quick Reply</SelectItem>
                      <SelectItem value="URL">URL</SelectItem>
                      <SelectItem value="PHONE_NUMBER">Phone</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={b.text}
                    onChange={e => updateButton(i, 'text', e.target.value)}
                    placeholder="Button label"
                    maxLength={25}
                  />
                  <Button size="icon" variant="ghost" onClick={() => removeButton(i)}>
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                </div>
                {b.type === 'URL' && (
                  <Input
                    value={b.url}
                    onChange={e => updateButton(i, 'url', e.target.value)}
                    placeholder="https://..."
                  />
                )}
                {b.type === 'PHONE_NUMBER' && (
                  <Input
                    value={b.phone_number}
                    onChange={e => updateButton(i, 'phone_number', e.target.value)}
                    placeholder="+91..."
                  />
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 sticky bottom-0 bg-white pt-3 border-t">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saving} className="gap-2 bg-green-600 hover:bg-green-700">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Submit to Meta
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}