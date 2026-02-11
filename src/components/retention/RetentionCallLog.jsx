import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { PhoneOutgoing, PhoneIncoming } from 'lucide-react';

const statusColors = {
  initiated: 'bg-gray-100 text-gray-800',
  ringing: 'bg-blue-100 text-blue-800',
  answered: 'bg-green-100 text-green-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  no_answer: 'bg-yellow-100 text-yellow-800',
};

export default function RetentionCallLog({ callLogs, clients }) {
  const getClientName = (clientId) => {
    const c = clients.find(cl => cl.id === clientId);
    return c?.company_name || '-';
  };

  const retentionLogs = callLogs
    .filter(l => l.call_sid?.startsWith('ret_') || l.conversation_summary?.includes('Retention'))
    .sort((a, b) => new Date(b.call_start_time || b.created_date) - new Date(a.call_start_time || a.created_date));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent Retention Calls ({retentionLogs.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {retentionLogs.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">No retention calls yet. The system will auto-call expired clients based on your schedule.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Direction</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {retentionLogs.slice(0, 20).map((log) => (
                <TableRow key={log.id}>
                  <TableCell>
                    {log.direction === 'inbound' ? (
                      <PhoneIncoming className="w-4 h-4 text-green-600" />
                    ) : (
                      <PhoneOutgoing className="w-4 h-4 text-blue-600" />
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{getClientName(log.client_id)}</TableCell>
                  <TableCell className="text-sm">{log.callee_number || log.caller_id || '-'}</TableCell>
                  <TableCell>
                    <Badge className={statusColors[log.status] || 'bg-gray-100'}>
                      {log.status?.replace('_', ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {log.duration ? `${Math.floor(log.duration / 60)}m ${log.duration % 60}s` : '-'}
                  </TableCell>
                  <TableCell className="text-sm">
                    {log.call_start_time ? new Date(log.call_start_time).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}
                  </TableCell>
                  <TableCell className="text-sm max-w-xs truncate">{log.conversation_summary || '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}