import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CreditCard, TrendingUp, Wallet, Clock } from 'lucide-react';

export default function AdminSubscriptions() {
  const [subscriptions, setSubscriptions] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [subsData, clientsData] = await Promise.all([
        base44.entities.Subscription.list('-created_at'),
        base44.entities.Client.list()
      ]);
      setSubscriptions(subsData);
      setClients(clientsData);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getClient = (clientId) => clients.find(c => c.id === clientId);
  const getClientName = (clientId) => getClient(clientId)?.company_name || '-';

  const statusColors = {
    active: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    overdue: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800',
    trial: 'bg-blue-100 text-blue-800',
    expired: 'bg-red-100 text-red-800',
    onboarding: 'bg-purple-100 text-purple-800',
    suspended: 'bg-gray-100 text-gray-800',
  };

  const paymentStatusColors = {
    paid: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    failed: 'bg-red-100 text-red-800'
  };

  const unlimitedClients = clients.filter(c => c.billing_type === 'unlimited');
  const perMinuteClients = clients.filter(c => c.billing_type !== 'unlimited');

  const totalUnlimitedRevenue = subscriptions
    .filter(s => s.status === 'active')
    .reduce((sum, s) => sum + (s.total_amount || 0), 0);

  const totalWalletBalance = perMinuteClients.reduce((sum, c) => sum + (c.wallet_balance || 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Subscriptions & Billing</h1>
        <p className="text-gray-600 mt-1">Monitor client subscriptions, wallets, and billing</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-50 rounded-lg">
                <CreditCard className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{clients.length}</p>
                <p className="text-sm text-gray-600">Total Clients</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-purple-50 rounded-lg">
                <TrendingUp className="w-6 h-6 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{unlimitedClients.length}</p>
                <p className="text-sm text-gray-600">Unlimited Plans</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-green-50 rounded-lg">
                <Wallet className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{perMinuteClients.length}</p>
                <p className="text-sm text-gray-600">Per-Minute Plans</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-orange-50 rounded-lg">
                <CreditCard className="w-6 h-6 text-orange-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">₹{totalUnlimitedRevenue.toLocaleString()}</p>
                <p className="text-sm text-gray-600">Unlimited Revenue</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All Clients ({clients.length})</TabsTrigger>
          <TabsTrigger value="per_minute">Per-Minute ({perMinuteClients.length})</TabsTrigger>
          <TabsTrigger value="unlimited">Unlimited ({unlimitedClients.length})</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscription Records ({subscriptions.length})</TabsTrigger>
        </TabsList>

        {/* All clients view */}
        <TabsContent value="all">
          <ClientBillingTable clients={clients} statusColors={statusColors} />
        </TabsContent>

        {/* Per-minute clients */}
        <TabsContent value="per_minute">
          <ClientBillingTable clients={perMinuteClients} statusColors={statusColors} />
        </TabsContent>

        {/* Unlimited clients */}
        <TabsContent value="unlimited">
          <ClientBillingTable clients={unlimitedClients} statusColors={statusColors} />
        </TabsContent>

        {/* Raw subscription records */}
        <TabsContent value="subscriptions">
          <Card>
            <CardHeader>
              <CardTitle>Subscription Records (Unlimited Plans)</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Channels</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Billing Cycle</TableHead>
                    <TableHead>Next Billing</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Payment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subscriptions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-gray-500">
                        No subscription records found
                      </TableCell>
                    </TableRow>
                  ) : (
                    subscriptions.map((sub) => (
                      <TableRow key={sub.id}>
                        <TableCell className="font-medium">{getClientName(sub.client_id)}</TableCell>
                        <TableCell>{sub.channels}</TableCell>
                        <TableCell>₹{sub.total_amount?.toLocaleString()}</TableCell>
                        <TableCell className="capitalize">{sub.billing_cycle}</TableCell>
                        <TableCell>
                          {sub.next_billing_date ? new Date(sub.next_billing_date).toLocaleDateString() : '-'}
                        </TableCell>
                        <TableCell>
                          <Badge className={statusColors[sub.status]}>{sub.status}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={paymentStatusColors[sub.payment_status]}>{sub.payment_status}</Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ClientBillingTable({ clients, statusColors }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Billing Type</TableHead>
              <TableHead>Account Status</TableHead>
              <TableHead>Activated On</TableHead>
              <TableHead>Renewal Due</TableHead>
              <TableHead>Wallet / Channels</TableHead>
              <TableHead>Free Min</TableHead>
              <TableHead>Used Min</TableHead>
              <TableHead>Total Spent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-gray-500">No clients found</TableCell>
              </TableRow>
            ) : (
              clients.map((c) => {
                const renewal = c.next_billing_date ? new Date(c.next_billing_date) : null;
                const daysToRenewal = renewal ? Math.ceil((renewal - new Date()) / (1000 * 60 * 60 * 24)) : null;
                const renewalClass = daysToRenewal == null
                  ? 'text-gray-400'
                  : daysToRenewal < 0
                    ? 'text-red-600 font-semibold'
                    : daysToRenewal <= 7
                      ? 'text-amber-600 font-medium'
                      : 'text-gray-700';
                return (
                <TableRow key={c.id}>
                  <TableCell>
                    <div>
                      <p className="font-medium">{c.company_name}</p>
                      <p className="text-xs text-gray-500">{c.email}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={c.billing_type === 'unlimited' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}>
                      {c.billing_type === 'unlimited' ? 'Unlimited' : `Per-Minute (₹${c.per_minute_rate || 4}/min)`}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={statusColors[c.account_status] || 'bg-gray-100 text-gray-800'}>
                      {c.account_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {c.trial_start_date
                      ? new Date(c.trial_start_date).toLocaleDateString()
                      : c.created_at
                        ? new Date(c.created_at).toLocaleDateString()
                        : '-'}
                  </TableCell>
                  <TableCell className={`text-sm ${renewalClass}`}>
                    {renewal ? (
                      <div>
                        <div>{renewal.toLocaleDateString()}</div>
                        {daysToRenewal != null && (
                          <div className="text-xs">
                            {daysToRenewal < 0
                              ? `${Math.abs(daysToRenewal)}d overdue`
                              : daysToRenewal === 0
                                ? 'Due today'
                                : `in ${daysToRenewal}d`}
                          </div>
                        )}
                      </div>
                    ) : '-'}
                  </TableCell>
                  <TableCell>
                    {c.billing_type === 'unlimited' ? (
                      <span>{c.total_channels || 1} channel(s)</span>
                    ) : (
                      <span className={`font-medium ${(c.wallet_balance || 0) < 100 ? 'text-red-600' : 'text-green-600'}`}>
                        ₹{(c.wallet_balance || 0).toLocaleString()}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{c.free_minutes_remaining || 0}</TableCell>
                  <TableCell>{c.total_minutes_used || 0}</TableCell>
                  <TableCell>₹{(c.total_amount_spent || 0).toLocaleString()}</TableCell>
                </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}