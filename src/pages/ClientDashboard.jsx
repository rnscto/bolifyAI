import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bot, Users, PhoneCall, Calendar, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Button } from '@/components/ui/button';
import TrialBanner from '../components/TrialBanner';

export default function ClientDashboard() {
  const [user, setUser] = useState(null);
  const [client, setClient] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [stats, setStats] = useState({
    totalAgents: 0,
    activeAgents: 0,
    totalLeads: 0,
    totalCalls: 0,
    callsToday: 0,
    upcomingActivities: 0
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const currentUser = await apiClient.auth.me();
      setUser(currentUser);

      const clients = await apiClient.Client.filter({ user_id: currentUser.id });
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        // Use the new highly optimized backend Edge function instead of fetching thousands of records
        const [statsRes, subs] = await Promise.all([
          apiClient.functions.invoke('getClientDashboardStats', { client_id: clientData.id }),
          apiClient.Subscription.filter({ client_id: clientData.id, status: 'active' }, '-created_at', 1)
        ]);

        setSubscription(subs[0] || null);

        if (statsRes && statsRes.data && statsRes.data.success) {
          setStats(statsRes.data.stats);
        }
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const statCards = [
    {
      title: 'Active Agents',
      value: stats.activeAgents,
      subtitle: `of ${stats.totalAgents} total`,
      icon: Bot,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      link: 'ClientAgents'
    },
    {
      title: 'Total Leads',
      value: stats.totalLeads,
      subtitle: 'Manage leads',
      icon: Users,
      color: 'text-green-600',
      bgColor: 'bg-green-50',
      link: 'ClientLeads'
    },
    {
      title: 'Calls Today',
      value: stats.callsToday,
      subtitle: `${stats.totalCalls}+ recent calls`,
      icon: PhoneCall,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50',
      link: 'ClientCallLogs'
    },
    {
      title: 'Upcoming Activities',
      value: stats.upcomingActivities,
      subtitle: 'Scheduled',
      icon: Calendar,
      color: 'text-orange-600',
      bgColor: 'bg-orange-50',
      link: 'ClientActivities'
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">
            Welcome back, {user?.display_name || user?.data?.display_name || user?.full_name}
          </h1>
          <p className="text-gray-600 mt-1">{client?.company_name}</p>
        </div>
        <Link to={createPageUrl('ClientAgents')}>
          <Button className="bg-blue-600 hover:bg-blue-700">
            <Bot className="w-4 h-4 mr-2" />
            Create Agent
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Link key={stat.title} to={createPageUrl(stat.link)}>
              <Card className="cursor-pointer hover:shadow-md transition-shadow">
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
            </Link>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Link to={createPageUrl('ClientAgents')}>
              <Button variant="outline" className="w-full justify-start">
                <Bot className="w-4 h-4 mr-2" />
                Create New Agent
              </Button>
            </Link>
            <Link to={createPageUrl('ClientLeads')}>
              <Button variant="outline" className="w-full justify-start">
                <Users className="w-4 h-4 mr-2" />
                Import Leads
              </Button>
            </Link>
            <Link to={createPageUrl('ClientKnowledgeBase')}>
              <Button variant="outline" className="w-full justify-start">
                <TrendingUp className="w-4 h-4 mr-2" />
                Upload Training Data
              </Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Subscription Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">Billing Type</span>
                <span className="text-sm font-medium capitalize">
                  {client?.billing_type === 'unlimited' ? 'Unlimited' : 'Per-Minute'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">Account Status</span>
                <span className={`text-sm font-medium capitalize ${
                  client?.account_status === 'active' ? 'text-green-600' :
                  client?.account_status === 'trial' ? 'text-blue-600' :
                  client?.account_status === 'expired' ? 'text-red-600' : 'text-gray-600'
                }`}>
                  {client?.account_status || 'Unknown'}
                </span>
              </div>
              {client?.billing_type === 'unlimited' ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Channels</span>
                    <span className="text-sm font-medium">{client?.total_channels || 1}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Monthly Rate</span>
                    <span className="text-sm font-medium">
                      ₹{(
                        subscription?.rate_per_channel
                          ? subscription.rate_per_channel * (subscription.channels || client?.total_channels || 1)
                          : (client?.total_channels || 1) * (client?.monthly_rate_per_channel || 14999)
                      ).toLocaleString()}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Wallet Balance</span>
                    <span className={`text-sm font-medium ${(client?.wallet_balance || 0) < 100 ? 'text-red-600' : 'text-green-600'}`}>
                      ₹{(client?.wallet_balance || 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Rate</span>
                    <span className="text-sm font-medium">₹{client?.per_minute_rate || 4}/min</span>
                  </div>
                  {(client?.free_minutes_remaining || 0) > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-600">Free Minutes</span>
                      <span className="text-sm font-medium text-blue-600">{client.free_minutes_remaining} min</span>
                    </div>
                  )}
                </>
              )}
              <div className="pt-3 border-t">
                <Link to={createPageUrl('ClientSubscription')}>
                  <Button variant="outline" size="sm" className="w-full">
                    Manage Subscription
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}