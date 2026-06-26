import React, { useState } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mail, CheckCircle2, XCircle, Loader2, Send, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';

const PROVIDERS = [
  { value: 'none', label: 'Not Connected' },
  { value: 'smtp', label: 'SMTP (Universal)', fields: ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'from_address', 'from_name'] },
  { value: 'resend', label: 'Resend', fields: ['api_key', 'from_address', 'from_name', 'domain'] },
  { value: 'sendgrid', label: 'SendGrid', fields: ['api_key', 'from_address', 'from_name'] },
  { value: 'mailgun', label: 'Mailgun', fields: ['api_key', 'from_address', 'from_name', 'domain'] },
  { value: 'postmark', label: 'Postmark', fields: ['api_key', 'from_address', 'from_name'] },
  { value: 'ses', label: 'AWS SES (via SMTP)', fields: ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'from_address', 'from_name'] },
];

export default function EmailSetup({ config, onSave }) {
  const [provider, setProvider] = useState(config?.email_provider || 'none');
  const [apiKey, setApiKey] = useState(config?.email_api_key || '');
  const [smtpHost, setSmtpHost] = useState(config?.email_smtp_host || '');
  const [smtpPort, setSmtpPort] = useState(config?.email_smtp_port || 587);
  const [smtpUser, setSmtpUser] = useState(config?.email_smtp_user || '');
  const [smtpPass, setSmtpPass] = useState(config?.email_smtp_pass || '');
  const [fromAddress, setFromAddress] = useState(config?.email_from_address || '');
  const [fromName, setFromName] = useState(config?.email_from_name || '');
  const [domain, setDomain] = useState(config?.email_domain || '');
  const [testRecipient, setTestRecipient] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const currentProvider = PROVIDERS.find(p => p.value === provider);
  const fields = currentProvider?.fields || [];

  const handleTest = async () => {
    if (!testRecipient) {
      toast.error('Enter a test recipient email first');
      return;
    }
    setTesting(true);
    const res = await apiClient.functions.invoke('testMessagingConnection', {
      channel: 'email',
      test_recipient: testRecipient,
      config: {
        email_provider: provider, email_api_key: apiKey,
        email_smtp_host: smtpHost, email_smtp_port: smtpPort, email_smtp_user: smtpUser, email_smtp_pass: smtpPass,
        email_from_address: fromAddress, email_from_name: fromName, email_domain: domain
      }
    });
    if (res.data.success) {
      toast.success(res.data.message);
      // Auto-save with 'connected' status on successful test
      await onSave({
        email_provider: provider, email_api_key: apiKey,
        email_smtp_host: smtpHost, email_smtp_port: smtpPort, email_smtp_user: smtpUser, email_smtp_pass: smtpPass,
        email_from_address: fromAddress, email_from_name: fromName, email_domain: domain,
        email_status: 'connected',
      });
    } else {
      toast.error(res.data.error || 'Connection failed');
      await onSave({
        email_provider: provider, email_api_key: apiKey,
        email_smtp_host: smtpHost, email_smtp_port: smtpPort, email_smtp_user: smtpUser, email_smtp_pass: smtpPass,
        email_from_address: fromAddress, email_from_name: fromName, email_domain: domain,
        email_status: 'error',
      });
    }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      email_provider: provider, email_api_key: apiKey,
      email_smtp_host: smtpHost, email_smtp_port: smtpPort, email_smtp_user: smtpUser, email_smtp_pass: smtpPass,
      email_from_address: fromAddress, email_from_name: fromName, email_domain: domain,
      email_status: provider === 'none' ? 'disconnected' : (config?.email_status || 'disconnected'),
    });
    toast.success('Settings saved. Run "Send Test Email" to verify and mark as connected.');
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="w-5 h-5 text-blue-600" /> Email
          </CardTitle>
          <Badge className={config?.email_status === 'connected' ? 'bg-green-100 text-green-800' : config?.email_status === 'error' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}>
            {config?.email_status === 'connected' ? <><CheckCircle2 className="w-3 h-3 mr-1" /> Connected</> : config?.email_status === 'error' ? <><XCircle className="w-3 h-3 mr-1" /> Error</> : 'Disconnected'}
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
                <Label>{provider === 'postmark' ? 'Server Token' : 'API Key'}</Label>
                <div className="relative">
                  <Input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter API key" />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
            {fields.includes('smtp_host') && (
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Label>SMTP Host</Label>
                  <Input value={smtpHost} onChange={e => setSmtpHost(e.target.value)} placeholder="smtp.gmail.com" />
                </div>
                <div>
                  <Label>Port</Label>
                  <Input type="number" value={smtpPort} onChange={e => setSmtpPort(parseInt(e.target.value) || 587)} />
                </div>
              </div>
            )}
            {fields.includes('smtp_user') && (
              <div>
                <Label>SMTP Username</Label>
                <Input value={smtpUser} onChange={e => setSmtpUser(e.target.value)} placeholder="username" />
              </div>
            )}
            {fields.includes('smtp_pass') && (
              <div>
                <Label>SMTP Password</Label>
                <div className="relative">
                  <Input type={showKey ? 'text' : 'password'} value={smtpPass} onChange={e => setSmtpPass(e.target.value)} placeholder="password" />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
            {fields.includes('domain') && (
              <div>
                <Label>Verified Domain</Label>
                <Input value={domain} onChange={e => setDomain(e.target.value)} placeholder="yourdomain.com" />
              </div>
            )}
            {fields.includes('from_address') && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>From Email</Label>
                  <Input value={fromAddress} onChange={e => setFromAddress(e.target.value)} placeholder="noreply@yourdomain.com" />
                </div>
                <div>
                  <Label>From Name</Label>
                  <Input value={fromName} onChange={e => setFromName(e.target.value)} placeholder="Your Company" />
                </div>
              </div>
            )}

            <div className="border-t pt-4 space-y-3">
              <div>
                <Label className="text-xs text-gray-500">Test Recipient Email</Label>
                <Input type="email" value={testRecipient} onChange={e => setTestRecipient(e.target.value)} placeholder="test@example.com" />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleTest} disabled={testing} className="gap-2 flex-1">
                  {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Send Test Email
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
          <p className="text-sm text-gray-400 text-center py-4">Select a provider to configure email integration</p>
        )}
      </CardContent>
    </Card>
  );
}