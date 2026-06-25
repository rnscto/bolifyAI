import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Mail, MessageSquare, RefreshCw, Filter, Send, AlertCircle, CheckCircle2, Clock, RotateCw, Loader2, ListOrdered } from 'lucide-react';
import { toast } from 'sonner';
import moment from 'moment';
import SequenceList from '../components/outreach/SequenceList';
import SequenceEditor from '../components/outreach/SequenceEditor';
import EnrollmentManager from '../components/outreach/EnrollmentManager';

const STATUS_BADGE = {
  sent: { color: 'bg-green-100 text-green-800', icon: CheckCircle2 },
  failed: { color: 'bg-red-100 text-red-800', icon: AlertCircle },
  pending: { color: 'bg-yellow-100 text-yellow-800', icon: Clock },
  skipped: { color: 'bg-gray-100 text-gray-600', icon: null }
};

const TYPE_BADGE = {
  lead_followup: 'bg-blue-100 text-blue-800',
  retention: 'bg-orange-100 text-orange-800',
  re_engagement: 'bg-purple-100 text-purple-800',
  thank_you: 'bg-green-100 text-green-800',
  proposal: 'bg-indigo-100 text-indigo-800',
  callback_reminder: 'bg-cyan-100 text-cyan-800'
};

export default function AdminOutreach() {
  const [logs, setLogs] = useState([]);
  const [clients, setClients] = useState({});
  const [sequences, setSequences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterChannel, setFilterChannel] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [resending, setResending] = useState(null);
  const [activeTab, setActiveTab] = useState('logs');

  // Sequence sub-views
  const [seqView, setSeqView] = useState('list'); // list | editor | enrollments
  const [editingSequence, setEditingSequence] = useState(null);
  const [viewingSequence, setViewingSequence] = useState(null);

  const handleResend = async (log) => {
    if (!log.recipient_email || log.channel !== 'email') {
      toast.error('Can only resend email outreach with a valid recipient');
      return;
    }
    setResending(log.id);
    try {
      await base44.integrations.Core.SendEmail({
        to: log.recipient_email,
        subject: log.subject || 'Follow-up from VaaniAI',
        body: log.body || '<p>This is a follow-up from VaaniAI.</p>'
      });
      await base44.entities.OutreachLog.create({
        client_id: log.client_id,
        lead_id: log.lead_id,
        channel: 'email',
        recipient_email: log.recipient_email,
        subject: log.subject,
        body: log.body,
        outreach_type: log.outreach_type,
        call_outcome: log.call_outcome,
        ai_summary: log.ai_summary,
        status: 'sent',
        is_retention: log.is_retention || false
      });
      toast.success(`Email resent to ${log.recipient_email}`);
      loadData();
    } catch (err) {
      toast.error('Failed to resend: ' + err.message);
    } finally {
      setResending(null);
    }
  };

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    const [allLogs, allClients, allSequences] = await Promise.all([
      base44.entities.OutreachLog.list('-created_at', 100),
      base44.entities.Client.list(),
      base44.entities.EmailSequence.list('-created_at', 50)
    ]);
    const clientMap = {};
    allClients.forEach(c => { clientMap[c.id] = c; });
    setClients(clientMap);
    setLogs(allLogs);
    setSequences(allSequences);
    setLoading(false);
  };

  const filtered = logs.filter(l => {
    if (filterChannel !== 'all' && l.channel !== filterChannel) return false;
    if (filterType !== 'all' && l.outreach_type !== filterType) return false;
    if (filterStatus !== 'all' && l.status !== filterStatus) return false;
    return true;
  });

  const stats = {
    totalEmails: logs.filter(l => l.channel === 'email' && l.status === 'sent').length,
    totalRCS: logs.filter(l => l.channel === 'rcs' && l.status === 'sent').length,
    retentionSent: logs.filter(l => l.is_retention && l.status === 'sent').length,
    failedCount: logs.filter(l => l.status === 'failed').length
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Outreach</h1>
          <p className="text-gray-500 text-sm mt-1">Manage email sequences and view outreach history</p>
        </div>
        <Button variant="outline" onClick={loadData} className="gap-2">
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6 text-center">
            <Mail className="w-8 h-8 text-blue-600 mx-auto mb-2" />
            <p className="text-2xl font-bold">{stats.totalEmails}</p>
            <p className="text-sm text-gray-500">Emails Sent</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <MessageSquare className="w-8 h-8 text-green-600 mx-auto mb-2" />
            <p className="text-2xl font-bold">{stats.totalRCS}</p>
            <p className="text-sm text-gray-500">RCS/SMS Sent</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <ListOrdered className="w-8 h-8 text-indigo-600 mx-auto mb-2" />
            <p className="text-2xl font-bold">{sequences.filter(s => s.status === 'active').length}</p>
            <p className="text-sm text-gray-500">Active Sequences</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
            <p className="text-2xl font-bold">{stats.failedCount}</p>
            <p className="text-sm text-gray-500">Failed</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); if (v === 'sequences') setSeqView('list'); }}>
        <TabsList>
          <TabsTrigger value="logs">Outreach Log</TabsTrigger>
          <TabsTrigger value="sequences">Email Sequences</TabsTrigger>
        </TabsList>

        <TabsContent value="logs" className="space-y-4 mt-4">
          {/* Filters */}
          <div className="flex flex-wrap gap-3 items-center">
            <Filter className="w-4 h-4 text-gray-400" />
            <Select value={filterChannel} onValueChange={setFilterChannel}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Channels</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="rcs">RCS/SMS</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="lead_followup">Lead Follow-up</SelectItem>
                <SelectItem value="retention">Retention</SelectItem>
                <SelectItem value="callback_reminder">Callback</SelectItem>
                <SelectItem value="thank_you">Thank You</SelectItem>
                <SelectItem value="proposal">Proposal</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Log Table */}
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-gray-400">
                        No outreach logs found
                      </TableCell>
                    </TableRow>
                  ) : filtered.map(log => {
                    const client = clients[log.client_id];
                    const statusStyle = STATUS_BADGE[log.status] || STATUS_BADGE.pending;
                    return (
                      <TableRow key={log.id}>
                        <TableCell className="text-sm text-gray-500 whitespace-nowrap">
                          {moment(log.created_at).format('DD MMM, hh:mm A')}
                        </TableCell>
                        <TableCell className="font-medium">
                          {client?.company_name || log.client_id}
                          {log.is_retention && (
                            <Badge className="ml-2 bg-orange-50 text-orange-700 text-[10px]">Retention</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="gap-1">
                            {log.channel === 'email' ? <Mail className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
                            {log.channel.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={TYPE_BADGE[log.outreach_type] || 'bg-gray-100 text-gray-700'}>
                            {(log.outreach_type || '').replace(/_/g, ' ')}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-gray-600">
                          {log.recipient_email || log.recipient_phone || '—'}
                        </TableCell>
                        <TableCell className="text-sm max-w-[200px] truncate">
                          {log.subject || '—'}
                        </TableCell>
                        <TableCell>
                          <Badge className={statusStyle.color}>
                            {log.status}
                          </Badge>
                          {log.error_message && (
                            <span className="block text-xs text-red-500 mt-1 truncate max-w-[150px]" title={log.error_message}>
                              {log.error_message}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {log.channel === 'email' && log.recipient_email && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1 text-xs"
                              disabled={resending === log.id}
                              onClick={() => handleResend(log)}
                            >
                              {resending === log.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <RotateCw className="w-3 h-3" />
                              )}
                              Resend
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sequences" className="mt-4">
          {seqView === 'list' && (
            <SequenceList
              sequences={sequences}
              onEdit={(seq) => { setEditingSequence(seq); setSeqView('editor'); }}
              onRefresh={loadData}
              onViewEnrollments={(seq) => { setViewingSequence(seq); setSeqView('enrollments'); }}
            />
          )}
          {seqView === 'editor' && (
            <SequenceEditor
              sequence={editingSequence}
              onSave={() => { setSeqView('list'); loadData(); }}
              onCancel={() => setSeqView('list')}
            />
          )}
          {seqView === 'enrollments' && viewingSequence && (
            <EnrollmentManager
              sequence={viewingSequence}
              onBack={() => setSeqView('list')}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}