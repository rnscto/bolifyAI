import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { Settings, Save, Loader2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import StreamingSetupGuide from './StreamingSetupGuide';

export default function AgentSettingsCard({ agent, onUpdate }) {
  const [smartfloAgentId, setSmartfloAgentId] = useState('');
  const [smartfloApiToken, setSmartfloApiToken] = useState('');
  const [humanTransferNumber, setHumanTransferNumber] = useState('');
  const [enableAutoTransfer, setEnableAutoTransfer] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showStreamingGuide, setShowStreamingGuide] = useState(false);

  useEffect(() => {
    if (agent) {
      setSmartfloAgentId(agent.smartflo_agent_id || '');
      setSmartfloApiToken(agent.smartflo_api_token || '');
      setHumanTransferNumber(agent.human_transfer_number || '');
      setEnableAutoTransfer(agent.enable_auto_transfer !== false);
    }
  }, [agent]);

  const handleSave = async () => {
    setSaving(true);
    await base44.entities.Agent.update(agent.id, {
      smartflo_agent_id: smartfloAgentId.trim(),
      smartflo_api_token: smartfloApiToken.trim(),
      human_transfer_number: humanTransferNumber.trim(),
      enable_auto_transfer: enableAutoTransfer
    });
    toast.success('Agent settings saved');
    setSaving(false);
    onUpdate?.();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-gray-500" />
          <div>
            <CardTitle>Call Settings</CardTitle>
            <CardDescription>Configure live call monitoring and transfer options</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Click-to-Call API Token */}
        <div>
          <Label htmlFor="smartflo_api_token">Click-to-Call API Token</Label>
          <Input
            id="smartflo_api_token"
            value={smartfloApiToken}
            onChange={(e) => setSmartfloApiToken(e.target.value)}
            placeholder="e.g. 6c68bc01-e63d-4ada-bec3-..."
            className="mt-1 font-mono text-xs"
          />
          <p className="text-xs text-gray-500 mt-1">
            Your Smartflo Click-to-Call API token. Leave blank to use the default demo token.
          </p>
          {smartfloApiToken && (
            <div className="mt-2">
              <button
                onClick={() => setShowStreamingGuide(!showStreamingGuide)}
                className="flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-800"
              >
                <AlertTriangle className="w-3 h-3" />
                Important: WebSocket Streaming Setup Required
                {showStreamingGuide ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {showStreamingGuide && (
                <StreamingSetupGuide />
              )}
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="smartflo_agent_id">Smartflo Agent ID</Label>
          <Input
            id="smartflo_agent_id"
            value={smartfloAgentId}
            onChange={(e) => setSmartfloAgentId(e.target.value)}
            placeholder="e.g. 12345"
            className="mt-1"
          />
          <p className="text-xs text-gray-500 mt-1">
            Numeric agent ID from Smartflo portal — required for Monitor, Whisper & Barge-in actions.
          </p>
        </div>

        <div>
          <Label htmlFor="human_transfer_number">Human Transfer Extension</Label>
          <Input
            id="human_transfer_number"
            value={humanTransferNumber}
            onChange={(e) => setHumanTransferNumber(e.target.value)}
            placeholder="e.g. 1001 or +919876543210"
            className="mt-1"
          />
          <p className="text-xs text-gray-500 mt-1">
            Intercom extension or phone number to transfer calls to a human agent.
          </p>
        </div>

        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
          <div>
            <p className="text-sm font-medium text-gray-700">Auto Transfer</p>
            <p className="text-xs text-gray-500">Allow AI to automatically offer transfer when customer requests a human</p>
          </div>
          <Switch
            checked={enableAutoTransfer}
            onCheckedChange={setEnableAutoTransfer}
          />
        </div>

        <Button onClick={handleSave} disabled={saving} className="w-full">
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Settings
        </Button>
      </CardContent>
    </Card>
  );
}