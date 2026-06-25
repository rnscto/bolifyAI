import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const statusStyles = {
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  no_answer: 'bg-gray-100 text-gray-600',
  ringing: 'bg-blue-100 text-blue-700',
  initiated: 'bg-yellow-100 text-yellow-700',
  answered: 'bg-emerald-100 text-emerald-700',
};

export default function RecentCallsTable({ callLogs, leads }) {
  const leadsMap = {};
  leads.forEach(l => { leadsMap[l.id] = l; });

  const recent = [...callLogs]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent Calls</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-gray-400 py-8">No calls yet</TableCell>
              </TableRow>
            ) : recent.map(call => {
              const lead = leadsMap[call.lead_id];
              return (
                <TableRow key={call.id}>
                  <TableCell className="font-medium text-sm">{lead?.name || 'Unknown'}</TableCell>
                  <TableCell className="text-sm text-gray-500">{call.callee_number}</TableCell>
                  <TableCell>
                    <Badge className={`text-xs ${statusStyles[call.status] || 'bg-gray-100 text-gray-600'}`}>
                      {call.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-gray-500">
                    {call.duration ? `${Math.floor(call.duration / 60)}m ${Math.round(call.duration % 60)}s` : '-'}
                  </TableCell>
                  <TableCell className="text-xs text-gray-400">
                    {new Date(call.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}