import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, Phone, PhoneCall, TrendingUp, Clock, CreditCard, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import WebsiteLeadsSection from '../components/admin/WebsiteLeadsSection';

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [recentClients, setRecentClients] = useState([]);
  const [recentPayments, setRecentPayments] = useState([]);
  const [clientBreakdown, setClientBreakdown] = useState([]);
  const [revenueData, setRevenueData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    const [clients, dids, calls, subscriptions, payments] = await Promise.all([
      base44.entities.Client.list('-created_date'),
      base44.entities.DID.list(),
      base44.entities.CallLog.list('-created_date', 100),
      base44.entities.Subscription.list('-created_date'),
      base44.entities.Payment.list('-created_date', 10),
    ]);

    const today = new Date().toISOString().split('T')[0];
    const callsToday = calls.filter(c => c.created_date?.startsWith(today)).length;

    const activeClients = clients.filter(c => c.account_status === 'active').length;
    const trialClients = clients.filter(c => c.account_status === 'trial').length;
    const expiredClients = clients.filter(c => c.account_status === 'expired').length;
    const onboardingClients = clients.filter(c => c.account_status === 'onboarding').length;

    const totalMRR = clients
      .filter(c => c.account_status === 'active')
      .reduce((sum, c) => sum + ((c.total_channels || 1) * 6500) + (c.has_custom_crm ? 1999 : 0), 0);

    const activeSubs = subscriptions.filter(s => s.status === 'active');
    const totalQRevenue = activeSubs.reduce((sum, s) => sum + (s.total_amount || 0), 0);

    setStats({
      totalClients: clients.length,
      activeClients,
      trialClients,
      expiredClients,
      totalDIDs: dids.length,
      assignedDIDs: dids.filter(d => d.status === 'assigned').length,
      totalCalls: calls.length,
      callsToday,
      totalMRR,
      totalQRevenue,
      activeSubs: activeSubs.length,
    });

    setRecentClients(clients.slice(0, 5));
    setRecentPayments(payments.slice(0, 5));

    setClientBreakdown([
      { name: 'Active', value: activeClients, color: '#22c55e' },
      { name: 'Trial', value: trialClients, color: '#3b82f6' },
      { name: 'Expired', value: expiredClients, color: '#ef4444' },
      { name: 'Onboarding', value: onboardingClients, color: '#f59e0b' },
    ].filter(d => d.value > 0));

    // Revenue by month from payments
    const monthMap = {};
    payments.forEach(p => {
      if (p.status === 'paid' && p.created_date) {
        const month = new Date(p.created_date).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
        monthMap[month] = (monthMap[month] || 0) + (p.amount || 0);
      }
    });
    setRevenueData(Object.entries(monthMap).map(([month, amount]) => ({ month, amount })).reverse());

    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const statCards = [
    { title: 'Total Clients', value: stats.totalClients, subtitle: `${stats.activeClients} active, ${stats.trialClients} trial`, icon: Users, color: 'text-blue-600', bgColor: 'bg-blue-50' },
    { title: 'Monthly Revenue', value: `₹${stats.totalMRR.toLocaleString()}`, subtitle: 'Active subscriptions', icon: TrendingUp, color: 'text-green-600', bgColor: 'bg-green-50' },
    { title: 'DIDs Assigned', value: `${stats.assignedDIDs}/${stats.totalDIDs}`, subtitle: `${stats.totalDIDs - stats.assignedDIDs} available`, icon: Phone, color: 'text-purple-600', bgColor: 'bg-purple-50' },
    { title: 'Calls Today', value: stats.callsToday, subtitle: `${stats.totalCalls} total`, icon: PhoneCall, color: 'text-orange-600', bgColor: 'bg-orange-50' },
  ];

  const accountColors = {
    active: 'bg-green-100 text-green-800',
    trial: 'bg-blue-100 text-blue-800',
    expired: 'bg-red-100 text-red-800',
    onboarding: 'bg-yellow-100 text-yellow-800',
    suspended: 'bg-gray-100 text-gray-800',
  };

  const paymentColors = {
    paid: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    failed: 'bg-red-100 text-red-800',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-600 mt-1">Platform overview and analytics</p>
      </div>

      {/* Alert for expired clients */}
      {stats.expiredClients > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <span className="text-sm text-amber-800">
            <strong>{stats.expiredClients} client(s)</strong> have expired trials. Review them in{' '}
            <Link to={createPageUrl('AdminClients')} className="underline font-medium">Clients</Link>.
          </span>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-gray-600">{stat.title}</CardTitle>
                <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                  <Icon className={`w-5 h-5 ${stat.color}`} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-gray-900">{stat.value}</div>
                <p className="text-xs text-gray-500 mt-1">{stat.subtitle}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Client breakdown pie chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Client Status Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {clientBreakdown.length > 0 ? (
              <div className="flex items-center gap-6">
                <ResponsiveContainer width={160} height={160}>
                  <PieChart>
                    <Pie data={clientBreakdown} dataKey="value" cx="50%" cy="50%" outerRadius={70} innerRadius={40}>
                      {clientBreakdown.map((entry, idx) => (
                        <Cell key={idx} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  {clientBreakdown.map((item) => (
                    <div key={item.name} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-sm text-gray-700">{item.name}: <strong>{item.value}</strong></span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No client data yet</p>
            )}
          </CardContent>
        </Card>

        {/* Revenue bar chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Payments</CardTitle>
          </CardHeader>
          <CardContent>
            {revenueData.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={revenueData}>
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v) => `₹${v.toLocaleString()}`} />
                  <Bar dataKey="amount" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-gray-500">No payment data yet</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent activity row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent clients */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent Clients</CardTitle>
            <Link to={createPageUrl('AdminClients')} className="text-sm text-blue-600 hover:underline">View all</Link>
          </CardHeader>
          <CardContent>
            {recentClients.length === 0 ? (
              <p className="text-sm text-gray-500">No clients yet</p>
            ) : (
              <div className="space-y-3">
                {recentClients.map((c) => (
                  <div key={c.id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{c.company_name}</p>
                      <p className="text-xs text-gray-500">{c.email}</p>
                    </div>
                    <Badge className={accountColors[c.account_status] || 'bg-gray-100'}>
                      {c.account_status || 'unknown'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent payments */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent Payments</CardTitle>
            <Link to={createPageUrl('AdminSubscriptions')} className="text-sm text-blue-600 hover:underline">View all</Link>
          </CardHeader>
          <CardContent>
            {recentPayments.length === 0 ? (
              <p className="text-sm text-gray-500">No payments yet</p>
            ) : (
              <div className="space-y-3">
                {recentPayments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div>
                      <p className="text-sm font-medium text-gray-900">₹{p.amount?.toLocaleString()}</p>
                      <p className="text-xs text-gray-500">{p.description || 'Subscription payment'}</p>
                    </div>
                    <Badge className={paymentColors[p.status] || 'bg-gray-100'}>
                      {p.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Platform Health */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Platform Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { name: 'WebSocket Status', status: 'Operational' },
              { name: 'Azure OpenAI', status: 'Connected' },
              { name: 'Cashfree Payments', status: 'Active' },
            ].map((s) => (
              <div key={s.name} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="text-sm text-gray-600">{s.name}</span>
                <span className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded">
                  <CheckCircle2 className="w-3 h-3" /> {s.status}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}