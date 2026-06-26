import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

const EVENTS = [
  { key: 'welcome', label: 'Welcome (on signup)', desc: 'Sent when client account is created' },
  { key: 'onboarding_d1', label: 'Onboarding Day 1', desc: 'If client hasn\'t completed onboarding 1 day after signup' },
  { key: 'onboarding_d3', label: 'Onboarding Day 3', desc: 'If client hasn\'t completed onboarding 3 days after signup' },
  { key: 'trial_2d', label: 'Trial Ending — 2 days', desc: '2 days before trial expiry' },
  { key: 'trial_1d', label: 'Trial Ending — 1 day', desc: '1 day before trial expiry' },
  { key: 'trial_0d', label: 'Trial Ending — Today', desc: 'On the day trial expires' }
];

export default function LifecycleConfigTab({ config, onSaved }) {
  const [templates, setTemplates] = useState([]);
  const [mapping, setMapping] = useState(config?.lifecycle_templates || {});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiClient.WhatsAppTemplate.filter({ client_id: 'PLATFORM', status: 'APPROVED' }, '-created_at', 500)
      .then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (config?.id) {
        await apiClient.PlatformMessagingConfig.update(config.id, { lifecycle_templates: mapping });
      } else {
        await apiClient.PlatformMessagingConfig.create({ is_singleton: true, lifecycle_templates: mapping });
      }
      toast.success('Lifecycle template mapping saved');
      onSaved && onSaved();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <Card><CardContent className="p-4">
        <p className="text-sm text-gray-600">Map each lifecycle event to an approved platform template. Lifecycle nudges run via daily cron at <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">/functions/lifecycleNudges?api_key=YOUR_CRON_KEY</code></p>
      </CardContent></Card>

      <Card><CardContent className="p-4 space-y-4">
        {EVENTS.map(ev => (
          <div key={ev.key} className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start border-b pb-3 last:border-b-0">
            <div>
              <Label className="font-medium">{ev.label}</Label>
              <p className="text-xs text-gray-500 mt-0.5">{ev.desc}</p>
            </div>
            <Select value={mapping[ev.key] || '__none__'} onValueChange={v => setMapping({ ...mapping, [ev.key]: v === '__none__' ? '' : v })}>
              <SelectTrigger><SelectValue placeholder="Pick template..." /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— None —</SelectItem>
                {templates.map(t => <SelectItem key={t.id} value={t.name}>{t.name} ({t.language})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        ))}
        <Button onClick={handleSave} disabled={saving} className="w-full gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Mapping
        </Button>
      </CardContent></Card>
    </div>
  );
}