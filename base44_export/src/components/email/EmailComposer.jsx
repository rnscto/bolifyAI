import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Send, Loader2, Eye, Edit, RotateCcw, Mail } from 'lucide-react';
import { toast } from 'sonner';

const TEMPLATE_TYPES = [
  { value: 'follow_up', label: 'Follow-up Email' },
  { value: 'pricing', label: 'Pricing Details' },
  { value: 'brochure', label: 'Brochure / Info Pack' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'demo_details', label: 'Demo Details' },
  { value: 'site_visit', label: 'Site Visit Confirmation' },
  { value: 'thank_you', label: 'Thank You' },
  { value: 'custom', label: 'Custom Email' },
];

export default function EmailComposer({ open, onOpenChange, lead, client, activity, onEmailSent }) {
  const [step, setStep] = useState('compose'); // compose | preview
  const [templateType, setTemplateType] = useState('follow_up');
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [toEmail, setToEmail] = useState(lead?.email || '');
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  const handleOpen = (isOpen) => {
    if (isOpen) {
      setToEmail(lead?.email || '');
      setStep('compose');
    }
    onOpenChange(isOpen);
  };

  const generateTemplate = async () => {
    setGenerating(true);
    try {
      const res = await base44.functions.invoke('composeEmail', {
        action: 'generate_template',
        lead_id: lead?.id,
        client_id: client?.id,
        activity_id: activity?.id,
        template_type: templateType
      });
      if (res.data?.success && res.data.template) {
        const t = res.data.template;
        setSubject(t.subject || '');
        setBodyHtml(t.body_html || '');
        setSuggestions(t.suggested_attachments || []);
        toast.success('AI template generated!');
      } else {
        toast.error(res.data?.error || 'Failed to generate template');
      }
    } catch (err) {
      toast.error('Failed to generate template');
    } finally {
      setGenerating(false);
    }
  };

  const sendEmail = async () => {
    if (!toEmail) { toast.error('Recipient email is required'); return; }
    if (!subject) { toast.error('Subject is required'); return; }
    if (!bodyHtml) { toast.error('Email body is required'); return; }

    setSending(true);
    try {
      const res = await base44.functions.invoke('composeEmail', {
        action: 'send_email',
        to_email: toEmail,
        from_name: client?.company_name || 'VaaniAI',
        subject,
        body_html: bodyHtml,
        lead_id: lead?.id,
        client_id: client?.id,
        activity_id: activity?.id,
        outreach_type: templateType === 'pricing' ? 'proposal' : 'lead_followup'
      });
      if (res.data?.success) {
        toast.success(`Email sent to ${toEmail}!`);
        onOpenChange(false);
        onEmailSent?.();
        // Reset
        setSubject('');
        setBodyHtml('');
        setStep('compose');
      } else {
        toast.error(res.data?.error || 'Failed to send email');
      }
    } catch (err) {
      const errMsg = err?.response?.data?.error || err?.message || 'Failed to send email';
      toast.error(`Email error: ${errMsg}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-blue-600" />
            Email Composer
            {lead?.name && (
              <Badge variant="outline" className="ml-2 font-normal">
                To: {lead.name}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Recipient */}
          <div>
            <Label>Recipient Email</Label>
            <Input
              value={toEmail}
              onChange={e => setToEmail(e.target.value)}
              placeholder="lead@example.com"
              type="email"
            />
          </div>

          {/* Template Type + Generate */}
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Label>Template Type</Label>
              <Select value={templateType} onValueChange={setTemplateType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_TYPES.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={generateTemplate}
              disabled={generating}
              className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
            >
              {generating ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-1.5" /> Generating...</>
              ) : (
                <><Sparkles className="w-4 h-4 mr-1.5" /> AI Generate</>
              )}
            </Button>
          </div>

          {/* Subject */}
          <div>
            <Label>Subject</Label>
            <Input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Email subject line..."
            />
          </div>

          {/* Body Editor / Preview Toggle */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label>Email Body</Label>
              <div className="flex gap-1">
                <Button
                  size="sm" variant={step === 'compose' ? 'default' : 'ghost'}
                  onClick={() => setStep('compose')}
                  className="h-7 text-xs"
                >
                  <Edit className="w-3 h-3 mr-1" /> Edit
                </Button>
                <Button
                  size="sm" variant={step === 'preview' ? 'default' : 'ghost'}
                  onClick={() => setStep('preview')}
                  className="h-7 text-xs"
                  disabled={!bodyHtml}
                >
                  <Eye className="w-3 h-3 mr-1" /> Preview
                </Button>
              </div>
            </div>

            {step === 'compose' ? (
              <textarea
                value={bodyHtml}
                onChange={e => setBodyHtml(e.target.value)}
                placeholder="Write your email content here... HTML tags are supported."
                className="w-full min-h-[250px] p-3 border rounded-lg text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : (
              <div className="border rounded-lg p-4 bg-white min-h-[250px] max-h-[400px] overflow-y-auto">
                <div
                  className="prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: bodyHtml }}
                />
              </div>
            )}
          </div>

          {/* AI Suggestions */}
          {suggestions.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs font-medium text-amber-800 mb-1">📎 Suggested Attachments (send manually):</p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s, i) => (
                  <Badge key={i} variant="outline" className="text-xs bg-white">{s}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Activity context */}
          {activity && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-xs font-medium text-blue-800">
                📋 Activity: {activity.title}
              </p>
              {activity.description && (
                <p className="text-xs text-blue-600 mt-1 line-clamp-2">{activity.description}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2 sm:gap-2">
          {bodyHtml && (
            <Button
              variant="outline" size="sm"
              onClick={() => { setSubject(''); setBodyHtml(''); setSuggestions([]); setStep('compose'); }}
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reset
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={sendEmail}
            disabled={sending || !toEmail || !subject || !bodyHtml}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {sending ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-1.5" /> Sending...</>
            ) : (
              <><Send className="w-4 h-4 mr-1.5" /> Send Email</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}