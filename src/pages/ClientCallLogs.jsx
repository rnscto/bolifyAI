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
import { Eye, PhoneCall, PhoneIncoming, PhoneOutgoing, Play, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import AudioPlayer from '../components/calls/AudioPlayer';

export default function ClientCallLogs() {
  const [calls, setCall] = useState([]);
  const [selectedCall, setSelectedCall] = useState(null);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
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
          100
        );
        setCall(callsData);
      }
    } catch (error) {
      console.error('Error loading calls:', error);
    } finally {
      setLoading(false);
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
                <TableHead>Direction</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500">
                    No call history yet
                  </TableCell>
                </TableRow>
              ) : (
                calls.map((call) => (
                  <TableRow key={call.id}>
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
                    <TableCell className="font-medium">{call.callee_number}</TableCell>
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
                      {call.call_start_time ? 
                        new Date(call.call_start_time).toLocaleString() : '-'}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedCall(call)}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
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
                  <p className="text-sm text-gray-600">Number</p>
                  <p className="font-medium">{selectedCall.callee_number}</p>
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
              
              {selectedCall.conversation_summary && (
                <div>
                  <p className="text-sm text-gray-600 mb-2">Summary</p>
                  <p className="text-sm bg-gray-50 p-3 rounded-lg">
                    {selectedCall.conversation_summary}
                  </p>
                </div>
              )}

              {selectedCall.transcript && (
                <div>
                  <p className="text-sm text-gray-600 mb-2">Transcript</p>
                  <div className="text-sm bg-gray-50 p-3 rounded-lg max-h-64 overflow-y-auto whitespace-pre-wrap">
                    {selectedCall.transcript}
                  </div>
                </div>
              )}

              {selectedCall.lead_status_updated && (
                <div>
                  <p className="text-sm text-gray-600">Lead Status Updated</p>
                  <p className="font-medium">{selectedCall.lead_status_updated}</p>
                </div>
              )}

              {selectedCall.recording_url && (
                <div>
                  <p className="text-sm text-gray-600 mb-2">Call Recording</p>
                  <AudioPlayer url={selectedCall.recording_url} />
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </FeatureGate>
  );
}