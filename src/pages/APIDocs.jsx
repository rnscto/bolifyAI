import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function APIDocs() {
  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">API Documentation</h1>
        <p className="text-gray-600 mt-1">WebSocket and REST API integration guide</p>
      </div>

      <Card className="border-blue-200 bg-blue-50">
        <CardHeader>
          <CardTitle>⚙️ Fixed WebSocket URL Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-yellow-50 border border-yellow-200 rounded p-3 mb-3">
            <p className="text-sm font-semibold text-yellow-900 mb-1">📍 How to get YOUR Deno Deploy URL (ending with .deno.dev):</p>
            <ol className="text-sm text-yellow-800 space-y-1 ml-4 list-decimal">
              <li>Go to Base44 Dashboard → Code → Functions → streamAudio</li>
              <li>Look for deployment logs or function details section</li>
              <li>Find the Deno Deploy URL that ends with <code className="bg-white px-1">.deno.dev</code></li>
              <li>Or check your Deno Deploy dashboard at <a href="https://dash.deno.com" target="_blank" className="text-blue-600 underline">dash.deno.com</a></li>
              <li>The URL format: <code className="bg-white px-1">https://xxxxx-xxxxx-xx.deno.dev/api/functions/streamAudio</code></li>
              <li>Change <code className="bg-white px-1">https://</code> to <code className="bg-white px-1">wss://</code></li>
            </ol>
          </div>
          
          <div>
            <h3 className="font-semibold mb-2">⚠️ Important - Use DENO.DEV URL, not Base44 URL:</h3>
            <div className="space-y-2 text-sm">
              <div className="bg-green-50 border border-green-200 rounded p-2">
                <p className="font-semibold text-green-900">✅ CORRECT (ends with .deno.dev):</p>
                <code className="block bg-white p-2 rounded mt-1 text-xs break-all">
                  wss://bright-sheep-33-d6ddv4gx2w8b.deno.dev/api/functions/streamAudio
                </code>
              </div>
              <div className="bg-red-50 border border-red-200 rounded p-2">
                <p className="font-semibold text-red-900">❌ WRONG (base44.app URL):</p>
                <code className="block bg-white p-2 rounded mt-1 text-xs break-all">
                  wss://misty-aura-call-pro.base44.app/api/apps/.../functions/streamAudio
                </code>
              </div>
            </div>
          </div>
          
          <div>
            <h3 className="font-semibold mb-2">✅ Why Deno Deploy URL?</h3>
            <ul className="text-sm text-gray-600 space-y-1 ml-4 list-disc">
              <li>Direct connection to Deno Deploy is faster and more stable</li>
              <li>This URL is permanent and won't change on function updates</li>
              <li>System automatically adds ?call_sid parameter when calling</li>
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
            <h3 className="font-semibold mb-1">Azure OpenAI GPT-5.2</h3>
            <p className="text-sm text-gray-600">
              Powers conversational AI with advanced language understanding and response generation.
            </p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Azure Custom Voice</h3>
            <p className="text-sm text-gray-600">
              Provides Speech-to-Text (STT) and Text-to-Speech (TTS) for real-time voice interactions.
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