import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

export default function RCSTemplateSender({ template, clientId, onClose }) {
  const [recipient, setRecipient] = useState('');
  const [values, setValues] = useState({});
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (template?.variables) {
      const initial = {};
      template.variables.forEach(v => { initial[v.key] = v.default_value || ''; });
      setValues(initial);
    }
  }, [template]);

  const resolvedMessage = (template?.body || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return values[key] || `{{${key}}}`;
  });

  const allFilled = (template?.variables || []).every(v => v.source !== 'manual' || values[v.key]?.trim());

  const handleSend = async () => {
    if (!recipient.trim()) { toast.error('Enter recipient phone number'); return; }
    setSending(true);
    const res = await base44.functions.invoke('sendRCS', {
      client_id: clientId,
      recipient: recipient,
      message: resolvedMessage
    });
    if (res.data.success) {
      toast.success('RCS message sent!');
      // Increment usage count
      await base44.entities.RCSTemplate.update(template.id, {
        usage_count: (template.usage_count || 0) + 1
      });
      onClose();
    } else {
      toast.error(res.data.error || 'Failed to send');
    }
    setSending(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-medium text-sm">Sending: {template?.name}</span>
        <Badge variant="outline" className="text-[10px]">{template?.category}</Badge>
      </div>

      <div>
        <Label>Recipient Phone Number</Label>
        <Input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="e.g. 919876543210" />
      </div>

      {template?.variables?.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-gray-500">Fill Variables</Label>
          {template.variables.map(v => (
            <div key={v.key} className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-[10px] shrink-0 w-28 justify-center">{`{{${v.key}}}`}</Badge>
              {v.source === 'manual' ? (
                <Input
                  value={values[v.key] || ''}
                  onChange={e => setValues(prev => ({ ...prev, [v.key]: e.target.value }))}
                  placeholder={v.label || v.key}
                  className="h-8 text-sm"
                />
              ) : (
                <div className="flex items-center gap-1 flex-1">
                  <Input
                    value={values[v.key] || ''}
                    onChange={e => setValues(prev => ({ ...prev, [v.key]: e.target.value }))}
                    placeholder={`Auto: ${v.source.replace(/_/g, ' ')}`}
                    className="h-8 text-sm"
                  />
                  <Badge className="text-[10px] bg-blue-50 text-blue-700 shrink-0">Auto: {v.source.replace(/_/g, ' ')}</Badge>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div>
        <Label className="flex items-center gap-1 text-xs text-gray-500 mb-1">
          <Sparkles className="w-3 h-3" /> Message Preview
        </Label>
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm whitespace-pre-wrap">{resolvedMessage}</div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSend} disabled={sending || !recipient.trim()} className="gap-2">
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send RCS
        </Button>
      </div>
    </div>
  );
}