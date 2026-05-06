import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';

export default function SendTemplateDialog({ template, open, onOpenChange }) {
  const [recipient, setRecipient] = useState('');
  const [variables, setVariables] = useState([]);
  const [sending, setSending] = useState(false);

  // Detect placeholders {{1}}, {{2}} ... in body text
  const placeholderCount = template?.body_text
    ? (template.body_text.match(/\{\{\d+\}\}/g) || []).length
    : 0;

  useEffect(() => {
    if (template) {
      setVariables(Array(placeholderCount).fill(''));
      setRecipient('');
    }
  }, [template, placeholderCount]);

  if (!template) return null;

  const handleSend = async () => {
    if (!recipient.trim()) return toast.error('Recipient phone is required');
    setSending(true);
    try {
      const res = await base44.functions.invoke('whatsappSendTemplate', {
        template_id: template.id,
        recipient: recipient.trim(),
        variables
      });
      if (res.data?.success) {
        toast.success('Template sent successfully!');
        onOpenChange(false);
      } else {
        const errMsg = res.data?.error || 'Send failed';
        const details = res.data?.details?.error;
        const fullMsg = details ? `${errMsg} — ${details.error_user_msg || details.message || ''} (code ${details.code || '?'})` : errMsg;
        console.error('[SendTemplateDialog] send failed:', res.data);
        toast.error(fullMsg, { duration: 8000 });
      }
    } catch (e) {
      const detail = e.response?.data?.error || e.response?.data?.details?.error?.message || e.message;
      console.error('[SendTemplateDialog]', e);
      toast.error(detail, { duration: 8000 });
    } finally {
      setSending(false);
    }
  };

  // Build live preview by replacing placeholders
  let preview = template.body_text || '';
  variables.forEach((v, i) => {
    preview = preview.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v || `{{${i + 1}}}`);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send Template: {template.name}</DialogTitle>
          <DialogDescription>Sends an approved WhatsApp template via Meta Cloud API.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Recipient Phone</Label>
            <Input
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="e.g. 9876543210 or +919876543210"
            />
            <p className="text-xs text-gray-500 mt-1">10-digit Indian numbers will auto-prefix with 91.</p>
          </div>

          {placeholderCount > 0 && (
            <div className="space-y-2">
              <Label>Variables ({placeholderCount} placeholders detected)</Label>
              {variables.map((v, i) => (
                <div key={i}>
                  <Label className="text-xs text-gray-500">{`{{${i + 1}}}`}</Label>
                  <Input
                    value={v}
                    onChange={e => {
                      const next = [...variables];
                      next[i] = e.target.value;
                      setVariables(next);
                    }}
                    placeholder={`Value for {{${i + 1}}}`}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-xs font-semibold text-green-900 mb-1">Preview</p>
            {template.header_text && <p className="text-sm font-bold text-gray-800">{template.header_text}</p>}
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{preview}</p>
            {template.footer_text && <p className="text-xs text-gray-500 italic mt-1">{template.footer_text}</p>}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSend} disabled={sending} className="gap-2 bg-green-600 hover:bg-green-700">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}