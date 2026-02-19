import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Smartphone, CheckCircle2, XCircle, Loader2, Send, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';

const PROVIDERS = [
  { value: 'none', label: 'Not Connected' },
  { value: 'gupshup', label: 'Gupshup SMS', fields: ['api_key', 'sender_id', 'api_endpoint'] },
  { value: 'smartflo', label: 'Smartflo (Tata)', fields: ['api_key', 'api_endpoint'] },
  { value: 'kaleyra', label: 'Kaleyra', fields: ['api_key', 'sender_id', 'api_endpoint'] },
  { value: 'route_mobile', label: 'Route Mobile', fields: ['api_key', 'sender_id', 'api_endpoint'] },
  { value: 'twilio', label: 'Twilio SMS', fields: ['api_key', 'sender_id'] },
];

export default function RCSSetup({ config, onSave }) {
  const [provider, setProvider] = useState(config?.rcs_provider || 'none');
  const [apiKey, setApiKey] = useState(config?.rcs_api_key || '');
  const [senderId, setSenderId] = useState(config?.rcs_sender_id || '');
  const [apiEndpoint, setApiEndpoint] = useState(config?.rcs_api_endpoint || '');
  const [testRecipient, setTestRecipient] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const currentProvider = PROVIDERS.find(p => p.value === provider);
  const fields = currentProvider?.fields || [];

  const handleTest = async () => {
    setTesting(true);
    const res = await base44.functions.invoke('testMessagingConnection', {
      channel: 'rcs',
      test_recipient: testRecipient,
      config: { rcs_provider: provider, rcs_api_key: apiKey, rcs_sender_id: senderId, rcs_api_endpoint: apiEndpoint }
    });
    if (res.data.success) toast.success(res.data.message);
    else toast.error(res.data.error || 'Connection failed');
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      rcs_provider: provider,
      rcs_api_key: apiKey,
      rcs_sender_id: senderId,
      rcs_api_endpoint: apiEndpoint,
      rcs_status: provider === 'none' ? 'disconnected' : config?.rcs_status || 'disconnected',
    });
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="w-5 h-5 text-purple-600" /> RCS / SMS
          </CardTitle>
          <Badge className={config?.rcs_status === 'connected' ? 'bg-green-100 text-green-800' : config?.rcs_status === 'error' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}>
            {config?.rcs_status === 'connected' ? <><CheckCircle2 className="w-3 h-3 mr-1" /> Connected</> : config?.rcs_status === 'error' ? <><XCircle className="w-3 h-3 mr-1" /> Error</> : 'Disconnected'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label>Provider</Label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROVIDERS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {provider !== 'none' && (
          <>
            {fields.includes('api_key') && (
              <div>
                <Label>API Key / Auth Token</Label>
                <div className="relative">
                  <Input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter API key" />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
            {fields.includes('sender_id') && (
              <div>
                <Label>{provider === 'twilio' ? 'Account SID / From Number' : 'Sender ID / DLT Header'}</Label>
                <Input value={senderId} onChange={e => setSenderId(e.target.value)} placeholder="Sender ID" />
              </div>
            )}
            {fields.includes('api_endpoint') && (
              <div>
                <Label>API Endpoint URL</Label>
                <Input value={apiEndpoint} onChange={e => setApiEndpoint(e.target.value)} placeholder="https://api.provider.com/v1/send" />
              </div>
            )}

            <div className="border-t pt-4 space-y-3">
              <div>
                <Label className="text-xs text-gray-500">Test Recipient Phone</Label>
                <Input value={testRecipient} onChange={e => setTestRecipient(e.target.value)} placeholder="e.g. 919876543210" />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleTest} disabled={testing || !apiKey} className="gap-2 flex-1">
                  {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Send Test SMS
                </Button>
                <Button onClick={handleSave} disabled={saving} className="gap-2 flex-1">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>
          </>
        )}

        {provider === 'none' && (
          <p className="text-sm text-gray-400 text-center py-4">Select a provider to configure RCS/SMS integration</p>
        )}
      </CardContent>
    </Card>
  );
}