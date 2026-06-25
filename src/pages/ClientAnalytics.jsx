import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from 'recharts';
import {
  PhoneCall, PhoneOutgoing, PhoneIncoming, Clock, TrendingUp,
  Users, CheckCircle2, XCircle, PhoneMissed, Timer
} from 'lucide-react';
import FeatureGate from '../components/FeatureGate';

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

export default function ClientAnalytics() {
  const [client, setClient] = useState(null);
  const [calls, setCalls] = useState([]);
  const [leads, setLeads] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('30');

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length > 0) {
      const c = clients[0];
      setClient(c);
      const [callsData, leadsData, campaignsData] = await Promise.all([
        base44.entities.CallLog.filter({ client_id: c.id }, '-created_at', 500),
        base44.entities.Lead.filter({ client_id: c.id }, '-created_at', 1000),
        base44.entities.Campaign.filter({ client_id: c.id }),
      ]);
      setCalls(callsData);
      setLeads(leadsData);
      setCampaigns(campaignsData);
    }
    setLoading(false);
  };

  const filteredCalls = calls.filter(c => {
    if (period === 'all') return true;
    const days = parseInt(period);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return new Date(c.created_at) >= cutoff;
  });

  // --- Stat calculations ---
  const totalCalls = filteredCalls.length;
  const completedCalls = filteredCalls.filter(c => c.status === 'completed').length;
  const failedCalls = filteredCalls.filter(c => c.status === 'failed' || c.status === 'no_answer').length;
  const avgDuration = completedCalls > 0
    ? Math.round(filteredCalls.filter(c => c.duration).reduce((s, c) => s + c.duration, 0) / completedCalls)
    : 0;
  const connectRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0;

  // --- Calls per day ---
  const callsByDay = {};
  filteredCalls.forEach(c => {
    const day = c.created_at?.split('T')[0];
    if (day) callsByDay[day] = (callsByDay[day] || 0) + 1;
  });
  const dailyData = Object.entries(callsByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({
      date: new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      calls: count
    }));

  // --- Call status breakdown ---
  const statusCounts = {};
  filteredCalls.forEach(c => {
    statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
  });
  const statusData = Object.entries(statusCounts).map(([name, value]) => ({ name, value }));

  // --- Direction breakdown ---
  const outbound = filteredCalls.filter(c => c.direction === 'outbound').length;
  const inbound = filteredCalls.filter(c => c.direction === 'inbound').length;
  const directionData = [
    { name: 'Outbound', value: outbound, color: '#22c55e' },
    { name: 'Inbound', value: inbound, color: '#8b5cf6' },
  ].filter(d => d.value > 0);

  // --- Lead status funnel ---
  const leadStatusCounts = {};
  leads.forEach(l => {
    leadStatusCounts[l.status] = (leadStatusCounts[l.status] || 0) + 1;
  });
  const funnelOrder = ['new', 'contacted', 'interested', 'callback', 'converted', 'not_interested', 'do_not_call'];
  const funnelData = funnelOrder
    .filter(s => leadStatusCounts[s])
    .map(s => ({ name: s.replace('_', ' '), value: leadStatusCounts[s] }));

  // --- Calls by hour of day ---
  const hourCounts = Array(24).fill(0);
  filteredCalls.forEach(c => {
    if (c.call_start_time) {
      const h = new Date(c.call_start_time).getHours();
      hourCounts[h]++;
    }
  });
  const hourlyData = hourCounts.map((count, h) => ({
    hour: `${h.toString().padStart(2, '0')}:00`,
    calls: count
  })).filter(d => d.calls > 0);

  // --- Campaign performance ---
  const campaignData = campaigns.map(camp => ({
    name: camp.name?.substring(0, 15) || 'Unnamed',
    completed: camp.calls_completed || 0,
    failed: camp.calls_failed || 0,
  }));

  const formatDuration = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <FeatureGate client={client} featureName="Analytics">
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Call Analytics</h1>
            <p className="text-gray-600 mt-1">Detailed insights into your call performance</p>
          </div>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {[
            { title: 'Total Calls', value: totalCalls, icon: PhoneCall, color: 'text-blue-600', bg: 'bg-blue-50' },
            { title: 'Completed', value: completedCalls, icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50' },
            { title: 'Failed/Missed', value: failedCalls, icon: PhoneMissed, color: 'text-red-600', bg: 'bg-red-50' },
            { title: 'Connect Rate', value: `${connectRate}%`, icon: TrendingUp, color: 'text-purple-600', bg: 'bg-purple-50' },
            { title: 'Avg Duration', value: formatDuration(avgDuration), icon: Timer, color: 'text-orange-600', bg: 'bg-orange-50' },
          ].map(s => {
            const Icon = s.icon;
            return (
              <Card key={s.title}>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${s.bg}`}>
                      <Icon className={`w-5 h-5 ${s.color}`} />
                    </div>
                    <div>
                      <p className="text-xl font-bold">{s.value}</p>
                      <p className="text-xs text-gray-500">{s.title}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Charts Row 1 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Calls Over Time</CardTitle>
            </CardHeader>
            <CardContent>
              {dailyData.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={dailyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="calls" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <p className="text-sm text-gray-500 py-10 text-center">No call data for this period</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Call Direction</CardTitle>
            </CardHeader>
            <CardContent>
              {directionData.length > 0 ? (
                <div className="flex flex-col items-center">
                  <ResponsiveContainer width={180} height={180}>
                    <PieChart>
                      <Pie data={directionData} dataKey="value" cx="50%" cy="50%" outerRadius={75} innerRadius={45}>
                        {directionData.map((e, i) => <Cell key={i} fill={e.color} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex gap-4 mt-2">
                    {directionData.map(d => (
                      <div key={d.name} className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                        <span className="text-xs text-gray-600">{d.name}: <strong>{d.value}</strong></span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : <p className="text-sm text-gray-500 py-10 text-center">No data</p>}
            </CardContent>
          </Card>
        </div>

        {/* Charts Row 2 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Call Status Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              {statusData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={statusData}>
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {statusData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-sm text-gray-500 py-10 text-center">No data</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Peak Call Hours</CardTitle>
            </CardHeader>
            <CardContent>
              {hourlyData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={hourlyData}>
                    <XAxis dataKey="hour" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="calls" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-sm text-gray-500 py-10 text-center">No data</p>}
            </CardContent>
          </Card>
        </div>

        {/* Charts Row 3 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lead Conversion Funnel</CardTitle>
            </CardHeader>
            <CardContent>
              {funnelData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={funnelData} layout="vertical">
                    <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={100} />
                    <Tooltip />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {funnelData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-sm text-gray-500 py-10 text-center">No leads yet</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Campaign Performance</CardTitle>
            </CardHeader>
            <CardContent>
              {campaignData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={campaignData}>
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="completed" fill="#22c55e" name="Completed" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="failed" fill="#ef4444" name="Failed" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-sm text-gray-500 py-10 text-center">No campaigns yet</p>}
            </CardContent>
          </Card>
        </div>
      </div>
    </FeatureGate>
  );
}