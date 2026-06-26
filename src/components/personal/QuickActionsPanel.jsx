import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiClient } from '@/api/apiClient';
import { BellOff, Shield, Settings } from 'lucide-react';
import { toast } from 'sonner';

const responseModes = [
  { value: 'screen_all', label: 'Screen All Calls', description: 'AI screens every incoming call and notifies you' },
  { value: 'allow_contacts', label: 'Allow Known Contacts', description: 'Auto-connect known callers, screen unknown' },
  { value: 'take_messages', label: 'Take Messages Only', description: 'AI takes messages for all callers' },
  { value: 'block_all', label: 'Block All Calls', description: 'Reject all incoming calls silently' }
];

export default function QuickActionsPanel({ client, onUpdate }) {
  const [dndEnabled, setDndEnabled] = useState(client?.dnd_enabled || false);
  const [responseMode, setResponseMode] = useState(client?.ai_response_mode || 'screen_all');
  const [saving, setSaving] = useState(false);

  const handleDNDToggle = async (checked) => {
    setDndEnabled(checked);
    setSaving(true);
    await apiClient.Client.update(client.id, { dnd_enabled: checked });
    setSaving(false);
    onUpdate?.({ ...client, dnd_enabled: checked });
    toast.success(checked ? 'Do Not Disturb enabled' : 'Do Not Disturb disabled');
  };

  const handleModeChange = async (value) => {
    setResponseMode(value);
    setSaving(true);
    await apiClient.Client.update(client.id, { ai_response_mode: value });
    setSaving(false);
    onUpdate?.({ ...client, ai_response_mode: value });
    toast.success('AI response mode updated');
  };

  const currentMode = responseModes.find(m => m.value === responseMode);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Settings className="w-5 h-5" />
          Quick Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Do Not Disturb */}
        <div className="flex items-center justify-between p-4 rounded-lg border bg-gray-50">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${dndEnabled ? 'bg-red-100' : 'bg-gray-200'}`}>
              <BellOff className={`w-5 h-5 ${dndEnabled ? 'text-red-600' : 'text-gray-500'}`} />
            </div>
            <div>
              <Label className="text-sm font-medium">Do Not Disturb</Label>
              <p className="text-xs text-gray-500 mt-0.5">
                {dndEnabled ? 'AI handles all calls silently' : 'You will get notified for screened calls'}
              </p>
            </div>
          </div>
          <Switch
            checked={dndEnabled}
            onCheckedChange={handleDNDToggle}
            disabled={saving}
          />
        </div>

        {/* AI Response Mode */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-gray-600" />
            <Label className="text-sm font-medium">AI Response Mode</Label>
          </div>
          <Select value={responseMode} onValueChange={handleModeChange} disabled={saving}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {responseModes.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {currentMode && (
            <p className="text-xs text-gray-500 pl-1">{currentMode.description}</p>
          )}
        </div>

        {/* Notification channel info */}
        <div className="text-xs text-gray-400 pt-2 border-t">
          Notifications via: <span className="font-medium capitalize">{client?.owner_notification_channel || 'WhatsApp'}</span>
          {client?.owner_notification_channel === 'telegram' && client?.telegram_username
            ? ` (@${client.telegram_username})`
            : client?.owner_whatsapp_number ? ` (${client.owner_whatsapp_number})` : ''}
        </div>
      </CardContent>
    </Card>
  );
}