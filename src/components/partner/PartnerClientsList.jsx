import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Loader2, Users, Phone } from 'lucide-react';
import moment from 'moment';

const STATUS_BADGE = {
  onboarding: 'bg-blue-100 text-blue-800',
  trial: 'bg-yellow-100 text-yellow-800',
  active: 'bg-green-100 text-green-800',
  expired: 'bg-red-100 text-red-800',
  suspended: 'bg-gray-100 text-gray-800',
};

export default function PartnerClientsList({ referrals }) {
  const [clients, setClients] = useState([]);
  const [callCounts, setCallCounts] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadClients();
  }, [referrals]);

  const loadClients = async () => {
    if (!referrals?.length) { setLoading(false); return; }

    const clientIds = referrals.map(r => r.client_id).filter(Boolean);
    if (clientIds.length === 0) { setLoading(false); return; }

    // Fetch clients in parallel
    const clientPromises = clientIds.map(id =>
      apiClient.Client.get(id).catch(() => null)
    );
    const clientResults = (await Promise.all(clientPromises)).filter(Boolean);
    setClients(clientResults);

    // Fetch call counts per client
    const counts = {};
    await Promise.all(clientResults.map(async (c) => {
      const logs = await apiClient.CallLog.filter({ client_id: c.id }, '-created_at', 1);
      // We only get the first one to check if there's activity; use list count
      const allLogs = await apiClient.CallLog.filter({ client_id: c.id });
      counts[c.id] = allLogs.length;
    }));
    setCallCounts(counts);
    setLoading(false);
  };

  if (loading) {
    return (
      <Card><CardContent className="py-12 text-center">
        <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-600" />
      </CardContent></Card>
    );
  }

  if (clients.length === 0) {
    return (
      <Card><CardContent className="py-12 text-center text-gray-500">
        <Users className="w-10 h-10 mx-auto mb-2 text-gray-300" />
        <p className="font-medium">No active clients yet</p>
        <p className="text-sm">Once your referrals sign up and create accounts, they'll appear here.</p>
      </CardContent></Card>
    );
  }

  // Build referral map for commission data
  const refMap = {};
  referrals.forEach(r => { if (r.client_id) refMap[r.client_id] = r; });

  // Summary stats
  const totalRevenue = clients.reduce((s, c) => s + (c.total_channels || 1) * (c.monthly_rate_per_channel || 6500), 0);
  const totalCalls = Object.values(callCounts).reduce((s, n) => s + n, 0);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-xl font-bold">{clients.length}</p>
          <p className="text-xs text-gray-500">Active Clients</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-xl font-bold">{totalCalls}</p>
          <p className="text-xs text-gray-500">Total Calls</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-xl font-bold text-green-600">₹{totalRevenue.toLocaleString('en-IN')}</p>
          <p className="text-xs text-gray-500">Monthly Revenue</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3 text-center">
          <p className="text-xl font-bold text-orange-600">{clients.reduce((s, c) => s + (c.total_channels || 1), 0)}</p>
          <p className="text-xs text-gray-500">Total Channels</p>
        </CardContent></Card>
      </div>

      {/* Clients table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2"><Users className="w-5 h-5" /> Your Clients</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Monthly Value</TableHead>
                  <TableHead>Total Calls</TableHead>
                  <TableHead>Commission Earned</TableHead>
                  <TableHead>Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map(c => {
                  const ref = refMap[c.id];
                  const monthlyVal = (c.total_channels || 1) * (c.monthly_rate_per_channel || 6500);
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <p className="font-medium">{c.company_name}</p>
                        <p className="text-xs text-gray-500">{c.industry || '-'}</p>
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[c.account_status] || 'bg-gray-100 text-gray-800'}>
                          {c.account_status || 'unknown'}
                        </Badge>
                      </TableCell>
                      <TableCell>{c.total_channels || 1}</TableCell>
                      <TableCell className="font-medium">₹{monthlyVal.toLocaleString('en-IN')}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Phone className="w-3 h-3 text-gray-400" />
                          {callCounts[c.id] || 0}
                        </div>
                      </TableCell>
                      <TableCell className="text-green-700 font-medium">
                        ₹{(ref?.total_commission_earned || 0).toLocaleString('en-IN')}
                      </TableCell>
                      <TableCell className="text-sm text-gray-500">
                        {c.created_at ? moment(c.created_at).format('DD MMM YY') : '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}