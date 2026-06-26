import React, { useState } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CheckCircle2, XCircle, Loader2, Eye, EyeOff, Send } from 'lucide-react';
import { toast } from 'sonner';

export default function PlatformConfigCard({ config, onSaved }) {
  const [provider, setProvider] = useState(config?.whatsapp_provider || 'rcs_digital');
  const [apiKey, setApiKey] = useState(config?.whatsapp_api_key || '');
  const [phoneNumberId, setPhoneNumberId] = useState(config?.whatsapp_phone_number_id || '');
  const [businessId, setBusinessId] = useState(config?.whatsapp_business_id || '');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lifecycleEnabled, setLifecycleEnabled] = useState(config?.lifecycle_enabled || false);

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await apiClient.functions.invoke('testPlatformWhatsAppConnection', {
        provider, api_key: apiKey, phone_number_id: phoneNumberId, business_id: businessId
      });
      if (res.data.success) toast.success(res.data.message);
      else toast.error(res.data.error || 'Connection failed');
      onSaved && onSaved();
    } catch (e) { toast.error(e.message); }
    setTesting(false);
  };

  const handleLifecycleToggle = async (val) => {
    setLifecycleEnabled(val);
    try {
      if (config?.id) {
        await apiClient.PlatformMessagingConfig.update(config.id, { lifecycle_enabled: val });
      }
      onSaved && onSaved();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Platform WhatsApp Connection</CardTitle>
          <Badge className={config?.whatsapp_status === 'connected' ? 'bg-green-100 text-green-800' : config?.whatsapp_status === 'error' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}>
            {config?.whatsapp_status === 'connected' ? <><CheckCircle2 className="w-3 h-3 mr-1 inline" /> Connected</> : config?.whatsapp_status === 'error' ? <><XCircle className="w-3 h-3 mr-1 inline" /> Error</> : 'Disconnected'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label>Provider</Label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="rcs_digital">RCS Digital (Meta-compatible)</SelectItem>
              <SelectItem value="meta_cloud">Meta Cloud API (Official)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Bearer Token / Access Token</Label>
          <div className="relative">
            <Input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter Bearer token" />
            <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <Label>Phone Number ID</Label>
          <Input value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} placeholder="e.g. 919876543210" />
        </div>
        <div>
          <Label>WABA ID (Business Account ID)</Label>
          <Input value={businessId} onChange={e => setBusinessId(e.target.value)} placeholder="WhatsApp Business Account ID" />
        </div>

        <div className="flex items-center justify-between border-t pt-4">
          <div>
            <p className="font-medium text-sm">Lifecycle Nudges Enabled</p>
            <p className="text-xs text-gray-500">Master toggle for automated welcome/onboarding/trial WhatsApp messages</p>
          </div>
          <Switch checked={lifecycleEnabled} onCheckedChange={handleLifecycleToggle} disabled={config?.whatsapp_status !== 'connected'} />
        </div>

        <Button onClick={handleTest} disabled={testing || !apiKey || !phoneNumberId} className="w-full gap-2">
          {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Save & Test Connection
        </Button>
        {config?.whatsapp_last_tested && (
          <p className="text-xs text-gray-400 text-center">Last tested: {new Date(config.whatsapp_last_tested).toLocaleString()}</p>
        )}
      </CardContent>
    </Card>
  );
}