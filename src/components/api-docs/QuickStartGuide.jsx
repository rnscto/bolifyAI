import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Rocket, CheckCircle2 } from 'lucide-react';

export default function QuickStartGuide() {
  const steps = [
    { title: 'Get your Authorization Key', detail: 'Scroll to "Your Platform Authorization Key" and click Copy. This is your x-auth-key header value.' },
    { title: 'Configure your CRM webhook URL', detail: 'Go to CRM Integration page → Add Integration → paste the URL where you want Bolify to POST events.' },
    { title: 'Push leads INTO Bolify', detail: 'Call POST /functions/crmInbound with action=create_lead to send leads into the platform.' },
    { title: 'Initiate a call', detail: 'Call POST /functions/initiateCall with phone_number + agent_did. Bolify dials and starts the AI conversation.' },
    { title: 'Receive call events', detail: 'After each call completes, Bolify auto-POSTs call_completed + lead_updated events to your webhook URL within 5 minutes.' }
  ];

  return (
    <Card className="border-indigo-300 bg-gradient-to-br from-indigo-50 to-purple-50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-indigo-900">
          <Rocket className="w-5 h-5" /> Quick Start — 5 Steps to Go Live
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              <div className="shrink-0 w-7 h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-bold">
                {i + 1}
              </div>
              <div className="flex-1">
                <p className="font-semibold text-gray-900 text-sm">{s.title}</p>
                <p className="text-sm text-gray-600 mt-0.5">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-4 p-3 bg-white border border-indigo-200 rounded flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
          <p className="text-xs text-gray-700">
            <strong>Recommended auth:</strong> Use <code className="bg-gray-100 px-1 rounded">x-auth-key</code> (Platform Authorization Key) for all API calls. The <code className="bg-gray-100 px-1 rounded">x-api-key</code> header is supported for legacy CRM integrations only.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}