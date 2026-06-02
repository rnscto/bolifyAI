import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import FeatureGate from '../components/FeatureGate';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Eye, PhoneCall, PhoneIncoming, PhoneOutgoing, FileText, ExternalLink, Disc, Download, Loader2, FileSpreadsheet, Trash2 } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import AudioPlayer from '../components/calls/AudioPlayer';
import LiveCallActions from '../components/calls/LiveCallActions';
import { exportToExcel, formatDateTime } from '../lib/exportToExcel';
import PhoneMaskToggle from '../components/PhoneMaskToggle';
import { usePhoneMask } from '../lib/phoneMask';

export default function ClientCallLogs() {
  const [calls, setCall] = useState([]);
  const [selectedCall, setSelectedCall] = useState(null);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchingRecording, setFetchingRecording] = useState(null);
  const [fetchingBulk, setFetchingBulk] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleteTarget, setDeleteTarget] = useState(null); // { type: 'single'|'bulk', id?: string }
  const [deleting, setDeleting] = useState(false);
  const { mask: maskPhoneNumber } = usePhoneMask();

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const callsData = await base44.entities.CallLog.filter(
          { client_id: clientData.id },
          '-created_date',
          5000
        );
        setCall(callsData);
      }
    } catch (error) {
      console.error('Error loading calls:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchRecording = async (callLogId) => {
    setFetchingRecording(callLogId);
    const res = await base44.functions.invoke('fetchCallRecording', { call_log_id: callLogId });
    if (res.data?.updated > 0) {
      await loadData();
      if (selectedCall?.id === callLogId) {
        const updated = await base44.entities.CallLog.get(callLogId);
        setSelectedCall(updated);
      }
    }
    setFetchingRecording(null);
  };

  const fetchBulkRecordings = async () => {
    setFetchingBulk(true);
    await base44.functions.invoke('fetchCallRecording', { bulk: true });
    await loadData();
    setFetchingBulk(false);
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === calls.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(calls.map(c => c.id)));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const ids = deleteTarget.type === 'single' ? [deleteTarget.id] : Array.from(selectedIds);
      for (const id of ids) {
        await base44.entities.CallLog.delete(id);
      }
      toast.success(`Deleted ${ids.length} call log${ids.length > 1 ? 's' : ''}`);
      setSelectedIds(new Set());
      setDeleteTarget(null);
      if (selectedCall && ids.includes(selectedCall.id)) setSelectedCall(null);
      await loadData();
    } catch (err) {
      toast.error('Failed to delete: ' + (err.message || 'unknown error'));
    } finally {
      setDeleting(false);
    }
  };

  const statusColors = {
    initiated: 'bg-blue-100 text-blue-800',
    ringing: 'bg-yellow-100 text-yellow-800',
    answered: 'bg-purple-100 text-purple-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    no_answer: 'bg-gray-100 text-gray-800'
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '-';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <FeatureGate client={client} featureName="Call Logs">
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Call Logs</h1>
        <p className="text-gray-600 mt-1">View all your call history and transcripts</p>
      </div>
      <div className="flex justify-end gap-2">
        <PhoneMaskToggle />
        {selectedIds.size > 0 && (
          <Button variant="destructive" size="sm" onClick={() => setDeleteTarget({ type: 'bulk' })} className="gap-2">
            <Trash2 className="w-4 h-4" /> Delete Selected ({selectedIds.size})
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => {
          if (calls.length === 0) { toast.error('No call logs to export'); return; }
          exportToExcel(
            'CallLogs',
            ['Date', 'Direction', 'Caller', 'Callee', 'Duration (s)', 'Status', 'Outcome', 'Has Recording', 'Has Transcript', 'Summary', 'Transferred To', 'Call SID'],
            calls.map(c => [
              formatDateTime(c.call_start_time || c.created_date),
              c.direction || '',
              c.direction === 'inbound' ? (c.caller_id || c.callee_number || '') : (c.caller_id || ''),
              c.callee_number || '',
              c.duration || 0,
              c.status || '',
              c.lead_status_updated || '',
              c.recording_url ? 'Yes' : 'No',
              c.transcript ? 'Yes' : 'No',
              (c.conversation_summary || '').replace(/\n/g, ' ').slice(0, 500),
              c.transferred_to || '',
              c.call_sid || ''
            ])
          );
          toast.success(`Exported ${calls.length} call logs`);
        }} className="gap-2">
          <FileSpreadsheet className="w-4 h-4" /> Export Excel
        </Button>
        <Button variant="outline" size="sm" onClick={fetchBulkRecordings} disabled={fetchingBulk} className="gap-2">
          {fetchingBulk ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {fetchingBulk ? 'Fetching Recordings...' : 'Fetch All Recordings'}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <PhoneCall className="w-8 h-8 text-blue-600" />
              <div>
                <p className="text-2xl font-bold">{calls.length}</p>
                <p className="text-sm text-gray-600">Total Calls</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <PhoneOutgoing className="w-8 h-8 text-green-600" />
              <div>
                <p className="text-2xl font-bold">
                  {calls.filter(c => c.direction === 'outbound').length}
                </p>
                <p className="text-sm text-gray-600">Outbound</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <PhoneIncoming className="w-8 h-8 text-purple-600" />
              <div>
                <p className="text-2xl font-bold">
                  {calls.filter(c => c.direction === 'inbound').length}
                </p>
                <p className="text-sm text-gray-600">Inbound</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <PhoneCall className="w-8 h-8 text-orange-600" />
              <div>
                <p className="text-2xl font-bold">
                  {calls.filter(c => c.status === 'completed').length}
                </p>
                <p className="text-sm text-gray-600">Completed</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Calls</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={calls.length > 0 && selectedIds.size === calls.length}
                    onCheckedChange={toggleSelectAll}
                  />
                </TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Transcript</TableHead>
                <TableHead>Recording</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-gray-500">
                    No call history yet
                  </TableCell>
                </TableRow>
              ) : (
                calls.map((call) => (
                  <TableRow key={call.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(call.id)}
                        onCheckedChange={() => toggleSelect(call.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {call.direction === 'outbound' ? (
                          <PhoneOutgoing className="w-4 h-4 text-green-600" />
                        ) : (
                          <PhoneIncoming className="w-4 h-4 text-purple-600" />
                        )}
                        <span className="capitalize">{call.direction}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {maskPhoneNumber(call.direction === 'inbound' ? (call.caller_id || call.callee_number) : call.callee_number)}
                    </TableCell>
                    <TableCell>
                      {call.lead_id ? (
                        <Link to={createPageUrl('LeadDetail') + `?id=${call.lead_id}`} className="text-blue-600 hover:underline text-sm flex items-center gap-1">
                          <ExternalLink className="w-3 h-3" /> View
                        </Link>
                      ) : '-'}
                    </TableCell>
                    <TableCell>{formatDuration(call.duration)}</TableCell>
                    <TableCell>
                      <Badge className={statusColors[call.status]}>
                        {call.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {call.transcript ? (
                        <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
                          <FileText className="w-3.5 h-3.5" /> Available
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {call.recording_url ? (
                        <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
                          <Disc className="w-3.5 h-3.5" /> Available
                        </span>
                      ) : call.status === 'completed' ? (
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={() => fetchRecording(call.id)} disabled={fetchingRecording === call.id}>
                          {fetchingRecording === call.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                          Fetch
                        </Button>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {call.call_start_time ? 
                        new Date(call.call_start_time).toLocaleString() : '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <LiveCallActions call={call} onActionComplete={loadData} />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedCall(call)}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setDeleteTarget({ type: 'single', id: call.id })}
                          title="Delete call log"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!selectedCall} onOpenChange={() => setSelectedCall(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Call Details</DialogTitle>
          </DialogHeader>
          {selectedCall && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Direction</p>
                  <p className="font-medium capitalize">{selectedCall.direction}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">{selectedCall.direction === 'inbound' ? 'Caller Number' : 'Called Number'}</p>
                  <p className="font-medium">
                    {maskPhoneNumber(selectedCall.direction === 'inbound' ? (selectedCall.caller_id || selectedCall.callee_number) : selectedCall.callee_number)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Duration</p>
                  <p className="font-medium">{formatDuration(selectedCall.duration)}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Status</p>
                  <Badge className={statusColors[selectedCall.status]}>
                    {selectedCall.status}
                  </Badge>
                </div>
              </div>

              {selectedCall.lead_status_updated && (
                <div>
                  <p className="text-sm text-gray-600">Call Outcome</p>
                  <Badge className="bg-blue-100 text-blue-800 mt-1">{selectedCall.lead_status_updated}</Badge>
                </div>
              )}
              
              {selectedCall.conversation_summary && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Summary</p>
                  <p className="text-sm bg-blue-50 p-3 rounded-lg border border-blue-100">
                    {(() => {
                      const raw = selectedCall.conversation_summary;
                      // Strip polluted lead context that was accidentally stored as summary
                      if (raw.startsWith('[LEAD CONTEXT]') || raw.startsWith('CUSTOMER PROFILE:')) {
                        return 'Summary not available — call data is being reprocessed.';
                      }
                      return raw;
                    })()}
                  </p>
                </div>
              )}

              {selectedCall.transcript ? (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Transcript</p>
                  <div className="text-sm bg-gray-50 p-3 rounded-lg max-h-72 overflow-y-auto border border-gray-200 space-y-2">
                    {selectedCall.transcript.split('\n').map((line, i) => {
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
                {selectedCall.recording_url ? (
                  <AudioPlayer url={selectedCall.recording_url} />
                ) : selectedCall.status === 'completed' ? (
                  <Button variant="outline" size="sm" onClick={() => fetchRecording(selectedCall.id)} disabled={fetchingRecording === selectedCall.id} className="gap-2">
                    {fetchingRecording === selectedCall.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    {fetchingRecording === selectedCall.id ? 'Fetching...' : 'Fetch Recording from Smartflo'}
                  </Button>
                ) : (
                  <p className="text-sm text-gray-400 italic">No recording available</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete call log{deleteTarget?.type === 'bulk' ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === 'bulk'
                ? `This will permanently delete ${selectedIds.size} call log${selectedIds.size > 1 ? 's' : ''}, including their transcripts and recording links. This action cannot be undone.`
                : 'This will permanently delete this call log, including its transcript and recording link. This action cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </FeatureGate>
  );
}