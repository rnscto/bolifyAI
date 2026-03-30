import React, { useState } from 'react';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function StreamingSetupGuide() {
  const [copied, setCopied] = useState(false);

  // The function URL uses the Deno deploy host
  const streamUrl = 'wss://golden-urchin-99-66ba47h8thz4.deno.dev/functions/streamAudio';

  const handleCopy = () => {
    navigator.clipboard.writeText(streamUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs space-y-3">
      <p className="font-medium text-amber-900">
        Your Smartflo channel MUST have Voice Streaming configured to connect the AI agent.
        Without this, calls will ring but the AI will not speak.
      </p>
      
      <div className="space-y-2">
        <p className="font-semibold text-gray-800">Setup Steps:</p>
        <ol className="list-decimal list-inside space-y-1.5 text-gray-700">
          <li>Login to <span className="font-medium">Smartflo Dashboard</span></li>
          <li>Go to <span className="font-medium">Settings → Channels → Voice Bot</span></li>
          <li>Click <span className="font-medium">Add an Endpoint</span></li>
          <li>Set Endpoint Type to <span className="font-medium">Static URL</span></li>
          <li>Paste the WebSocket URL below</li>
          <li>Click <span className="font-medium">Save</span> and toggle <span className="font-medium">Enabled</span></li>
          <li>Ensure the endpoint is assigned to the <span className="font-medium">same channel</span> as your Click-to-Call API token</li>
        </ol>
      </div>

      <div>
        <p className="font-semibold text-gray-800 mb-1">WebSocket Streaming URL:</p>
        <div className="flex items-center gap-2 bg-white border rounded p-2">
          <code className="flex-1 text-[10px] font-mono text-gray-800 break-all select-all">
            {streamUrl}
          </code>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 shrink-0"
            onClick={handleCopy}
          >
            {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
          </Button>
        </div>
      </div>

      <p className="text-amber-800 font-medium">
        ⚠️ If Voice Streaming is not configured on your channel, calls will connect but the AI agent will not be able to listen or speak.
      </p>
    </div>
  );
}