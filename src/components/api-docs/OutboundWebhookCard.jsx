import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bell } from 'lucide-react';

export default function OutboundWebhookCard() {
  return (
    <Card id="crm-outbound" className="border-orange-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="w-5 h-5 text-orange-600" />
          Outbound Webhooks — Receive Events from Bolify
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">
          After every completed call, Bolify automatically POSTs events to the <strong>Webhook URL</strong> you configured in CRM Integration. No code required on your side beyond receiving the POST.
        </p>

        <div className="bg-orange-50 border border-orange-200 rounded p-3">
          <p className="text-sm text-orange-900 font-semibold mb-1">📋 Setup (3 steps)</p>
          <ol className="text-sm text-orange-800 space-y-1 ml-4 list-decimal">
            <li>Build an endpoint on your CRM that accepts <code className="bg-white px-1 rounded">POST application/json</code></li>
            <li>Go to <strong>CRM Integration</strong> page → Add Integration → paste your endpoint URL into <strong>Webhook URL</strong></li>
            <li>Bolify will start pushing events within 5 minutes of each completed call</li>
          </ol>
        </div>

        <div>
          <h4 className="font-semibold text-sm mb-2">Event Types Sent Automatically</h4>
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-green-100 text-green-800">call_completed</Badge>
            <Badge className="bg-blue-100 text-blue-800">lead_updated</Badge>
          </div>
        </div>

        <div>
          <h4 className="font-semibold text-sm mb-1">Payload — call_completed</h4>
          <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`POST <your-webhook-url>
Headers: { "x-api-key": "<your-api-key>", "Content-Type": "application/json" }
Body:
{
  "event": "call_completed",
  "timestamp": "2026-05-27T12:00:00.000Z",
  "source": "bolify_ai",
  "entity_id": "calllog_abc123",
  "data": {
    "client_id": "client_xyz",
    "agent_id": "agent_456",
    "lead_id": "lead_789",
    "caller_id": "918065489191",
    "callee_number": "9876543210",
    "direction": "outbound",
    "duration": 180,
    "status": "completed",
    "recording_url": "https://...mp3",
    "transcript": "Customer: Hi...\\nAI: Hello...",
    "conversation_summary": "Customer interested in pricing. Asked for callback.",
    "lead_status_updated": "interested",
    "call_start_time": "2026-05-27T11:57:00.000Z",
    "call_end_time": "2026-05-27T12:00:00.000Z"
  }
}`}
          </pre>
        </div>

        <div>
          <h4 className="font-semibold text-sm mb-1">Payload — lead_updated</h4>
          <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "event": "lead_updated",
  "timestamp": "2026-05-27T12:00:05.000Z",
  "source": "bolify_ai",
  "entity_id": "lead_789",
  "data": {
    "client_id": "client_xyz",
    "name": "Rahul Sharma",
    "phone": "9876543210",
    "status": "interested",
    "score": 78,
    "sentiment": "positive",
    "qualification_tier": "hot",
    "intent_signals": ["pricing", "callback_request"],
    "last_call_date": "2026-05-27T12:00:00.000Z"
  }
}`}
          </pre>
        </div>

        <div>
          <h4 className="font-semibold text-sm mb-1">Your endpoint must return</h4>
          <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`HTTP/1.1 200 OK
Content-Type: application/json

{ "received": true }`}
          </pre>
          <p className="text-xs text-gray-500 mt-1">Any 2xx response is treated as success. Any non-2xx or timeout (&gt;5s) triggers retry.</p>
        </div>

        <div className="bg-green-50 border border-green-200 rounded p-3">
          <p className="text-sm font-semibold text-green-900 mb-1">🛡️ Delivery Guarantees (Production-Grade)</p>
          <ul className="text-sm text-green-800 space-y-1 ml-4 list-disc">
            <li><strong>5-second timeout</strong> per webhook delivery — slow endpoints won't block other clients</li>
            <li><strong>Exponential backoff retry</strong>: 1 min → 5 min → 30 min → 2 hr → 6 hr</li>
            <li><strong>Max 6 attempts</strong>, then dead-lettered (admin gets logged error)</li>
            <li><strong>At-least-once delivery</strong> — deduplicate using <code className="bg-white px-1 rounded">entity_id</code></li>
            <li><strong>24-hour safety window</strong> — events older than 24h are not pushed on first deploy</li>
          </ul>
        </div>

        <div>
          <h4 className="font-semibold text-sm mb-1">Example Receiver — Node.js / Express</h4>
          <pre className="bg-gray-900 text-green-400 p-3 rounded text-sm overflow-x-auto">
{`app.post('/bolify-webhook', (req, res) => {
  // Verify the source via API key
  if (req.headers['x-api-key'] !== process.env.BOLIFY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { event, entity_id, data } = req.body;

  // Idempotency: skip if already processed
  if (await db.events.exists(entity_id)) return res.json({ received: true });

  if (event === 'call_completed') {
    await crm.addCallNote(data.lead_id, data.conversation_summary);
  } else if (event === 'lead_updated') {
    await crm.updateLeadStatus(data.phone, data.status, data.score);
  }

  await db.events.markProcessed(entity_id);
  res.json({ received: true });
});`}
          </pre>
        </div>

        <div className="border-t pt-3">
          <h4 className="font-semibold text-sm mb-1">Manual trigger (advanced)</h4>
          <p className="text-xs text-gray-600 mb-2">You can also manually trigger a single push (useful for replaying events):</p>
          <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`POST /functions/crmOutboundPush
Headers: { "x-auth-key": "<your-platform-key>" }
Body: { "event_type": "call_completed", "entity_id": "calllog_abc123" }`}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}