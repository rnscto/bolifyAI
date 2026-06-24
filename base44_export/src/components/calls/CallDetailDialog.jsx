import React from 'react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Download, Loader2 } from 'lucide-react';
import AudioPlayer from './AudioPlayer';

const statusColors = {
  initiated: 'bg-blue-100 text-blue-800',
  ringing: 'bg-yellow-100 text-yellow-800',
  answered: 'bg-purple-100 text-purple-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  no_answer: 'bg-gray-100 text-gray-800',
};

const formatDuration = (seconds) => {
  if (!seconds) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export default function CallDetailDialog({ call, maskPhoneNumber, fetchingRecording, onFetchRecording, onClose }) {
  return (
    <Dialog open={!!call} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Call Details</DialogTitle>
        </DialogHeader>
        {call && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-600">Direction</p>
                <p className="font-medium capitalize">{call.direction}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">{call.direction === 'inbound' ? 'Caller Number' : 'Called Number'}</p>
                <p className="font-medium">
                  {maskPhoneNumber(call.direction === 'inbound' ? (call.caller_id || call.callee_number) : call.callee_number)}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Duration</p>
                <p className="font-medium">{formatDuration(call.duration)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Status</p>
                <Badge className={statusColors[call.status]}>{call.status}</Badge>
              </div>
            </div>

            {call.lead_status_updated && (
              <div>
                <p className="text-sm text-gray-600">Call Outcome</p>
                <Badge className="bg-blue-100 text-blue-800 mt-1">{call.lead_status_updated}</Badge>
              </div>
            )}

            {call.conversation_summary && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Summary</p>
                <p className="text-sm bg-blue-50 p-3 rounded-lg border border-blue-100">
                  {(() => {
                    const raw = call.conversation_summary;
                    if (raw.startsWith('[LEAD CONTEXT]') || raw.startsWith('CUSTOMER PROFILE:')) {
                      return 'Summary not available — call data is being reprocessed.';
                    }
                    return raw;
                  })()}
                </p>
              </div>
            )}

            {call.transcript ? (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Transcript</p>
                <div className="text-sm bg-gray-50 p-3 rounded-lg max-h-72 overflow-y-auto border border-gray-200 space-y-2">
                  {call.transcript.split('\n').map((line, i) => {
                    const isAI = line.startsWith('AI:');
                    const isCustomer = line.startsWith('Customer:');
                    return line.trim() ? (
                      <div key={i} className={`px-2 py-1 rounded ${isAI ? 'bg-blue-50 text-blue-900' : isCustomer ? 'bg-green-50 text-green-900' : 'text-gray-700'}`}>
                        {line}
                      </div>
                    ) : null;
                  })}
                </div>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Transcript</p>
                <p className="text-sm text-gray-400 italic bg-gray-50 p-3 rounded-lg border border-gray-200">
                  No transcript available for this call.
                </p>
              </div>
            )}

            <div>
              <p className="text-sm text-gray-600 mb-2">Call Recording</p>
              {call.recording_url ? (
                <AudioPlayer url={call.recording_url} />
              ) : call.status === 'completed' ? (
                <Button variant="outline" size="sm" onClick={() => onFetchRecording(call.id)} disabled={fetchingRecording === call.id} className="gap-2">
                  {fetchingRecording === call.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  {fetchingRecording === call.id ? 'Fetching...' : 'Fetch Recording from Smartflo'}
                </Button>
              ) : (
                <p className="text-sm text-gray-400 italic">No recording available</p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}