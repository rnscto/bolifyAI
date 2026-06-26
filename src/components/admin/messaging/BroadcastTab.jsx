import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Megaphone, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

const AUDIENCES = [
  { value: 'all', label: 'All clients' },
  { value: 'trial', label: 'Trial accounts only' },
  { value: 'active', label: 'Active accounts only' },
  { value: 'expired', label: 'Expired accounts only' }
];

export default function BroadcastTab() {
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [audience, setAudience] = useState('all');
  const [variables, setVariables] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    apiClient.WhatsAppTemplate.filter({ client_id: 'PLATFORM', status: 'APPROVED' }, '-created_at', 500)
      .then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const selected = templates.find(t => t.id === templateId);
  const placeholderCount = (selected?.body_text?.match(/\{\{\d+\}\}/g) || []).length;

  const handleSend = async () => {
    if (!templateId) return toast.error('Pick a template');
    if (!confirm(`Send broadcast to "${audience}" audience? This cannot be undone.`)) return;

    setSending(true);
    setResult(null);
    try {
      const vars = variables.split('|').map(v => v.trim()).filter(Boolean);
      const res = await apiClient.functions.invoke('platformBroadcast', {
        template_id: templateId, audience, default_variables: vars
      });
      if (res.data.success) {
        setResult(res.data);
        toast.success(`Broadcast sent: ${res.data.sent} delivered, ${res.data.failed} failed, ${res.data.skipped} skipped`);
      } else toast.error(res.data.error || 'Broadcast failed');
    } catch (e) { toast.error(e.message); }
    setSending(false);
  };

  return (
    <div className="space-y-4">
      <Card><CardContent className="p-4 flex gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
        <div className="text-sm text-amber-900">
          <p className="font-semibold">Broadcasts send a WhatsApp message to every client matching the audience filter.</p>
          <p className="text-xs mt-1">Use sparingly. Each send is logged in OutreachLog and counts toward your RCS Digital quota.</p>
        </div>
      </CardContent></Card>

      <Card><CardContent className="p-4 space-y-4">
        <div>
          <Label>Template</Label>
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger><SelectValue placeholder="Pick approved template..." /></SelectTrigger>
            <SelectContent>
              {templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name} ({t.language})</SelectItem>)}
            </SelectContent>
          </Select>
          {selected && (
            <div className="mt-2 p-3 bg-gray-50 rounded text-xs text-gray-700">
              <p className="font-medium text-gray-900 mb-1">Preview:</p>
              {selected.body_text}
            </div>
          )}
        </div>

        <div>
          <Label>Audience</Label>
          <Select value={audience} onValueChange={setAudience}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{AUDIENCES.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        {placeholderCount > 0 && (
          <div>
            <Label>Variables ({placeholderCount} expected — separate with |)</Label>
            <Input value={variables} onChange={e => setVariables(e.target.value)} placeholder="e.g. there|2026 special" />
            <p className="text-xs text-gray-500 mt-1">These values are used for every recipient. Use {'{{'}name{'}}'} inside variables for per-client personalization (resolved from Client.company_name).</p>
          </div>
        )}

        <Button onClick={handleSend} disabled={sending || !templateId} className="w-full gap-2 bg-red-600 hover:bg-red-700">
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
          Send Broadcast
        </Button>
      </CardContent></Card>

      {result && (
        <Card><CardContent className="p-4">
          <h4 className="font-semibold mb-2">Last Broadcast Result</h4>
          <div className="grid grid-cols-4 gap-3 text-sm">
            <div><p className="text-gray-500">Total</p><p className="font-bold text-lg">{result.total_recipients}</p></div>
            <div><p className="text-gray-500">Sent</p><p className="font-bold text-lg text-green-600">{result.sent}</p></div>
            <div><p className="text-gray-500">Failed</p><p className="font-bold text-lg text-red-600">{result.failed}</p></div>
            <div><p className="text-gray-500">Skipped</p><p className="font-bold text-lg text-gray-600">{result.skipped}</p></div>
          </div>
          {result.errors?.length > 0 && (
            <details className="mt-3 text-xs"><summary className="cursor-pointer text-gray-600">View errors</summary>
              <ul className="mt-2 space-y-1 text-red-700">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </details>
          )}
        </CardContent></Card>
      )}
    </div>
  );
}