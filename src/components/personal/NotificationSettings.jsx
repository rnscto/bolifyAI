import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/api/apiClient';
import { Bell, Send, MessageSquare, CheckCircle2, Unlink, Loader2, ExternalLink, Save } from 'lucide-react';
import { toast } from 'sonner';

const channels = [
  { value: 'whatsapp', label: 'WhatsApp', icon: MessageSquare, color: 'bg-green-500' },
  { value: 'telegram', label: 'Telegram', icon: Send, color: 'bg-blue-500' },
];

export default function NotificationSettings({ client, onUpdate }) {
  const [selectedChannel, setSelectedChannel] = useState(client?.owner_notification_channel || 'whatsapp');
  const [whatsappNumber, setWhatsappNumber] = useState(client?.owner_whatsapp_number || '');
  const [saving, setSaving] = useState(false);
  const [disconnectingTg, setDisconnectingTg] = useState(false);

  const isTelegramConnected = client?.telegram_connected && client?.telegram_chat_id;
  const botUsername = 'getway_aibot';
  const connectUrl = `https://t.me/${botUsername}?start=${client?.id || ''}`;

  const handleSave = async () => {
    setSaving(true);
    const data = { owner_notification_channel: selectedChannel };
    if (selectedChannel === 'whatsapp') {
      data.owner_whatsapp_number = whatsappNumber;
    }
    await apiClient.Client.update(client.id, data);
    onUpdate?.({ ...client, ...data });
    setSaving(false);
    toast.success('Notification settings saved');
  };

  const handleDisconnectTelegram = async () => {
    setDisconnectingTg(true);
    const data = {
      telegram_chat_id: '',
      telegram_connected: false,
      telegram_username: '',
      owner_notification_channel: 'whatsapp'
    };
    await apiClient.Client.update(client.id, data);
    onUpdate?.({ ...client, ...data });
    setSelectedChannel('whatsapp');
    setDisconnectingTg(false);
    toast.success('Telegram disconnected');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Bell className="w-5 h-5" />
          Notification Channel
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Channel selector */}
        <div className="grid grid-cols-2 gap-3">
          {channels.map((ch) => {
            const Icon = ch.icon;
            const isActive = selectedChannel === ch.value;
            const isDisabled = ch.value === 'telegram' && !isTelegramConnected;
            return (
              <button
                key={ch.value}
                onClick={() => !isDisabled && setSelectedChannel(ch.value)}
                className={`p-4 rounded-lg border-2 text-left transition-all ${
                  isActive ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                } ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <div className={`w-8 h-8 rounded-full ${ch.color} flex items-center justify-center`}>
                    <Icon className="w-4 h-4 text-white" />
                  </div>
                  <span className="font-medium text-sm">{ch.label}</span>
                  {isActive && <CheckCircle2 className="w-4 h-4 text-blue-500 ml-auto" />}
                </div>
                {ch.value === 'telegram' && !isTelegramConnected && (
                  <span className="text-xs text-gray-400">Not connected</span>
                )}
                {ch.value === 'telegram' && isTelegramConnected && (
                  <span className="text-xs text-green-600">@{client.telegram_username || 'Connected'}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* WhatsApp config */}
        {selectedChannel === 'whatsapp' && (
          <div className="space-y-2">
            <Label>WhatsApp Number</Label>
            <Input
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
              placeholder="+91 9876543210"
            />
            <p className="text-xs text-gray-400">You'll receive call alerts on this WhatsApp number</p>
          </div>
        )}

        {/* Telegram config */}
        {selectedChannel === 'telegram' && isTelegramConnected && (
          <div className="p-3 rounded-lg bg-green-50 border border-green-200 space-y-2">
            <p className="text-sm text-green-800">
              Connected to Telegram
              {client.telegram_username && <span className="font-medium"> (@{client.telegram_username})</span>}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnectTelegram}
              disabled={disconnectingTg}
              className="text-red-600 border-red-200 hover:bg-red-50"
            >
              {disconnectingTg ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Unlink className="w-4 h-4 mr-2" />}
              Disconnect
            </Button>
          </div>
        )}

        {/* Telegram connect CTA */}
        {!isTelegramConnected && (
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 space-y-2">
            <p className="text-sm text-blue-800">Connect Telegram to use it as your notification channel</p>
            <a
              href={connectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Send className="w-4 h-4" />
              Connect Telegram Bot
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <p className="text-xs text-blue-600">Tap "Start" in the bot chat to complete setup</p>
          </div>
        )}

        <Button onClick={handleSave} disabled={saving} className="w-full">
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Notification Settings
        </Button>
      </CardContent>
    </Card>
  );
}