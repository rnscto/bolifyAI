import React, { useEffect, useState, useMemo } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ShieldCheck, History, CreditCard, Calendar, Wallet, TrendingUp, Search, Download, RefreshCw,
  CheckCircle2, XCircle, AlertTriangle, ArrowRightLeft, Plus, Lock,
} from 'lucide-react';

// Roles are now checked dynamically via me?.role
const EVENT_META = {
  activated:           { label: 'Activated',           color: 'bg-green-100 text-green-800',   Icon: CheckCircle2 },
  trial_started:       { label: 'Trial Started',       color: 'bg-blue-100 text-blue-800',     Icon: Calendar },
  trial_extended:      { label: 'Trial Extended',      color: 'bg-blue-100 text-blue-800',     Icon: Calendar },
  trial_expired:       { label: 'Trial Expired',       color: 'bg-orange-100 text-orange-800', Icon: AlertTriangle },
  expired:             { label: 'Expired',             color: 'bg-red-100 text-red-800',       Icon: XCircle },
  suspended:           { label: 'Suspended',           color: 'bg-gray-200 text-gray-800',     Icon: Lock },
  reactivated:         { label: 'Reactivated',         color: 'bg-green-100 text-green-800',   Icon: CheckCircle2 },
  cancelled:           { label: 'Cancelled',           color: 'bg-red-100 text-red-800',       Icon: XCircle },
  plan_changed:        { label: 'Plan Changed',        color: 'bg-purple-100 text-purple-800', Icon: ArrowRightLeft },
  billing_type_changed:{ label: 'Billing Type Changed',color: 'bg-purple-100 text-purple-800', Icon: ArrowRightLeft },
  channels_changed:    { label: 'Channels Changed',    color: 'bg-cyan-100 text-cyan-800',     Icon: ArrowRightLeft },
  rate_changed:        { label: 'Rate Changed',        color: 'bg-cyan-100 text-cyan-800',     Icon: ArrowRightLeft },
  renewed:             { label: 'Renewed',             color: 'bg-emerald-100 text-emerald-800', Icon: RefreshCw },
  wallet_topup:        { label: 'Wallet Top-Up',       color: 'bg-emerald-100 text-emerald-800', Icon: Plus },
  wallet_adjusted:     { label: 'Wallet Adjusted',     color: 'bg-yellow-100 text-yellow-800', Icon: Wallet },
  next_billing_updated:{ label: 'Billing Date Updated',color: 'bg-blue-100 text-blue-800',     Icon: Calendar },
  kyc_updated:         { label: 'KYC Updated',         color: 'bg-gray-100 text-gray-800',     Icon: ShieldCheck },
  note:                { label: 'Note',                color: 'bg-gray-100 text-gray-800',     Icon: History },
};

const formatDateTime = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
    });
  } catch { return iso; }
};

const formatDate = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      dateStyle: 'medium', timeZone: 'Asia/Kolkata',
    });
  } catch { return iso; }
};

export default function AdminClientLifecycle() {
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState([]);
  const [clients, setClients] = useState([]);
  const [filterClient, setFilterClient] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [backfilling, setBackfilling] = useState(false);

  const backfillHistory = async () => {
    if (!confirm('Generate initial lifecycle events from existing Client records? This creates one entry per client based on current status (activation, trial, billing). Safe to run multiple times — duplicates are skipped.')) return;
    setBackfilling(true);
    try {
      const existing = await apiClient.ClientLifecycleEvent.list('-created_at', 10000);
      const existingKeys = new Set(existing.map(e => `${e.client_id}:${e.event_type}:backfill`));
      const toCreate = [];
      for (const c of clients) {
        // Activation event
        if ((c.account_status === 'active' || c.account_status === 'expired') && !existingKeys.has(`${c.id}:activated:backfill`)) {
          toCreate.push({
            client_id: c.id,
            client_name: c.company_name,
            event_type: 'activated',
            to_value: c.account_status,
            amount: c.billing_type === 'unlimited' ? (c.monthly_rate_per_channel || 0) * (c.total_channels || 1) : null,
            effective_date: c.created_at,
            expiry_date: c.next_billing_date || null,
            billing_type: c.billing_type,
            subscription_plan: c.subscription_plan,
            channels: c.total_channels,
            source: 'system_auto',
            performed_by: 'backfill',
            notes: 'Backfilled from existing Client record',
          });
        }
        // Trial event
        if (c.trial_start_date && !existingKeys.has(`${c.id}:trial_started:backfill`)) {
          toCreate.push({
            client_id: c.id,
            client_name: c.company_name,
            event_type: 'trial_started',
            effective_date: c.trial_start_date,
            expiry_date: c.trial_end_date,
            source: 'system_auto',
            performed_by: 'backfill',
            notes: 'Backfilled trial period',
          });
        }
        // Trial expired
        if (c.account_status === 'expired' && c.trial_end_date && !existingKeys.has(`${c.id}:trial_expired:backfill`)) {
          toCreate.push({
            client_id: c.id,
            client_name: c.company_name,
            event_type: 'trial_expired',
            effective_date: c.trial_end_date,
            source: 'system_auto',
            performed_by: 'backfill',
            notes: 'Backfilled trial expiry',
          });
        }
      }
      if (toCreate.length === 0) {
        alert('No new events to backfill — all clients already have history entries.');
      } else {
        await apiClient.ClientLifecycleEvent.bulkCreate(toCreate);
        alert(`✓ Backfilled ${toCreate.length} lifecycle events across ${clients.length} clients.`);
        await loadData();
      }
    } catch (e) {
      console.error('Backfill error', e);
      alert('Backfill failed: ' + e.message);
    }
    setBackfilling(false);
  };

  useEffect(() => {
    (async () => {
      try {
        const me = await apiClient.auth.me();
        setUser(me);
        if (!['admin', 'master_admin'].includes(me.role)) {
          setAuthError('This page is restricted to platform admins.');
          setLoading(false);
          return;
        }
        await loadData();
      } catch (e) {
        setAuthError('Please log in.');
        setLoading(false);
      }
    })();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [evList, clList] = await Promise.all([
        apiClient.ClientLifecycleEvent.list('-created_at', 10000),
        apiClient.Client.list('-created_at', 5000),
      ]);
      setEvents(evList || []);
      setClients(clList || []);
    } catch (e) {
      console.error('Load error', e);
    }
    setLoading(false);
  };

  const filteredEvents = useMemo(() => {
    const fromTs = dateFrom ? new Date(dateFrom).getTime() : null;
    const toTs = dateTo ? new Date(dateTo).getTime() + 86400000 : null;
    return events.filter((e) => {
      if (filterClient !== 'all' && e.client_id !== filterClient) return false;
      if (filterType !== 'all' && e.event_type !== filterType) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!(
          (e.client_name || '').toLowerCase().includes(s) ||
          (e.notes || '').toLowerCase().includes(s) ||
          (e.from_value || '').toLowerCase().includes(s) ||
          (e.to_value || '').toLowerCase().includes(s)
        )) return false;
      }
      const ts = e.effective_date ? new Date(e.effective_date).getTime() : new Date(e.created_at).getTime();
      if (fromTs && ts < fromTs) return false;
      if (toTs && ts > toTs) return false;
      return true;
    });
  }, [events, filterClient, filterType, search, dateFrom, dateTo]);

  const stats = useMemo(() => {
    const totalEvents = filteredEvents.length;
    const activated = filteredEvents.filter(e => e.event_type === 'activated' || e.event_type === 'reactivated').length;
    const expired = filteredEvents.filter(e => e.event_type === 'expired' || e.event_type === 'trial_expired').length;
    const renewed = filteredEvents.filter(e => e.event_type === 'renewed').length;
    const revenue = filteredEvents
      .filter(e => ['renewed', 'wallet_topup', 'activated'].includes(e.event_type))
      .reduce((sum, e) => sum + (e.amount || 0), 0);
    return { totalEvents, activated, expired, renewed, revenue };
  }, [filteredEvents]);

  // Billing snapshot per client — derived from latest events + current Client record
  const billingSnapshot = useMemo(() => {
    return clients.map((c) => {
      const clientEvents = events.filter(e => e.client_id === c.id);
      const lastActivation = clientEvents.find(e => e.event_type === 'activated' || e.event_type === 'reactivated');
      const lastRenewal = clientEvents.find(e => e.event_type === 'renewed');
      const lastChange = clientEvents[0]; // already sorted -created_at
      return {
        client: c,
        activated_on: lastActivation?.effective_date || lastActivation?.created_at || null,
        last_renewed_on: lastRenewal?.effective_date || lastRenewal?.created_at || null,
        last_change_on: lastChange?.created_at || null,
        last_change_type: lastChange?.event_type || null,
        total_events: clientEvents.length,
      };
    });
  }, [clients, events]);

  const exportCSV = () => {
    const headers = ['Date (IST)', 'Client', 'Event', 'From', 'To', 'Amount (₹)', 'Effective Date', 'Expiry Date', 'Source', 'Performed By', 'Notes'];
    const rows = filteredEvents.map(e => [
      formatDateTime(e.created_at),
      e.client_name || '',
      EVENT_META[e.event_type]?.label || e.event_type,
      e.from_value || '',
      e.to_value || '',
      e.amount || '',
      formatDateTime(e.effective_date),
      formatDateTime(e.expiry_date),
      e.source || '',
      e.performed_by || '',
      (e.notes || '').replace(/"/g, '""'),
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `client-lifecycle-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (authError) {
    return (
      <div className="max-w-xl mx-auto mt-20">
        <Card className="border-red-200">
          <CardContent className="p-8 text-center space-y-3">
            <Lock className="w-12 h-12 mx-auto text-red-500" />
            <h2 className="text-xl font-semibold text-gray-900">Access Restricted</h2>
            <p className="text-gray-600">{authError}</p>
            <p className="text-xs text-gray-400">Only the main platform admin can view client activation history & billing management.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 text-blue-600" />
            Client Lifecycle & Billing Management
          </h1>
          <p className="text-gray-600 mt-1">
            White-label platform — full activation history, renewals, expiries, and billing changes.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={loadData}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" onClick={backfillHistory} disabled={backfilling}>
            <History className="w-4 h-4 mr-2" /> {backfilling ? 'Backfilling…' : 'Backfill from Existing Clients'}
          </Button>
          <Button onClick={exportCSV} className="bg-blue-600 hover:bg-blue-700">
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Total Events" value={stats.totalEvents} Icon={History} color="text-gray-700" />
        <StatCard label="Activations" value={stats.activated} Icon={CheckCircle2} color="text-green-600" />
        <StatCard label="Expirations" value={stats.expired} Icon={XCircle} color="text-red-600" />
        <StatCard label="Renewals" value={stats.renewed} Icon={RefreshCw} color="text-emerald-600" />
        <StatCard label="Revenue Tracked" value={`₹${stats.revenue.toLocaleString()}`} Icon={TrendingUp} color="text-blue-600" />
      </div>

      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history"><History className="w-4 h-4 mr-1" /> Activation History</TabsTrigger>
          <TabsTrigger value="billing"><CreditCard className="w-4 h-4 mr-1" /> Billing Snapshot</TabsTrigger>
        </TabsList>

        {/* ─────────── HISTORY TAB ─────────── */}
        <TabsContent value="history" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
                  <Input
                    className="pl-9"
                    placeholder="Search..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <Select value={filterClient} onValueChange={setFilterClient}>
                  <SelectTrigger><SelectValue placeholder="Client" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Clients</SelectItem>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.company_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger><SelectValue placeholder="Event Type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Event Types</SelectItem>
                    {Object.entries(EVENT_META).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="From" />
                <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} placeholder="To" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Event Log ({filteredEvents.length})</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When (IST)</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Effective</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEvents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-gray-500 py-8">
                        No lifecycle events match the current filters.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredEvents.map((e) => {
                      const meta = EVENT_META[e.event_type] || EVENT_META.note;
                      const EventIcon = meta.Icon;
                      return (
                        <TableRow key={e.id}>
                          <TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.created_at)}</TableCell>
                          <TableCell className="font-medium">{e.client_name || '—'}</TableCell>
                          <TableCell>
                            <Badge className={`${meta.color} gap-1`}>
                              <EventIcon className="w-3 h-3" />
                              {meta.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            {(e.from_value || e.to_value) ? (
                              <span><span className="text-gray-500">{e.from_value || '—'}</span> → <span className="font-medium">{e.to_value || '—'}</span></span>
                            ) : '—'}
                          </TableCell>
                          <TableCell>{e.amount ? `₹${e.amount.toLocaleString()}` : '—'}</TableCell>
                          <TableCell className="text-xs">{formatDate(e.effective_date)}</TableCell>
                          <TableCell className="text-xs">{formatDate(e.expiry_date)}</TableCell>
                          <TableCell className="text-xs">{e.performed_by || e.source || '—'}</TableCell>
                          <TableCell className="text-xs text-gray-600 max-w-xs truncate">{e.notes || '—'}</TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─────────── BILLING SNAPSHOT TAB ─────────── */}
        <TabsContent value="billing">
          <Card>
            <CardHeader>
              <CardTitle>Per-Client Billing Snapshot ({billingSnapshot.length})</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Billing</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Channels</TableHead>
                    <TableHead>Wallet</TableHead>
                    <TableHead>Activated</TableHead>
                    <TableHead>Trial Ends</TableHead>
                    <TableHead>Next Billing</TableHead>
                    <TableHead>Last Renewed</TableHead>
                    <TableHead>Events</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {billingSnapshot.map(({ client: c, activated_on, last_renewed_on, total_events }) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.company_name}</TableCell>
                      <TableCell>
                        <Badge className={{
                          active: 'bg-green-100 text-green-800',
                          trial: 'bg-blue-100 text-blue-800',
                          expired: 'bg-red-100 text-red-800',
                          onboarding: 'bg-yellow-100 text-yellow-800',
                          suspended: 'bg-gray-100 text-gray-800',
                        }[c.account_status] || 'bg-gray-100 text-gray-800'}>
                          {c.account_status || 'unknown'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={c.billing_type === 'unlimited' ? 'bg-purple-100 text-purple-800' : 'bg-cyan-100 text-cyan-800'}>
                          {c.billing_type === 'unlimited' ? 'Unlimited' : `₹${c.per_minute_rate || 4}/min`}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{c.subscription_plan || '—'}</TableCell>
                      <TableCell className="text-xs">{c.total_channels || 1}</TableCell>
                      <TableCell className="text-xs">
                        ₹{(c.wallet_balance || 0).toLocaleString()}
                        {(c.free_minutes_remaining || 0) > 0 && (
                          <span className="text-blue-600 ml-1">+{c.free_minutes_remaining}min</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{formatDate(activated_on)}</TableCell>
                      <TableCell className="text-xs">{formatDate(c.trial_end_date)}</TableCell>
                      <TableCell className="text-xs">{formatDate(c.next_billing_date)}</TableCell>
                      <TableCell className="text-xs">{formatDate(last_renewed_on)}</TableCell>
                      <TableCell className="text-xs text-center">{total_events}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ label, value, Icon, color }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <Icon className={`w-8 h-8 ${color} opacity-70`} />
        </div>
      </CardContent>
    </Card>
  );
}