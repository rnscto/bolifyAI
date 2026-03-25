import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { base44 } from '@/api/base44Client';
import { Send, Link2, Unlink, Loader2, ExternalLink, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export default function TelegramConnect({ client, onUpdate }) {
  const [disconnecting, setDisconnecting] = useState(false);

  const isConnected = client?.telegram_connected && client?.telegram_chat_id;

  // Build the Telegram deep link with client ID
  const botUsername = 'vaaniai_notify_bot'; // Your bot username from BotFather
  const connectUrl = `https://t.me/${botUsername}?start=${client?.id || ''}`;

  const handleDisconnect = async () => {
    setDisconnecting(true);
    await base44.entities.Client.update(client.id, {
      telegram_chat_id: '',
      telegram_connected: false,
      telegram_username: '',
      owner_notification_channel: 'whatsapp'
    });
    onUpdate?.({
      ...client,
      telegram_chat_id: '',
      telegram_connected: false,
      telegram_username: '',
      owner_notification_channel: 'whatsapp'
    });
    setDisconnecting(false);
    toast.success('Telegram disconnected');
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Send className="w-5 h-5 text-blue-500" />
          Telegram Notifications
          {isConnected && (
            <Badge className="bg-green-100 text-green-700 text-xs ml-auto">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Connected
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isConnected ? (
          <>
            <div className="p-3 rounded-lg bg-green-50 border border-green-200">
              <p className="text-sm text-green-800">
                Receiving notifications via Telegram
                {client.telegram_username && (
                  <span className="font-medium"> (@{client.telegram_username})</span>
                )}
              </p>
              <p className="text-xs text-green-600 mt-1">
                You'll get real-time alerts for incoming calls, voicemails, and urgent messages.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="text-red-600 border-red-200 hover:bg-red-50"
            >
              {disconnecting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Unlink className="w-4 h-4 mr-2" />
              )}
              Disconnect Telegram
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600">
              Connect your Telegram account to receive live call notifications, voicemail alerts, and urgent message summaries directly in Telegram.
            </p>
            <div className="space-y-3">
              <a
                href={connectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
              >
                <Send className="w-4 h-4" />
                Connect Telegram
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <p className="text-xs text-gray-400">
                Opens Telegram and connects your account. Tap "Start" in the bot chat to complete.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}