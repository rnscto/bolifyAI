import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MessageSquare, RefreshCw, Filter, CheckCircle2, AlertCircle, Clock, Search } from 'lucide-react';
import moment from 'moment';

const STATUS_BADGE = {
  sent: { color: 'bg-green-100 text-green-800', icon: CheckCircle2 },
  delivered: { color: 'bg-green-100 text-green-800', icon: CheckCircle2 },
  read: { color: 'bg-blue-100 text-blue-800', icon: CheckCircle2 },
  replied: { color: 'bg-blue-100 text-blue-800', icon: CheckCircle2 },
  failed: { color: 'bg-red-100 text-red-800', icon: AlertCircle },
  pending: { color: 'bg-yellow-100 text-yellow-800', icon: Clock },
  skipped: { color: 'bg-gray-100 text-gray-600', icon: null }
};

export default function ClientWhatsAppHistory() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState(null);

  useEffect(() => { loadData(); }, []);

  // Realtime updates via WebSocket — no polling, avoids Base44 rate limits.
  // Filters events to this client's WhatsApp logs and patches the list in place.
  useEffect(() => {
    if (!clientId) return;
    const unsubscribe = base44.entities.OutreachLog.subscribe((event) => {
      const row = event.data;
      if (!row || row.client_id !== clientId || row.channel !== 'whatsapp') return;
      setLogs(prev => {
        if (event.type === 'delete') return prev.filter(l => l.id !== event.id);
        const exists = prev.some(l => l.id === row.id);
        if (event.type === 'update' || exists) {
          return prev.map(l => (l.id === row.id ? row : l));
        }
        // new record → prepend (keeps newest-first ordering)
        return [row, ...prev];
      });
    });
    return unsubscribe;
  }, [clientId]);

  const loadData = async () => {
    setLoading(true);
    const user = await base44.auth.me();
    let cid = user.client_id || user.data?.client_id;
    if (!cid) {
      const clients = await base44.entities.Client.filter({ email: user.email });
      cid = clients[0]?.id;
    }
    if (!cid) { setLogs([]); setLoading(false); return; }
    setClientId(cid);
    const rows = await base44.entities.OutreachLog.filter(
      { client_id: cid, channel: 'whatsapp' }, '-created_date', 200
    );
    setLogs(rows);
    setLoading(false);
  };

  const filtered = logs.filter(l => {
    if (filterStatus !== 'all' && l.status !== filterStatus) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${l.recipient_phone || ''} ${l.template_name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const stats = {
    sent: logs.filter(l => ['sent', 'delivered', 'read', 'replied'].includes(l.status)).length,
    failed: logs.filter(l => l.status === 'failed').length,
    total: logs.length
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
          <h1 className="text-2xl font-bold text-gray-900">WhatsApp History</h1>
          <p className="text-gray-500 text-sm mt-1">All WhatsApp messages sent from your account</p>
        </div>
        <Button variant="outline" onClick={loadData} className="gap-2">
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="pt-6 text-center">
          <MessageSquare className="w-8 h-8 text-green-600 mx-auto mb-2" />
          <p className="text-2xl font-bold">{stats.sent}</p>
          <p className="text-sm text-gray-500">Sent</p>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-2xl font-bold">{stats.failed}</p>
          <p className="text-sm text-gray-500">Failed</p>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <Clock className="w-8 h-8 text-gray-500 mx-auto mb-2" />
          <p className="text-2xl font-bold">{stats.total}</p>
          <p className="text-sm text-gray-500">Total</p>
        </CardContent></Card>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            placeholder="Search phone or template..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 w-64"
          />
        </div>
        <Filter className="w-4 h-4 text-gray-400" />
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="read">Read</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-gray-400">
                    No WhatsApp messages found
                  </TableCell>
                </TableRow>
              ) : filtered.map(log => {
                const statusStyle = STATUS_BADGE[log.status] || STATUS_BADGE.pending;
                return (
                  <TableRow key={log.id}>
                    <TableCell className="text-sm text-gray-500 whitespace-nowrap">
                      {moment(log.created_date).format('DD MMM, hh:mm A')}
                    </TableCell>
                    <TableCell className="font-medium text-gray-700">
                      {log.recipient_phone || '—'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {log.template_name || '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{(log.outreach_type || '').replace(/_/g, ' ')}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={statusStyle.color}>{log.status}</Badge>
                      {log.error_message && (
                        <span className="block text-xs text-red-500 mt-1 truncate max-w-[180px]" title={log.error_message}>
                          {log.error_message}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}