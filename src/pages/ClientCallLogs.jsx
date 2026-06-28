import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { useRealtime } from '@/hooks/useRealtime';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import FeatureGate from '../components/FeatureGate';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Eye, PhoneIncoming, PhoneOutgoing, FileText, ExternalLink, Disc, Download, Loader2, FileSpreadsheet, Trash2 } from 'lucide-react';
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
import LiveCallActions from '../components/calls/LiveCallActions';
import CallStatsCards from '../components/calls/CallStatsCards';
import CallDetailDialog from '../components/calls/CallDetailDialog';
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
  }, []);

  // Live updates via WebSocket subscription — replaces the old 60s polling loop.
  // No integration credits, no repeated 1000-row reads. Patches rows in place.
  useRealtime('CallLog', (event) => {
    if (!client?.id) return;
    if (event.data?.client_id !== client.id) return;
    if (event.type === 'create') {
      setCall(prev => (prev.some(c => c.id === event.id) ? prev : [event.data, ...prev]));
    } else if (event.type === 'update') {
      setCall(prev => prev.map(c => (c.id === event.id ? { ...c, ...event.data } : c)));
      setSelectedCall(prev => (prev?.id === event.id ? { ...prev, ...event.data } : prev));
    } else if (event.type === 'delete') {
      setCall(prev => prev.filter(c => c.id !== event.id));
    }
  });

  const loadData = async () => {
    try {
      const user = await apiClient.auth.me();
      const clients = await apiClient.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const callsData = await apiClient.CallLog.filter(
          { client_id: clientData.id },
          '-created_at',
          1000
        );
        setCall(callsData);
        
        // Auto-fetch missing recordings in the background
        apiClient.post('/api/voice/fetch-recording', { bulk: true }).then(res => {
          if (res?.updated > 0) {
            apiClient.CallLog.filter({ client_id: clientData.id }, '-created_at', 1000)
              .then(data => setCall(data));
          }
        }).catch(console.error);
      }
    } catch (error) {
      console.error('Error loading calls:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchRecording = async (callLogId) => {
    setFetchingRecording(callLogId);
    const res = await apiClient.post('/api/voice/fetch-recording', { call_log_id: callLogId });
    if (res.updated > 0) {
      await loadData();
      if (selectedCall?.id === callLogId) {
        const updated = await apiClient.CallLog.get(callLogId);
        setSelectedCall(updated);
      }
    }
    setFetchingRecording(null);
  };

  const fetchBulkRecordings = async () => {
    setFetchingBulk(true);
    await apiClient.post('/api/voice/fetch-recording', { bulk: true });
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
        await apiClient.CallLog.delete(id);
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
              formatDateTime(c.call_start_time || c.created_at),
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

      <CallStatsCards calls={calls} />

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

      <CallDetailDialog
        call={selectedCall}
        maskPhoneNumber={maskPhoneNumber}
        fetchingRecording={fetchingRecording}
        onFetchRecording={fetchRecording}
        onClose={() => setSelectedCall(null)}
      />

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