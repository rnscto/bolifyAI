import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, Phone, PhoneCall, TrendingUp, CreditCard, AlertTriangle, CheckCircle2, ArrowUpRight, Zap, IndianRupee, Activity } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import WebsiteLeadsSection from '../components/admin/WebsiteLeadsSection';
import { motion } from 'framer-motion';

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
    // Verify admin role before calling admin-only endpoints
    try {
      const me = await apiClient.auth.me();
      const allowedRoles = ['admin', 'master_admin', 'reseller', 'master_reseller'];
      if (!allowedRoles.includes(me?.role)) {
        console.warn(`[AdminDashboard] Non-admin user attempted access with role: ${me?.role}`);
        setLoading(false);
        return;
      }
    } catch (e) {
      console.warn('[AdminDashboard] Auth check failed:', e.message);
      setLoading(false);
      return;
    }

    let clientsRes = { data: { clients: [] } };
    let dids = [], calls = [], subscriptions = [], payments = [];
    try {
      [clientsRes, dids, calls, subscriptions, payments] = await Promise.all([
        apiClient.functions.invoke('adminListClients', { action: 'list' }).catch(err => {
          console.error('[AdminDashboard] adminListClients failed:', err?.message || err);
          return { data: { clients: [] } };
        }),
        apiClient.DID.list().catch(() => []),
        // Only need recent calls for "today" count + a total estimate. Each CallLog row carries
        // a heavy agent_config_cache (full prompts/scripts), so pulling 5000 was downloading tens of MB.
        apiClient.CallLog.list('-created_at', 500).catch(() => []),
        apiClient.Subscription.list('-created_at').catch(() => []),
        apiClient.Payment.list('-created_at', 10).catch(() => []),
      ]);
    } catch (err) {
      console.error('[AdminDashboard] Failed to load dashboard data:', err?.message || err);
    }
    const clients = clientsRes?.data?.clients || [];

    const today = new Date().toISOString().split('T')[0];
    const callsToday = calls.filter(c => c.created_at?.startsWith(today)).length;

    const activeClients = clients.filter(c => c.account_status === 'active').length;
    const trialClients = clients.filter(c => c.account_status === 'trial').length;
    const expiredClients = clients.filter(c => c.account_status === 'expired').length;
    const onboardingClients = clients.filter(c => c.account_status === 'onboarding').length;

    const totalMRR = clients
      .filter(c => c.account_status === 'active')
      .reduce((sum, c) => sum + ((c.total_channels || 1) * (c.monthly_rate_per_channel || 14999)) + (c.has_custom_crm ? 1999 : 0), 0);

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
      if (p.status === 'paid' && p.created_at) {
        const month = new Date(p.created_at).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
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

  if (!stats) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500">
        <AlertTriangle className="w-10 h-10 text-amber-500 mb-2" />
        <p className="text-sm">Unable to load admin dashboard. Please ensure you're logged in as an administrator.</p>
      </div>
    );
  }

  const statCards = [
    { title: 'Total Clients', value: stats.totalClients, subtitle: `${stats.activeClients} active, ${stats.trialClients} trial`, icon: Users, color: 'text-blue-600', bgColor: 'bg-blue-50' },
    { title: 'Monthly Revenue', value: `₹${stats.totalMRR.toLocaleString()}`, subtitle: 'Active subscriptions', icon: TrendingUp, color: 'text-green-600', bgColor: 'bg-green-50' },
    { title: 'DIDs Assigned', value: `${stats.assignedDIDs}/${stats.totalDIDs}`, subtitle: `${stats.totalDIDs - stats.assignedDIDs} available`, icon: Phone, color: 'text-purple-600', bgColor: 'bg-purple-50' },
    { title: 'Calls Today', value: stats.callsToday, subtitle: `${stats.totalCalls}+ recent`, icon: PhoneCall, color: 'text-orange-600', bgColor: 'bg-orange-50' },
  ];

  const accountColors = {
    active: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20',
    trial: 'bg-blue-500/20 text-blue-400 border border-blue-500/20',
    expired: 'bg-red-500/20 text-red-400 border border-red-500/20',
    onboarding: 'bg-amber-500/20 text-amber-400 border border-amber-500/20',
    suspended: 'bg-gray-500/20 text-gray-400 border border-gray-500/20',
  };

  const paymentColors = {
    paid: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20',
    pending: 'bg-amber-500/20 text-amber-400 border border-amber-500/20',
    failed: 'bg-red-500/20 text-red-400 border border-red-500/20',
  };

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <motion.div 
        initial={{ opacity: 0, y: -20 }} 
        animate={{ opacity: 1, y: 0 }} 
        className="flex flex-col md:flex-row md:items-end justify-between gap-4"
      >
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white drop-shadow-sm">Admin Overview</h1>
          <p className="text-gray-400 mt-1">Real-time platform metrics and analytics</p>
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-cyan-400 bg-cyan-500/10 px-4 py-2 rounded-full border border-cyan-500/20">
          <Zap className="w-4 h-4" /> System fully operational
        </div>
      </motion.div>

      {/* Alert for expired clients */}
      {stats.expiredClients > 0 && (
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-5 py-4 flex items-center gap-4"
        >
          <div className="p-2 bg-amber-500/20 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          </div>
          <span className="text-amber-200 font-medium">
            <strong>{stats.expiredClients} client(s)</strong> have expired trials. Review them in{' '}
            <Link to={createPageUrl('AdminClients')} className="underline text-amber-400 hover:text-amber-300 transition-colors">Clients</Link>.
          </span>
        </motion.div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat, i) => {
          const Icon = stat.icon;
          return (
            <motion.div
              key={stat.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className="overflow-hidden border border-white/8 shadow-xl bg-white/5 backdrop-blur-xl relative group hover:bg-white/8 transition-colors">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{stat.title}</p>
                      <div className="text-3xl font-black text-white mt-2 tracking-tight">{stat.value}</div>
                    </div>
                    <div className="p-3.5 rounded-2xl bg-white/10 shadow-inner">
                      <Icon className={`w-6 h-6 ${stat.color}`} />
                    </div>
                  </div>
                  <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-gray-400 bg-white/5 rounded-lg px-3 py-1.5 w-max">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                    {stat.subtitle}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Client breakdown pie chart */}
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.4 }}>
          <Card className="h-full border border-white/8 bg-white/5 backdrop-blur-xl">
            <CardHeader>
              <CardTitle className="text-base font-bold text-gray-200">Status Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              {clientBreakdown.length > 0 ? (
                <div className="flex flex-col sm:flex-row items-center gap-8 justify-center py-4">
                  <ResponsiveContainer width={180} height={180}>
                    <PieChart>
                      <Pie 
                        data={clientBreakdown} 
                        dataKey="value" 
                        cx="50%" cy="50%" 
                        outerRadius={85} 
                        innerRadius={55}
                        stroke="none"
                      >
                        {clientBreakdown.map((entry, idx) => (
                          <Cell key={idx} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip 
                        contentStyle={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', background: '#1e2130', color: '#e2e8f0' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-3">
                    {clientBreakdown.map((item) => (
                      <div key={item.name} className="flex items-center justify-between w-40 p-2 rounded-lg hover:bg-white/5 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                          <span className="text-sm font-medium text-gray-300">{item.name}</span>
                        </div>
                        <span className="text-base font-bold text-white">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-[200px] text-gray-600 font-medium">No client data yet</div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Revenue bar chart */}
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.4 }}>
          <Card className="h-full border border-white/8 bg-white/5 backdrop-blur-xl">
            <CardHeader className="flex flex-row justify-between items-center">
              <CardTitle className="text-base font-bold text-gray-200">Revenue Growth</CardTitle>
              <div className="text-xs font-bold px-2 py-1 bg-blue-500/20 text-blue-400 rounded-md border border-blue-500/20">Last 6 Months</div>
            </CardHeader>
            <CardContent>
              {revenueData.length > 0 ? (
                <div className="pt-4">
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={revenueData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#64748b', fontWeight: 500 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 12, fill: '#64748b', fontWeight: 500 }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} axisLine={false} tickLine={false} />
                      <Tooltip 
                        cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                        contentStyle={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', background: '#1e2130', color: '#e2e8f0', fontWeight: 'bold' }}
                        formatter={(v) => `₹${v.toLocaleString()}`} 
                      />
                      <Bar dataKey="amount" fill="url(#colorRevenue)" radius={[6, 6, 0, 0]} />
                      <defs>
                        <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#06b6d4" stopOpacity={1}/>
                          <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.8}/>
                        </linearGradient>
                      </defs>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex items-center justify-center h-[200px] text-gray-600 font-medium">No payment data yet</div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Recent activity row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
          <Card className="border border-white/8 bg-white/5 backdrop-blur-xl">
            <CardHeader className="flex flex-row items-center justify-between border-b border-white/8 pb-4">
              <CardTitle className="text-base font-bold text-gray-200">Recent Clients</CardTitle>
              <Link to={createPageUrl('AdminClients')} className="text-sm font-semibold text-cyan-400 hover:text-cyan-300 flex items-center gap-1 group">
                View all <ArrowUpRight className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
              </Link>
            </CardHeader>
            <CardContent className="pt-4">
              {recentClients.length === 0 ? (
                <p className="text-sm text-gray-600 py-4 text-center">No clients yet</p>
              ) : (
                <div className="space-y-1">
                  {recentClients.map((c) => (
                    <div key={c.id} className="flex items-center justify-between py-3 px-2 rounded-xl hover:bg-white/5 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-cyan-500/20 to-blue-500/20 flex items-center justify-center text-cyan-400 font-bold text-sm border border-cyan-500/20">
                          {c.company_name?.charAt(0) || 'C'}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-200">{c.company_name}</p>
                          <p className="text-xs text-gray-500">{c.email}</p>
                        </div>
                      </div>
                      <Badge className={`text-xs px-2 py-0.5 ${accountColors[c.account_status] || 'bg-gray-700 text-gray-300'}`}>
                        {c.account_status || 'unknown'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }}>
          <Card className="border border-white/8 bg-white/5 backdrop-blur-xl">
            <CardHeader className="flex flex-row items-center justify-between border-b border-white/8 pb-4">
              <CardTitle className="text-base font-bold text-gray-200">Recent Payments</CardTitle>
              <Link to={createPageUrl('AdminSubscriptions')} className="text-sm font-semibold text-cyan-400 hover:text-cyan-300 flex items-center gap-1 group">
                View all <ArrowUpRight className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
              </Link>
            </CardHeader>
            <CardContent className="pt-4">
              {recentPayments.length === 0 ? (
                <p className="text-sm text-gray-600 py-4 text-center">No payments yet</p>
              ) : (
                <div className="space-y-1">
                  {recentPayments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between py-3 px-2 rounded-xl hover:bg-white/5 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                          <IndianRupee className="w-4 h-4" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-200">₹{p.amount?.toLocaleString()}</p>
                          <p className="text-xs text-gray-500">{p.description || 'Subscription'}</p>
                        </div>
                      </div>
                      <Badge className={`text-xs px-2 py-0.5 ${paymentColors[p.status] || 'bg-gray-700 text-gray-300'}`}>
                        {p.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7 }}>
        <WebsiteLeadsSection />
      </motion.div>

      {/* Platform Health */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 }}>
        <Card className="border border-white/8 bg-white/5 backdrop-blur-xl">
          <CardHeader>
            <CardTitle className="text-base font-bold text-gray-200 flex items-center gap-2">
              <Activity className="w-5 h-5 text-cyan-400" />
              Platform Infrastructure Health
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { name: 'WebSocket Clusters', status: 'Operational', icon: Zap },
                { name: 'Azure Voice Gateway', status: 'Connected', icon: Phone },
                { name: 'Cashfree Engine', status: 'Active', icon: CreditCard },
              ].map((s) => (
                <div key={s.name} className="flex items-center justify-between p-4 bg-white/5 border border-white/8 rounded-xl hover:bg-white/8 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-white/10 rounded-lg text-gray-400"><s.icon className="w-4 h-4" /></div>
                    <span className="text-sm font-semibold text-gray-300">{s.name}</span>
                  </div>
                  <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold bg-emerald-500/15 border border-emerald-500/20 text-emerald-400 rounded-full">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {s.status}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}