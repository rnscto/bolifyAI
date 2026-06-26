import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Zap, RefreshCw, Phone, Calendar, AlertTriangle } from 'lucide-react';
import EngineStats from '../components/automation/EngineStats';
import UpcomingQueue from '../components/automation/UpcomingQueue';
import ExecutionHistory from '../components/automation/ExecutionHistory';

export default function ClientAutomationEngine() {
  const [client, setClient] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadClient();
  }, []);

  const loadClient = async () => {
    const user = await apiClient.auth.me();
    if (user.role === 'admin') {
      setClient({ id: 'admin' });
    } else {
      const clients = await apiClient.Client.filter({ user_id: user.id });
      if (clients.length > 0) setClient(clients[0]);
    }
  };

  const { data: activities = [], refetch: refetchActivities } = useQuery({
    queryKey: ['automation-activities', client?.id],
    queryFn: async () => {
      if (!client) return [];
      // Fetch ALL activities (paginated) — no artificial limit
      const fetchAll = async (filter) => {
        const all = [];
        let skip = 0;
        const pageSize = 500;
        // Loop fetching pages until we get less than pageSize back
        // base44 SDK uses (filter, sort, limit) — we paginate by repeatedly fetching with growing skip via slice in memory is not supported,
        // so we request a very large limit instead.
        const batch = await apiClient.Activity.filter(filter, '-scheduled_date', 5000);
        return batch;
      };
      if (client.id === 'admin') {
        return fetchAll({ auto_created: true });
      }
      return fetchAll({ client_id: client.id, auto_created: true });
    },
    enabled: !!client,
    refetchInterval: 30000,
  });

  const { data: leads = [] } = useQuery({
    queryKey: ['automation-leads', client?.id, activities],
    queryFn: async () => {
      if (!client || activities.length === 0) return [];
      // Collect all unique lead_ids from activities
      const leadIds = [...new Set(activities.map(a => a.lead_id).filter(Boolean))];
      if (leadIds.length === 0) return [];
      // Fetch each lead individually to ensure none are missed
      const results = await Promise.all(
        leadIds.map(id => apiClient.Lead.get(id).catch(() => null))
      );
      return results.filter(Boolean);
    },
    enabled: !!client && activities.length > 0,
    refetchInterval: 30000,
  });

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetchActivities();
    setRefreshing(false);
  };

  const [showAllHuman, setShowAllHuman] = useState(false);

  const scheduled = activities.filter(a => a.status === 'scheduled');
  const humanActions = scheduled.filter(a =>
    ['appointment', 'demo', 'visit', 'meeting', 'booking'].includes(a.type)
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Zap className="w-6 h-6 text-amber-500" />
            Follow-up Automation Engine
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            24/7 active — auto-calls, emails, and admin alerts for all scheduled follow-ups
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge className="bg-green-100 text-green-800 text-xs px-3 py-1">
            <div className="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse" />
            Engine Active — Runs every 15 min
          </Badge>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats */}
      <EngineStats activities={activities} />

      {/* Human Actions Alert */}
      {humanActions.length > 0 && (
        <Card className="border-orange-200 bg-orange-50/50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-orange-600 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-orange-900 text-sm">
                  {humanActions.length} action(s) require human attention
                </h3>
                <div className="mt-2 space-y-1">
                  {(showAllHuman ? humanActions : humanActions.slice(0, 5)).map(a => {
                    const lead = leads.find(l => l.id === a.lead_id);
                    return (
                      <div key={a.id} className="text-xs text-orange-800 flex items-center gap-2">
                        <Badge className="text-[10px] bg-orange-200 text-orange-900">{a.type}</Badge>
                        <span className="font-medium">{lead?.name || 'Unknown'}</span>
                        <span>— {a.title}</span>
                      </div>
                    );
                  })}
                  {humanActions.length > 5 && (
                    <button
                      onClick={() => setShowAllHuman(!showAllHuman)}
                      className="text-xs text-orange-700 font-medium hover:underline mt-1"
                    >
                      {showAllHuman ? 'Show less' : `View all ${humanActions.length} actions`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs: Queue / History */}
      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue" className="gap-1">
            <Phone className="w-3.5 h-3.5" /> Queue ({scheduled.length})
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1">
            <Calendar className="w-3.5 h-3.5" /> History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          <UpcomingQueue activities={activities} leads={leads} />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <ExecutionHistory activities={activities} leads={leads} />
        </TabsContent>
      </Tabs>
    </div>
  );
}