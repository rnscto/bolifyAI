import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { base44 } from '@/api/base44Client';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';

export default function APIDocs() {
  const [denoUrl, setDenoUrl] = useState('Loading...');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDenoUrl();
  }, []);

  const fetchDenoUrl = async () => {
    try {
      const response = await base44.functions.invoke('getDenoUrl', {});
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

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard!');
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">API Documentation</h1>
        <p className="text-gray-600 mt-1">WebSocket and REST API integration guide</p>
      </div>

      <Card className="border-blue-200 bg-blue-50">
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

      <Card>
        <CardHeader>
          <CardTitle>REST API Endpoints</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-green-100 text-green-800">POST</Badge>
              <code className="text-sm">/api/functions/initiateCall</code>
            </div>
            <p className="text-sm text-gray-600 mb-2">Initiate an outbound call</p>
            <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "lead_id": "lead_123",
  "agent_id": "agent_456",
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

      <Card>
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 mb-3">
            All API requests must include authentication. WebSocket connections are authenticated via the Base44 SDK.
          </p>
          <code className="block bg-gray-100 p-3 rounded text-sm">
            Authorization: Bearer YOUR_API_TOKEN
          </code>
        </CardContent>
      </Card>
    </div>
  );
}