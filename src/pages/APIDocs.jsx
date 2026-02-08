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
          <CardTitle>Fixed WebSocket URL Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">1. Get Your Deno Deploy URL</h3>
            <p className="text-sm text-gray-600 mb-2">
              After deploying streamAudio function, you'll get a stable URL like:
            </p>
            <code className="block bg-white p-3 rounded text-sm border border-blue-200 font-mono">
              wss://bright-sheep-33-d6ddv4gx2w8b.deno.dev/api/functions/streamAudio
            </code>
          </div>
          <div>
            <h3 className="font-semibold mb-2">2. Configure in Agent Settings</h3>
            <p className="text-sm text-gray-600">
              Copy this URL to each agent's WebSocket URL field. This URL remains fixed even when you update the function code.
            </p>
          </div>
          <div>
            <h3 className="font-semibold mb-2">3. How It Works</h3>
            <p className="text-sm text-gray-600">
              System automatically appends ?call_sid=[call_id] when initiating calls to Smartflo.
            </p>
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