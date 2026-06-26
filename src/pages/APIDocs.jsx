import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/api/apiClient';
import { Copy, Key, Eye, EyeOff, RefreshCw, Shield, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import QuickStartGuide from '@/components/api-docs/QuickStartGuide';
import DocsTOC from '@/components/api-docs/DocsTOC';
import ErrorCodesCard from '@/components/api-docs/ErrorCodesCard';
import OutboundWebhookCard from '@/components/api-docs/OutboundWebhookCard';

export default function APIDocs() {
  const [denoUrl, setDenoUrl] = useState('Loading...');
  const [loading, setLoading] = useState(true);
  const [authKey, setAuthKey] = useState(null);
  const [showAuthKey, setShowAuthKey] = useState(false);
  const [authKeyLoading, setAuthKeyLoading] = useState(true);
  const [generatingKey, setGeneratingKey] = useState(false);

  useEffect(() => {
    fetchDenoUrl();
    fetchAuthKey();
  }, []);

  const fetchDenoUrl = async () => {
    try {
      const response = await apiClient.functions.invoke('getDenoUrl', {});
      if (response.data?.deno_url) {
        setDenoUrl(response.data.deno_url);
      } else {
        setDenoUrl(response.data?.message || 'Unable to fetch Deno Deploy URL');
      }
    } catch (error) {
      console.error('Error fetching Deno URL:', error);
      setDenoUrl('Error fetching URL - Check function deployment');
    } finally {
      setLoading(false);
    }
  };

  const fetchAuthKey = async () => {
    try {
      const resp = await apiClient.functions.invoke('generateAuthKey', {});
      if (resp.data?.api_auth_key) {
        setAuthKey(resp.data.api_auth_key);
      }
    } catch (e) {
      console.error('Error fetching auth key:', e);
    } finally {
      setAuthKeyLoading(false);
    }
  };

  const handleGenerateAuthKey = async () => {
    setGeneratingKey(true);
    try {
      const resp = await apiClient.functions.invoke('generateAuthKey', { regenerate: true });
      if (resp.data?.api_auth_key) {
        setAuthKey(resp.data.api_auth_key);
        toast.success('Authorization key generated!');
      }
    } catch (e) {
      toast.error('Failed to generate key');
    } finally {
      setGeneratingKey(false);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard!');
  };

  return (
    <div className="flex gap-6 max-w-7xl">
      <DocsTOC />
      <div className="space-y-6 flex-1 min-w-0">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">API Documentation</h1>
        <p className="text-gray-600 mt-1">WebSocket and REST API integration guide</p>
      </div>

      <div id="quickstart">
        <QuickStartGuide />
      </div>

      <Card id="websocket" className="border-blue-200 bg-blue-50">
        <CardHeader>
          <CardTitle>⚙️ Your Fixed WebSocket URL</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded p-4">
            <p className="text-sm font-semibold text-green-900 mb-2">🎯 Copy this URL for your agents:</p>
            {loading ? (
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-600"></div>
                <span className="text-sm text-green-700">Fetching Deno Deploy URL...</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-white p-3 rounded text-sm border border-green-300 font-mono break-all">
                  {denoUrl}
                </code>
                <button
                  onClick={() => copyToClipboard(denoUrl)}
                  className="px-3 py-2 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1"
                >
                  <Copy className="w-4 h-4" />
                  Copy
                </button>
              </div>
            )}
          </div>
          
          <div>
            <h3 className="font-semibold mb-2">📋 How to use:</h3>
            <ol className="text-sm text-gray-600 space-y-1 ml-4 list-decimal">
              <li>Copy the URL above using the Copy button</li>
              <li>Go to Agents page</li>
              <li>Create or edit an agent</li>
              <li>Paste this URL in the "WebSocket URL" field</li>
              <li>Save the agent</li>
            </ol>
          </div>
          
          <div>
            <h3 className="font-semibold mb-2">✅ Important Notes:</h3>
            <ul className="text-sm text-gray-600 space-y-1 ml-4 list-disc">
              <li>This is your permanent Deno Deploy URL (ends with .deno.dev)</li>
              <li>It won't change when you update function code</li>
              <li>System automatically adds ?call_sid parameter when initiating calls</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>WebSocket Audio Streaming</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">Full Connection URL Format</h3>
            <code className="block bg-gray-100 p-3 rounded text-sm">
              wss://{window.location.host}/api/functions/streamAudio?call_sid=[call_sid]
            </code>
          </div>

          <div>
            <h3 className="font-semibold mb-2">Message Format</h3>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`// Incoming audio from caller
{
  "event": "media",
  "media": {
    "payload": "base64_encoded_audio"
  }
}

// Outgoing audio to caller
{
  "event": "media",
  "media": {
    "payload": "base64_encoded_audio"
  }
}`}
            </pre>
          </div>

          <div>
            <h3 className="font-semibold mb-2">Events</h3>
            <ul className="space-y-2 text-sm">
              <li><Badge variant="outline">connected</Badge> - Stream established</li>
              <li><Badge variant="outline">media</Badge> - Audio data transfer</li>
              <li><Badge variant="outline">stop</Badge> - Stream terminated</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card id="rest-core">
        <CardHeader>
          <CardTitle>REST API Endpoints</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-green-100 text-green-800">POST</Badge>
              <code className="text-sm">/api/functions/initiateCall</code>
            </div>
            <p className="text-sm text-gray-600 mb-2">Initiate an outbound call. Use the <code className="bg-gray-200 px-1 rounded text-xs">x-auth-key</code> header (your platform <code className="bg-gray-200 px-1 rounded text-xs">gwk_…</code> key) for external API access.</p>
            <div className="bg-yellow-50 border border-yellow-200 rounded p-3 mb-3 text-sm text-yellow-800">
              <strong>💡 Flexible identifiers:</strong> You can use either record IDs or phone numbers:
              <ul className="ml-4 mt-1 list-disc space-y-0.5">
                <li><strong>agent_id</strong> (Base44 record ID) OR <strong>agent_did</strong> (DID phone number assigned to agent)</li>
                <li><strong>lead_id</strong> (Base44 record ID) OR just <strong>phone_number</strong> (lead is auto-matched or created)</li>
              </ul>
            </div>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`Headers: { "x-auth-key": "your-platform-key" }

// Option 1: Using phone numbers (recommended for CRM integrations)
{
  "agent_did": "0507279030004",
  "phone_number": "9355521144"
}

// Option 2: Using record IDs
{
  "lead_id": "rec_abc123",
  "agent_id": "rec_xyz456",
  "phone_number": "+911234567890"
}`}
            </pre>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-green-100 text-green-800">POST</Badge>
              <code className="text-sm">/api/functions/smartfloWebhook</code>
            </div>
            <p className="text-sm text-gray-600 mb-2">Receive call status updates from Smartflo</p>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "call_sid": "call_123",
  "status": "completed",
  "duration": 180,
  "recording_url": "https://..."
}`}
            </pre>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-green-100 text-green-800">POST</Badge>
              <code className="text-sm">/api/functions/processTranscript</code>
            </div>
            <p className="text-sm text-gray-600 mb-2">Process call recording and generate transcript</p>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "call_log_id": "log_123",
  "recording_url": "https://..."
}`}
            </pre>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Azure Services Integration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <h3 className="font-semibold mb-1">Azure OpenAI Realtime (gpt-realtime-mini)</h3>
                <p className="text-sm text-gray-600">
                  Speech-to-speech model with built-in STT/TTS. Handles real-time voice conversations with ultra-low latency.
                </p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Smartflo Telecom</h3>
            <p className="text-sm text-gray-600">
              Manages call routing, WebSocket audio streaming, and telephony infrastructure.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ─── CRM API SECTION ─── */}
      <div id="auth-keys" className="pt-4">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">CRM Integration APIs</h2>
        <p className="text-gray-600 mb-4">Connect any external CRM to push/pull data via JSON REST APIs. <strong>Use your Platform Authorization Key (<code className="bg-gray-100 px-1 rounded">gwk_…</code>) in the <code className="bg-gray-100 px-1 rounded">x-auth-key</code> header for all requests.</strong></p>
      </div>

      {/* Platform Authorization Key */}
      <Card className="border-emerald-300 bg-emerald-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-emerald-700" />
            Your Platform Authorization Key
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-emerald-800">
            This is the <strong>only key</strong> you need. Use it in the <code className="bg-white px-1.5 py-0.5 rounded border border-emerald-200 text-xs">x-auth-key</code> header for <strong>all</strong> API requests (call initiation and CRM push/pull) when integrating Bolify AI into your CRM or any third-party system. It starts with <code className="bg-white px-1.5 py-0.5 rounded border border-emerald-200 text-xs">gwk_</code>.
          </p>
          {authKeyLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
              <span className="text-sm text-emerald-700">Loading...</span>
            </div>
          ) : authKey ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-white p-3 rounded text-sm border border-emerald-300 font-mono break-all">
                  {showAuthKey ? authKey : '••••••••••••••••••••••••••••••••••••••••'}
                </code>
                <button onClick={() => setShowAuthKey(!showAuthKey)} className="px-2 py-2 bg-white border border-emerald-300 rounded hover:bg-emerald-50">
                  {showAuthKey ? <EyeOff className="w-4 h-4 text-emerald-700" /> : <Eye className="w-4 h-4 text-emerald-700" />}
                </button>
                <button onClick={() => copyToClipboard(authKey)} className="px-3 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 flex items-center gap-1">
                  <Copy className="w-4 h-4" /> Copy
                </button>
              </div>
              <Button variant="outline" size="sm" onClick={handleGenerateAuthKey} disabled={generatingKey} className="text-emerald-700 border-emerald-300 hover:bg-emerald-100">
                {generatingKey ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                Regenerate Key
              </Button>
              <p className="text-xs text-emerald-600">⚠️ Regenerating will invalidate the old key. Update all your integrations.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-emerald-800">No key generated yet. Click below to create your authorization key.</p>
              <Button onClick={handleGenerateAuthKey} disabled={generatingKey} className="bg-emerald-600 hover:bg-emerald-700">
                {generatingKey ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Key className="w-4 h-4 mr-1" />}
                Generate Authorization Key
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-purple-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Badge className="bg-purple-100 text-purple-800">CRM Auth</Badge>
            Authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-gray-600">
            All CRM API endpoints authenticate using your <strong>Platform Authorization Key</strong> (the <code className="bg-gray-100 px-1 rounded">gwk_…</code> key shown above) passed in the <code className="bg-gray-100 px-1 rounded">x-auth-key</code> header. Each key is scoped to a single client account.
          </p>
          <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "Content-Type": "application/json",
  "x-auth-key": "${authKey || 'your-platform-auth-key'}"
}`}
          </pre>
        </CardContent>
      </Card>

      {/* INBOUND: Push data TO platform */}
      <Card id="crm-inbound">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Badge className="bg-green-100 text-green-800">POST</Badge>
            /functions/crmInbound — Push Data to Platform
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">External CRM pushes leads, contacts, deals, or activities into your Bolify AI platform.</p>
          
          <div>
            <h4 className="font-semibold text-sm mb-2">Supported Actions</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {['create_lead', 'update_lead', 'create_contact', 'create_deal', 'update_deal', 'create_activity'].map(a => (
                <Badge key={a} variant="outline" className="justify-center">{a}</Badge>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">Create Lead</h4>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`POST /functions/crmInbound
Headers: { "x-auth-key": "your-platform-key" }
Body:
{
  "action": "create_lead",
  "data": {
    "name": "Rahul Sharma",
    "phone": "9876543210",
    "email": "rahul@example.com",
    "company": "ABC Corp",
    "source": "website",
    "notes": "Interested in AI calling",
    "tags": ["hot", "enterprise"]
  }
}`}
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">Update Lead (by phone or id)</h4>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "action": "update_lead",
  "data": {
    "phone": "9876543210",
    "status": "interested",
    "notes": "Follow up next week"
  }
}`}
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">Create Deal</h4>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "action": "create_deal",
  "data": {
    "title": "Enterprise Plan - ABC Corp",
    "value": 150000,
    "currency": "INR",
    "stage": "negotiation",
    "lead_id": "lead_abc123",
    "expected_close_date": "2026-05-15"
  }
}`}
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">Create Activity</h4>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "action": "create_activity",
  "data": {
    "type": "followup",
    "title": "Call back Rahul",
    "scheduled_date": "2026-04-10T10:00:00.000Z",
    "lead_id": "lead_abc123",
    "priority": "high"
  }
}`}
            </pre>
          </div>

          <div className="bg-green-50 border border-green-200 rounded p-3">
            <p className="text-sm text-green-800"><strong>Response:</strong></p>
            <pre className="text-sm text-green-900 mt-1">
{`{ "success": true, "action": "create_lead", "id": "rec_xyz", "data": {...} }`}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* FETCH: Pull data FROM platform */}
      <Card id="crm-fetch">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Badge className="bg-blue-100 text-blue-800">POST</Badge>
            /functions/crmFetchData — Pull Data from Platform
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">External CRM pulls leads, contacts, deals, call logs, or activities from your platform as JSON.</p>
          
          <div>
            <h4 className="font-semibold text-sm mb-2">Supported Entities</h4>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {['leads', 'contacts', 'deals', 'call_logs', 'activities'].map(e => (
                <Badge key={e} variant="outline" className="justify-center">{e}</Badge>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">Fetch Leads (with filters)</h4>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`POST /functions/crmFetchData
Headers: { "x-auth-key": "your-platform-key" }
Body:
{
  "entity": "leads",
  "filters": { "status": "interested" },
  "limit": 50,
  "sort": "-created_at"
}`}
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">Fetch Call Logs</h4>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "entity": "call_logs",
  "filters": { "status": "completed" },
  "limit": 100
}`}
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">Fetch Deals</h4>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "entity": "deals",
  "filters": { "status": "open" },
  "sort": "-value"
}`}
            </pre>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded p-3">
            <p className="text-sm text-blue-800"><strong>Response:</strong></p>
            <pre className="text-sm text-blue-900 mt-1">
{`{
  "success": true,
  "entity": "leads",
  "count": 25,
  "data": [
    { "id": "rec_1", "name": "Rahul", "phone": "98765...", "status": "interested", ... },
    ...
  ]
}`}
            </pre>
          </div>
        </CardContent>
      </Card>

      <OutboundWebhookCard />

      <ErrorCodesCard />

      {/* Field Mapping */}
      <Card>
        <CardHeader>
          <CardTitle>Field Mapping (Optional)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-gray-600">
            If your CRM uses different field names, configure field mapping in your CRM Integration settings. 
            The mapping translates between your CRM's field names and Bolify AI's internal fields.
          </p>
          <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`// Example field_mapping in CRM Integration settings:
{
  "create_lead": {
    "full_name": "name",        // CRM sends "full_name" → mapped to "name"
    "mobile": "phone",          // CRM sends "mobile" → mapped to "phone"
    "organisation": "company"   // CRM sends "organisation" → mapped to "company"
  },
  "outbound": {
    "name": "contact_name",     // Internal "name" → sent as "contact_name" to CRM
    "phone": "mobile_number"    // Internal "phone" → sent as "mobile_number" to CRM
  }
}`}
          </pre>
        </CardContent>
      </Card>

      <Card id="examples">
        <CardHeader>
          <CardTitle>Quick Integration Examples</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="font-semibold text-sm mb-1">cURL — Create Lead</h4>
            <pre className="bg-gray-900 text-green-400 p-3 rounded text-sm overflow-x-auto">
{`curl -X POST ${denoUrl.replace('wss://', 'https://').replace('/functions/streamAudio', '/functions/crmInbound')} \\
  -H "Content-Type: application/json" \\
  -H "x-auth-key: ${authKey || 'your-platform-auth-key'}" \\
  -d '{"action":"create_lead","data":{"name":"Test Lead","phone":"9876543210"}}'`}
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">cURL — Fetch Leads</h4>
            <pre className="bg-gray-900 text-green-400 p-3 rounded text-sm overflow-x-auto">
{`curl -X POST ${denoUrl.replace('wss://', 'https://').replace('/functions/streamAudio', '/functions/crmFetchData')} \\
  -H "Content-Type: application/json" \\
  -H "x-auth-key: ${authKey || 'your-platform-auth-key'}" \\
  -d '{"entity":"leads","filters":{"status":"interested"},"limit":20}'`}
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">Python</h4>
            <pre className="bg-gray-900 text-green-400 p-3 rounded text-sm overflow-x-auto">
{`import requests

url = "${denoUrl.replace('wss://', 'https://').replace('/functions/streamAudio', '/functions/crmInbound')}"
headers = {"Content-Type": "application/json", "x-auth-key": "${authKey || 'your-platform-auth-key'}"}

# Push a lead
resp = requests.post(url, json={
    "action": "create_lead",
    "data": {"name": "Rahul", "phone": "9876543210", "source": "website"}
}, headers=headers)
print(resp.json())`}
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-1">JavaScript / Node.js</h4>
            <pre className="bg-gray-900 text-green-400 p-3 rounded text-sm overflow-x-auto">
{`const resp = await fetch("${denoUrl.replace('wss://', 'https://').replace('/functions/streamAudio', '/functions/crmFetchData')}", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-auth-key": "${authKey || 'your-platform-auth-key'}" },
  body: JSON.stringify({ entity: "call_logs", filters: { status: "completed" }, limit: 50 })
});
const data = await resp.json();
console.log(data);`}
            </pre>
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}