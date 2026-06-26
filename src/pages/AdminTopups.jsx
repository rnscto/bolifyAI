import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Wallet, IndianRupee, Clock, Receipt, Search, Upload } from 'lucide-react';
import InvoiceButton from '../components/subscription/InvoiceButton';
import { Button } from '@/components/ui/button';
import RaisePaymentRequestDialog from '../components/admin/RaisePaymentRequestDialog';

const CEO_EMAIL = 'yadavnand886@gmail.com';

const statusColors = {
  paid: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  failed: 'bg-red-100 text-red-800',
  refunded: 'bg-gray-100 text-gray-800',
};

const parseTopupMeta = (desc) => {
  if (!desc) return null;
  try {
    const meta = JSON.parse(desc);
    if (meta?.type === 'wallet_topup') return meta;
  } catch (_) {}
  return null;
};

export default function AdminTopups() {
  const [payments, setPayments] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [me, setMe] = useState(null);
  const [raiseOpen, setRaiseOpen] = useState(false);

  useEffect(() => { loadData(); apiClient.auth.me().then(setMe).catch(() => {}); }, []);

  const loadData = async () => {
    const [paysData, clientsData] = await Promise.all([
      apiClient.Payment.list('-created_at', 500),
      apiClient.Client.list('-created_at', 1000),
    ]);
    setPayments(paysData);
    setClients(clientsData);
    setLoading(false);
  };

  const isCEO = (me?.email || '').toLowerCase() === CEO_EMAIL;

  const getClient = (id) => clients.find(c => c.id === id);

  // Only top-up payments
  const topups = payments
    .map(p => ({ ...p, meta: parseTopupMeta(p.description) }))
    .filter(p => p.meta !== null);

  const filtered = topups.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (!search) return true;
    const client = getClient(p.client_id);
    const q = search.toLowerCase();
    return (
      client?.company_name?.toLowerCase().includes(q) ||
      client?.email?.toLowerCase().includes(q) ||
      p.cashfree_order_id?.toLowerCase().includes(q)
    );
  });

  // Summary (only paid transactions)
  const paidTopups = topups.filter(p => p.status === 'paid');
  const totalCollected = paidTopups.reduce((sum, p) => sum + (p.meta?.total || p.amount || 0), 0);
  const totalBase = paidTopups.reduce((sum, p) => sum + (p.meta?.amount || 0), 0);
  const totalGST = paidTopups.reduce((sum, p) => sum + (p.meta?.gst || 0), 0);
  const totalMinutesSold = paidTopups.reduce((sum, p) => {
    const c = getClient(p.client_id);
    const rate = c?.per_minute_rate || 4;
    return sum + Math.floor((p.meta?.amount || 0) / rate);
  }, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Wallet Top-Ups</h1>
          <p className="text-gray-600 mt-1">All wallet top-up transactions, minutes sold & GST billing</p>
        </div>
        {isCEO && (
          <Button className="bg-indigo-600 hover:bg-indigo-700" onClick={() => setRaiseOpen(true)}>
            <Upload className="w-4 h-4 mr-1" /> Raise Top-Up Approval
          </Button>
        )}
      </div>

      <RaisePaymentRequestDialog
        open={raiseOpen}
        onOpenChange={setRaiseOpen}
        defaultType="wallet_topup"
        clients={clients}
        onSubmitted={loadData}
      />

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-emerald-50 rounded-lg"><IndianRupee className="w-6 h-6 text-emerald-600" /></div>
              <div>
                <p className="text-2xl font-bold">₹{totalCollected.toLocaleString()}</p>
                <p className="text-sm text-gray-600">Total Collected</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-50 rounded-lg"><Wallet className="w-6 h-6 text-blue-600" /></div>
              <div>
                <p className="text-2xl font-bold">₹{totalBase.toLocaleString()}</p>
                <p className="text-sm text-gray-600">Wallet Credited</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-amber-50 rounded-lg"><Receipt className="w-6 h-6 text-amber-600" /></div>
              <div>
                <p className="text-2xl font-bold">₹{totalGST.toLocaleString()}</p>
                <p className="text-sm text-gray-600">GST Collected (18%)</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-purple-50 rounded-lg"><Clock className="w-6 h-6 text-purple-600" /></div>
              <div>
                <p className="text-2xl font-bold">{totalMinutesSold.toLocaleString()}</p>
                <p className="text-sm text-gray-600">Minutes Sold</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-3">
          <CardTitle>Top-Up Transactions ({filtered.length})</CardTitle>
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="refunded">Refunded</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search client or order ID..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Order ID</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">GST</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Minutes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invoice</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-gray-500 py-8">
                    No top-up transactions found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((p) => {
                  const client = getClient(p.client_id);
                  const rate = client?.per_minute_rate || 4;
                  const base = p.meta?.amount || 0;
                  const gst = p.meta?.gst || 0;
                  const total = p.meta?.total || p.amount || 0;
                  const minutes = Math.floor(base / rate);
                  const dateStr = p.paid_at || p.created_at;
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="text-sm">
                        {new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                        <p className="text-xs text-gray-400">
                          {new Date(dateStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{client?.company_name || '-'}</p>
                        <p className="text-xs text-gray-500">{client?.email || ''}</p>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-gray-600">
                        {p.cashfree_order_id || '-'}
                      </TableCell>
                      <TableCell className="text-right">₹{base.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-gray-600">₹{gst.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-semibold">₹{total.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <span className="text-emerald-700 font-medium">{minutes}</span>
                        <span className="text-xs text-gray-400 ml-1">min</span>
                      </TableCell>
                      <TableCell>
                        <Badge className={statusColors[p.status] || 'bg-gray-100'}>{p.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {p.status === 'paid' && <InvoiceButton paymentId={p.id} />}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}