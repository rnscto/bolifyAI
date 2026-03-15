import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Eye, Mail, Phone, Clock, PhoneCall } from 'lucide-react';

const statusColors = {
  pending: 'bg-gray-100 text-gray-700',
  calling: 'bg-blue-100 text-blue-700 animate-pulse',
  processing: 'bg-indigo-100 text-indigo-700 animate-pulse',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  skipped: 'bg-yellow-100 text-yellow-700',
};

const outcomeColors = {
  neutral: 'bg-orange-100 text-orange-700',
  interested: 'bg-yellow-100 text-yellow-700',
  not_interested: 'bg-red-100 text-red-700',
  not_answered: 'bg-gray-100 text-gray-600',
  callback: 'bg-purple-100 text-purple-700',
  converted: 'bg-green-100 text-green-700',
  do_not_call: 'bg-gray-900 text-white',
};

const callStatusColors = {
  answered: 'bg-green-100 text-green-700',
  not_answered: 'bg-gray-100 text-gray-600',
};

const outcomeLabels = {
  neutral: 'Neutral',
  interested: 'Interested (Meeting/Demo)',
  not_interested: 'Not Interested',
  not_answered: 'Not Answered',
  callback: 'Callback',
  converted: 'Converted',
  do_not_call: 'Do Not Call',
};

const callStatusLabels = {
  answered: 'Answered',
  not_answered: 'Not Answered (Missed)',
};

export default function CampaignLeadsTable({ campaignLeads }) {
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');

  const filtered = campaignLeads.filter(cl => {
    if (filter === 'all') return true;
    if (filter === 'has_transcript') return !!cl.transcript;
    return cl.outcome === filter || cl.status === filter;
  });

  const formatDuration = (s) => {
    if (!s) return '-';
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Campaign Leads ({campaignLeads.length})</CardTitle>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="neutral">Neutral</SelectItem>
              <SelectItem value="interested">Interested</SelectItem>
              <SelectItem value="not_interested">Not Interested</SelectItem>
              <SelectItem value="not_answered">Not Answered</SelectItem>
              <SelectItem value="callback">Callback</SelectItem>
              <SelectItem value="converted">Converted</SelectItem>
              <SelectItem value="do_not_call">Do Not Call</SelectItem>
              <SelectItem value="has_transcript">Has Transcript</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Call Status</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Follow-up</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                   <TableCell colSpan={8} className="text-center text-gray-500">No leads match filter</TableCell>
                </TableRow>
              ) : (
                filtered.map(cl => (
                  <TableRow key={cl.id}>
                    <TableCell className="font-medium">{cl.lead_name || '-'}</TableCell>
                    <TableCell>{cl.lead_phone}</TableCell>
                    <TableCell>
                      <Badge className={statusColors[cl.status]}>
                        {cl.status === 'calling' && <PhoneCall className="w-3 h-3 mr-1 inline" />}
                        {cl.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {cl.call_status ? (
                        <Badge className={callStatusColors[cl.call_status] || 'bg-gray-100'}>
                          {callStatusLabels[cl.call_status] || cl.call_status}
                        </Badge>
                      ) : '-'}
                    </TableCell>
                    <TableCell>
                      {cl.outcome ? (
                        <Badge className={outcomeColors[cl.outcome] || 'bg-gray-100'}>
                          {outcomeLabels[cl.outcome] || cl.outcome}
                        </Badge>
                      ) : '-'}
                    </TableCell>
                    <TableCell>{formatDuration(cl.call_duration)}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {cl.followup_email_sent && <Mail className="w-4 h-4 text-blue-500" title="Email sent" />}
                        {cl.followup_scheduled && <Clock className="w-4 h-4 text-orange-500" title="Callback scheduled" />}
                      </div>
                    </TableCell>
                    <TableCell>
                      {(cl.transcript || cl.conversation_summary) && (
                        <Button size="sm" variant="ghost" onClick={() => setSelected(cl)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Transcript Dialog */}
      <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Call Details — {selected?.lead_name || selected?.lead_phone}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-gray-500">Call Status</p>
                  <Badge className={callStatusColors[selected.call_status] || 'bg-gray-100'}>
                    {callStatusLabels[selected.call_status] || selected.call_status || 'N/A'}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Outcome</p>
                  <Badge className={outcomeColors[selected.outcome] || 'bg-gray-100'}>
                    {outcomeLabels[selected.outcome] || selected.outcome || 'N/A'}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Duration</p>
                  <p className="font-medium">{formatDuration(selected.call_duration)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Attempts</p>
                  <p className="font-medium">{selected.attempt_count || 1}</p>
                </div>
              </div>
              {selected.conversation_summary && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">Summary</p>
                  <p className="text-sm bg-blue-50 p-3 rounded-lg">{selected.conversation_summary}</p>
                </div>
              )}
              {selected.transcript && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">Transcript</p>
                  <div className="text-sm bg-gray-50 p-3 rounded-lg max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-xs">
                    {selected.transcript}
                  </div>
                </div>
              )}
              <div className="flex gap-3 text-xs text-gray-500">
                {selected.followup_email_sent && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> Email sent</span>}
                {selected.followup_scheduled && (
                  <span className="flex items-center gap-1">
                    <Phone className="w-3 h-3" /> Callback: {selected.followup_call_date ? new Date(selected.followup_call_date).toLocaleDateString() : 'Scheduled'}
                  </span>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}