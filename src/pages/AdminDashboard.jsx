import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Phone, PhoneCall, TrendingUp } from 'lucide-react';

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    totalClients: 0,
    activeClients: 0,
    totalDIDs: 0,
    assignedDIDs: 0,
    totalCalls: 0,
    callsToday: 0
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const [clients, dids, calls] = await Promise.all([
        base44.entities.Client.list(),
        base44.entities.DID.list(),
        base44.entities.CallLog.list('-created_date', 100)
      ]);

      const today = new Date().toISOString().split('T')[0];
      const callsToday = calls.filter(call => 
        call.created_date?.startsWith(today)
      ).length;

      setStats({
        totalClients: clients.length,
        activeClients: clients.filter(c => c.status === 'active').length,
        totalDIDs: dids.length,
        assignedDIDs: dids.filter(d => d.status === 'assigned').length,
        totalCalls: calls.length,
        callsToday
      });
    } catch (error) {
      console.error('Error loading stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const statCards = [
    {
      title: 'Total Clients',
      value: stats.totalClients,
      subtitle: `${stats.activeClients} active`,
      icon: Users,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50'
    },
    {
      title: 'DIDs Assigned',
      value: stats.assignedDIDs,
      subtitle: `of ${stats.totalDIDs} total`,
      icon: Phone,
      color: 'text-green-600',
      bgColor: 'bg-green-50'
    },
    {
      title: 'Calls Today',
      value: stats.callsToday,
      subtitle: `${stats.totalCalls} total`,
      icon: PhoneCall,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50'
    },
    {
      title: 'Revenue (Est.)',
      value: `₹${(stats.activeClients * 6500).toLocaleString()}`,
      subtitle: 'Monthly',
      icon: TrendingUp,
      color: 'text-orange-600',
      bgColor: 'bg-orange-50'
    }
  ];

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
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-600 mt-1">Monitor platform performance and client activity</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-gray-600">
                  {stat.title}
                </CardTitle>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-500">Activity feed coming soon...</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Platform Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">WebSocket Status</span>
                <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded">
                  Operational
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">Azure OpenAI</span>
                <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded">
                  Connected
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">Azure Voice API</span>
                <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded">
                  Active
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}