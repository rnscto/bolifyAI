import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/api/apiClient';
import { PhoneForwarded, Smartphone, Copy, CheckCircle2, Info, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export default function CallForwardingGuide({ client }) {
  const [assignedDID, setAssignedDID] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    loadDID();
  }, [client?.id]);

  const loadDID = async () => {
    if (!client?.id) return;
    const agents = await apiClient.Agent.filter({ client_id: client.id });
    if (agents.length > 0) {
      const did = agents[0].assigned_did || (agents[0].assigned_dids && agents[0].assigned_dids[0]) || '';
      setAssignedDID(did);
    }
  };

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    toast.success(`${label} copied!`);
    setTimeout(() => setCopied(''), 2000);
  };

  const cleanDID = assignedDID.replace(/[^0-9]/g, '');
  const unconditionalCode = `*21*${cleanDID}#`;
  const busyCode = `*67*${cleanDID}#`;
  const noAnswerCode = `*61*${cleanDID}#`;
  const unreachableCode = `*62*${cleanDID}#`;
  const cancelAllCode = `##21#`;

  const CodeBlock = ({ label, code, description }) => (
    <div className="p-3 rounded-lg bg-gray-50 border space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => copyToClipboard(code, label)}
          className="h-7 text-xs gap-1"
        >
          {copied === label ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          {copied === label ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <code className="block text-lg font-mono font-bold text-blue-700">{code}</code>
      <p className="text-xs text-gray-500">{description}</p>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <PhoneForwarded className="w-5 h-5" />
          Call Forwarding Setup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Assigned DID */}
        <div className="p-4 rounded-lg bg-blue-50 border border-blue-200">
          <p className="text-xs text-blue-600 mb-1">Your VaaniAI Number</p>
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-blue-800 font-mono">{assignedDID || 'Not assigned'}</span>
            {assignedDID && (
              <Button variant="ghost" size="sm" onClick={() => copyToClipboard(assignedDID, 'DID')}>
                {copied === 'DID' ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </Button>
            )}
          </div>
          <p className="text-xs text-blue-600 mt-1">Forward your personal number's calls to this number</p>
        </div>

        {!assignedDID ? (
          <div className="p-4 rounded-lg bg-yellow-50 border border-yellow-200 flex gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-800">No DID assigned yet. Contact support to get your AI number.</p>
          </div>
        ) : (
          <>
            {/* Step by step guide */}
            <div className="space-y-3">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Smartphone className="w-4 h-4" />
                How to Set Up (All Phones)
              </h3>

              <div className="space-y-2 text-sm text-gray-700">
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">1</span>
                  <span>Open your phone's <strong>Dialer app</strong></span>
                </div>
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">2</span>
                  <span>Dial the forwarding code below (based on your preference)</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">3</span>
                  <span>Press the <strong>Call</strong> button — you'll hear a confirmation tone</span>
                </div>
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">4</span>
                  <span>Done! Your AI assistant will now handle forwarded calls</span>
                </div>
              </div>
            </div>

            {/* Forwarding codes */}
            <div className="space-y-3">
              <h3 className="font-semibold text-sm">Forwarding Codes</h3>

              <CodeBlock
                label="Forward All Calls (Recommended)"
                code={unconditionalCode}
                description="All incoming calls go to your AI assistant"
              />
              <CodeBlock
                label="When Busy"
                code={busyCode}
                description="Only forwards when you're on another call"
              />
              <CodeBlock
                label="When Unanswered"
                code={noAnswerCode}
                description="Forwards after you don't pick up (usually 15-30 seconds)"
              />
              <CodeBlock
                label="When Unreachable"
                code={unreachableCode}
                description="Forwards when your phone is off or out of network"
              />

              <div className="border-t pt-3">
                <CodeBlock
                  label="Cancel All Forwarding"
                  code={cancelAllCode}
                  description="Disables call forwarding — calls come to your phone directly"
                />
              </div>
            </div>

            {/* Tips */}
            <div className="p-3 rounded-lg bg-gray-50 border space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <Info className="w-4 h-4" />
                Tips
              </div>
              <ul className="text-xs text-gray-600 space-y-1 pl-6 list-disc">
                <li>For personal use, <strong>"When Unanswered"</strong> is ideal — you answer when available, AI handles the rest</li>
                <li>Carrier charges for call forwarding may apply depending on your telecom plan</li>
                <li>These codes work on Jio, Airtel, Vi, BSNL and most Indian carriers</li>
                <li>You can also set forwarding from <strong>Settings → Calls → Call Forwarding</strong> on your phone</li>
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}