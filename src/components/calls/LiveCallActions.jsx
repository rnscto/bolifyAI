import React, { useState } from 'react';
import { apiClient } from '@/api/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Headphones, Mic, PhoneForwarded, Radio, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const ACTION_TYPES = {
  1: { label: 'Monitor', icon: Headphones, desc: 'Silently listen to the call', color: 'text-blue-600' },
  2: { label: 'Whisper', icon: Mic, desc: 'Speak to AI agent only (customer can\'t hear)', color: 'text-purple-600' },
  3: { label: 'Barge-in', icon: Radio, desc: 'Join the call — both parties hear you', color: 'text-orange-600' },
  4: { label: 'Transfer', icon: PhoneForwarded, desc: 'Transfer call to a human agent', color: 'text-green-600' },
};

export default function LiveCallActions({ call, onActionComplete }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [intercom, setIntercom] = useState('');
  const [agentId, setAgentId] = useState('');

  const isLive = ['ringing', 'answered', 'initiated'].includes(call.status);

  const handleAction = async (type) => {
    setLoading(true);
    try {
      const payload = { call_log_id: call.id, type };
      if (type === 4 && intercom) payload.intercom = intercom;
      if ([1, 2, 3].includes(type) && agentId) payload.agent_id = agentId;

      const res = await apiClient.functions.invoke('callTransfer', payload);
      toast.success(`${ACTION_TYPES[type].label} action initiated successfully`);
      onActionComplete?.();
      setOpen(false);
    } catch (err) {
      const errMsg = err?.response?.data?.error || err.message || 'Action failed';
      toast.error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  if (!isLive) return null;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="gap-1 text-orange-600 border-orange-200 hover:bg-orange-50">
        <Radio className="w-3.5 h-3.5" />
        Live
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
              </span>
              Live Call Actions
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="text-sm text-gray-500">
              Call to: <span className="font-medium text-gray-900">{call.callee_number}</span>
              <Badge className="ml-2 bg-green-100 text-green-800">{call.status}</Badge>
            </div>

            {/* Smartflo Agent ID for Monitor/Whisper/Barge */}
            <div>
              <label className="text-xs font-medium text-gray-600">Smartflo Agent ID (for Monitor/Whisper/Barge)</label>
              <Input
                placeholder="e.g. 12341"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="mt-1"
              />
            </div>

            {/* Intercom for Transfer */}
            <div>
              <label className="text-xs font-medium text-gray-600">Transfer Extension (for Transfer)</label>
              <Input
                placeholder="e.g. 1111"
                value={intercom}
                onChange={(e) => setIntercom(e.target.value)}
                className="mt-1"
              />
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2">
              {Object.entries(ACTION_TYPES).map(([type, config]) => {
                const Icon = config.icon;
                const typeNum = parseInt(type);
                const disabled = loading ||
                  ([1, 2, 3].includes(typeNum) && !agentId) ||
                  (typeNum === 4 && !intercom);

                return (
                  <Button
                    key={type}
                    variant="outline"
                    className={`flex flex-col items-center gap-1 h-auto py-3 ${disabled ? '' : 'hover:bg-gray-50'}`}
                    disabled={disabled}
                    onClick={() => handleAction(typeNum)}
                  >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Icon className={`w-5 h-5 ${config.color}`} />}
                    <span className="text-xs font-medium">{config.label}</span>
                    <span className="text-[10px] text-gray-400 text-center leading-tight">{config.desc}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}