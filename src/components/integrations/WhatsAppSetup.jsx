import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MessageSquare, CheckCircle2, XCircle, Loader2, Send, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import AddInteraktTemplateForm from './AddInteraktTemplateForm';

const PROVIDERS = [
  { value: 'none', label: 'Not Connected' },
  { value: 'rcs_digital', label: 'RCS Digital (Meta-compatible)', fields: ['api_key', 'phone_number_id', 'business_id', 'api_endpoint'] },
  { value: 'meta_cloud', label: 'Meta Cloud API (Official)', fields: ['api_key', 'phone_number_id', 'business_id'] },
  { value: 'gupshup', label: 'Gupshup', fields: ['api_key', 'phone_number_id', 'business_id'] },
  { value: 'aisensy', label: 'AiSensy', fields: ['api_key', 'phone_number_id', 'api_endpoint'] },
  { value: 'wati', label: 'WATI', fields: ['api_key', 'phone_number_id', 'api_endpoint'] },
  { value: 'interakt', label: 'Interakt', fields: ['api_key', 'api_endpoint'] },
  { value: 'twilio', label: 'Twilio', fields: ['api_key', 'phone_number_id', 'business_id'] },
  { value: 'valuefirst', label: 'ValueFirst', fields: ['api_key', 'phone_number_id', 'api_endpoint'] },
];

const FIELD_LABELS = {
  api_key: { meta_cloud: 'Access Token', gupshup: 'API Key', twilio: 'Auth Token', rcs_digital: 'Bearer Token / API Key', interakt: 'Interakt Secret Key (Developer Settings)', default: 'API Key / Token' },
  phone_number_id: { meta_cloud: 'Phone Number ID', rcs_digital: 'Phone Number ID', twilio: 'WhatsApp Number (+91...)', default: 'Sender Phone Number' },
  business_id: { meta_cloud: 'WhatsApp Business Account ID', rcs_digital: 'WhatsApp Business Account ID', twilio: 'Account SID', gupshup: 'App Name', default: 'Business / App ID' },
  api_endpoint: { rcs_digital: 'Custom API Host (optional, e.g. https://icpaas.in)', interakt: 'Custom API Host (optional, default https://api.interakt.ai)', default: 'API Endpoint URL' },
};

const getLabel = (field, provider) => FIELD_LABELS[field]?.[provider] || FIELD_LABELS[field]?.default || field;

export default function WhatsAppSetup({ config, onSave }) {
  const [provider, setProvider] = useState(config?.whatsapp_provider || 'none');
  const [apiKey, setApiKey] = useState(config?.whatsapp_api_key || '');
  const [phoneNumberId, setPhoneNumberId] = useState(config?.whatsapp_phone_number_id || '');
  const [businessId, setBusinessId] = useState(config?.whatsapp_business_id || '');
  const [apiEndpoint, setApiEndpoint] = useState(config?.whatsapp_api_endpoint || '');
  const [testRecipient, setTestRecipient] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  const currentProvider = PROVIDERS.find(p => p.value === provider);
  const fields = currentProvider?.fields || [];

  // Re-sync local state when config prop arrives (config is null during initial page load).
  // Only sync on initial mount (when id first becomes available) — DO NOT re-sync on every config
  // change, otherwise typing a new value would get overwritten when parent re-renders.
  const [hasSynced, setHasSynced] = useState(false);
  useEffect(() => {
    if (config && !hasSynced) {
      setProvider(config.whatsapp_provider || 'none');
      setApiKey(config.whatsapp_api_key || '');
      setPhoneNumberId(config.whatsapp_phone_number_id || '');
      setBusinessId(config.whatsapp_business_id || '');
      setApiEndpoint(config.whatsapp_api_endpoint || '');
      setHasSynced(true);
    }
  }, [config, hasSynced]);

  // Load approved templates when Meta Cloud is selected and credentials exist
  const loadTemplates = () => {
    if (!config?.client_id) return;
    setLoadingTemplates(true);
    apiClient.WhatsAppTemplate.filter({ client_id: config.client_id, status: 'APPROVED' }, '-created_at', 100)
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setLoadingTemplates(false));
  };
  useEffect(() => {
    if (provider === 'meta_cloud' || provider === 'rcs_digital' || provider === 'interakt') {
      loadTemplates();
    }
  }, [provider, config?.client_id]);

  // Sanitize credentials before sending to backend (strip whitespace + accidental "Bearer " prefix)
  const cleanCreds = () => ({
    whatsapp_provider: provider,
    whatsapp_api_key: apiKey.trim().replace(/^Bearer\s+/i, ''),
    whatsapp_phone_number_id: phoneNumberId.trim(),
    whatsapp_business_id: businessId.trim(),
    whatsapp_api_endpoint: apiEndpoint.trim(),
  });

  const handleTest = async () => {
    setTesting(true);
    const tmpl = templates.find(t => t.id === selectedTemplate);
    const creds = cleanCreds();
    const res = await apiClient.functions.invoke('testMessagingConnection', {
      channel: 'whatsapp',
      test_recipient: testRecipient.trim(),
      template_name: tmpl?.name || '',
      template_language: tmpl?.language || (provider === 'interakt' ? 'en' : 'en_US'),
      config: creds
    });
    if (res.data.success) {
      toast.success(res.data.message);
      // Reflect cleaned values back to inputs
      setApiKey(creds.whatsapp_api_key);
      setPhoneNumberId(creds.whatsapp_phone_number_id);
      setBusinessId(creds.whatsapp_business_id);
      setApiEndpoint(creds.whatsapp_api_endpoint);
      await onSave({ ...creds, whatsapp_status: 'connected', whatsapp_last_tested: new Date().toISOString() });
    } else {
      toast.error(res.data.error || 'Connection failed', { duration: 8000 });
      await onSave({ ...creds, whatsapp_status: 'error', whatsapp_last_tested: new Date().toISOString() });
    }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const creds = cleanCreds();
    setApiKey(creds.whatsapp_api_key);
    setPhoneNumberId(creds.whatsapp_phone_number_id);
    setBusinessId(creds.whatsapp_business_id);
    setApiEndpoint(creds.whatsapp_api_endpoint);
    await onSave({
      ...creds,
      whatsapp_status: provider === 'none' ? 'disconnected' : (config?.whatsapp_status || 'disconnected'),
    });
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="w-5 h-5 text-green-600" /> WhatsApp Business API
          </CardTitle>
          <Badge className={config?.whatsapp_status === 'connected' ? 'bg-green-100 text-green-800' : config?.whatsapp_status === 'error' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}>
            {config?.whatsapp_status === 'connected' ? <><CheckCircle2 className="w-3 h-3 mr-1" /> Connected</> : config?.whatsapp_status === 'error' ? <><XCircle className="w-3 h-3 mr-1" /> Error</> : 'Disconnected'}
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
                <Label>{getLabel('api_key', provider)}</Label>
                <div className="relative">
                  <Input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter your API key or token" />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
            {fields.includes('phone_number_id') && (
              <div>
                <Label>{getLabel('phone_number_id', provider)}</Label>
                <Input value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} placeholder="e.g. 919876543210" />
              </div>
            )}
            {fields.includes('business_id') && (
              <div>
                <Label>{getLabel('business_id', provider)}</Label>
                <Input value={businessId} onChange={e => setBusinessId(e.target.value)} placeholder="Business / Account ID" />
              </div>
            )}
            {fields.includes('api_endpoint') && (
              <div>
                <Label>{getLabel('api_endpoint', provider)}</Label>
                <Input value={apiEndpoint} onChange={e => setApiEndpoint(e.target.value)} placeholder={provider === 'interakt' ? 'https://api.interakt.ai (leave blank for default)' : 'https://api.provider.com/v1/messages'} />
              </div>
            )}

            {provider === 'interakt' && (
              <div className="text-xs text-gray-600 bg-blue-50 border border-blue-100 rounded-md p-3 space-y-1.5">
                <p>📍 Get your <b>Secret Key</b> from <b>app.interakt.ai → Settings → Developer Settings</b>.</p>
                <p>⚠️ The API Key field must contain the <b>Secret Key</b> — NOT a web page link. Do not paste URLs like <code className="bg-white px-1 rounded">app.interakt.ai/contacts/list</code>.</p>
                <p>✅ Leave <b>Custom API Host blank</b> (we use the official https://api.interakt.ai automatically).</p>
                <p>📋 Interakt needs an <b>approved template</b> to send. Public APIs require a Growth plan or higher.</p>
              </div>
            )}

            <div className="border-t pt-4 space-y-3">
              <div>
                <Label className="text-xs text-gray-500">Test Recipient Phone (with country code)</Label>
                <Input value={testRecipient} onChange={e => setTestRecipient(e.target.value)} placeholder="e.g. 919876543210" />
              </div>

              {(provider === 'meta_cloud' || provider === 'rcs_digital' || provider === 'interakt') && (
                <div>
                  <Label className="text-xs text-gray-500">
                    Pick a template to test
                    {loadingTemplates && <span className="ml-2 text-gray-400">(loading...)</span>}
                  </Label>
                  <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
                    <SelectTrigger>
                      <SelectValue placeholder={templates.length === 0 ? 'No approved templates — will validate credentials only' : 'Select a template'} />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.length === 0 ? (
                        <div className="px-2 py-3 text-xs text-gray-500">
                          No approved templates yet. Sync from the WhatsApp Templates page.
                        </div>
                      ) : (
                        templates.map(t => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name} ({t.language})
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-400 mt-1">
                    {provider === 'interakt'
                      ? 'Interakt requires an approved template to send. Add yours by its code name below.'
                      : 'Meta requires a pre-approved template for the first message. Without one, we only validate your credentials.'}
                  </p>
                  {provider === 'interakt' && config?.client_id && (
                    <div className="mt-2">
                      <AddInteraktTemplateForm
                        clientId={config.client_id}
                        onAdded={(t) => { loadTemplates(); setSelectedTemplate(t.id); }}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="outline" onClick={handleTest} disabled={testing || !apiKey || (provider === 'interakt' && !selectedTemplate)} className="gap-2 flex-1">
                  {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {(provider === 'meta_cloud' || provider === 'rcs_digital') && !selectedTemplate ? 'Validate Credentials' : 'Send Test Message'}
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
          <p className="text-sm text-gray-400 text-center py-4">Select a provider to configure WhatsApp integration</p>
        )}
      </CardContent>
    </Card>
  );
}