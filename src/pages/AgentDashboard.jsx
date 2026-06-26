import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Bot, RefreshCw } from 'lucide-react';
import AgentPerformanceCards from '../components/agent-dashboard/AgentPerformanceCards';
import OutcomeBreakdown from '../components/agent-dashboard/OutcomeBreakdown';
import LeadScoreDistribution from '../components/agent-dashboard/LeadScoreDistribution';
import ActiveTasks from '../components/agent-dashboard/ActiveTasks';
import RecentCallsTable from '../components/agent-dashboard/RecentCallsTable';
import AITalkingPoints from '../components/agent-dashboard/AITalkingPoints';

export default function AgentDashboard() {
  const [agent, setAgent] = useState(null);
  const [client, setClient] = useState(null);
  const [callLogs, setCallLogs] = useState([]);
  const [campaignLeads, setCampaignLeads] = useState([]);
  const [leads, setLeads] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const user = await apiClient.auth.me();
    const clients = await apiClient.Client.filter({ user_id: user.id });
    if (clients.length === 0) { setLoading(false); return; }

    const clientData = clients[0];
    setClient(clientData);

    const agents = await apiClient.Agent.filter({ client_id: clientData.id });
    if (agents.length === 0) { setLoading(false); return; }

    const agentData = agents[0];
    setAgent(agentData);

    const [calls, cLeads, allLeads, acts] = await Promise.all([
      apiClient.CallLog.filter({ client_id: clientData.id, agent_id: agentData.id }, '-created_at', 200),
      apiClient.CampaignLead.filter({ client_id: clientData.id }, '-created_at', 500),
      apiClient.Lead.filter({ client_id: clientData.id }, '-created_at', 500),
      apiClient.Activity.filter({ client_id: clientData.id }, '-created_at', 100),
    ]);

    setCallLogs(calls);
    setCampaignLeads(cLeads);
    setLeads(allLeads);
    setActivities(acts);
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-400">
        <Bot className="w-12 h-12 mb-3" />
        <p>No agent found. Set up your agent first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-blue-100 rounded-xl">
            <Bot className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{agent.name} — Performance</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge className={agent.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}>
                {agent.status}
              </Badge>
              <span className="text-sm text-gray-500">{agent.industry || 'General'}</span>
              <span className="text-sm text-gray-400">•</span>
              <span className="text-sm text-gray-500">{client?.company_name}</span>
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadData}>
          <RefreshCw className="w-4 h-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Performance KPIs */}
      <AgentPerformanceCards callLogs={callLogs} campaignLeads={campaignLeads} leads={leads} />

      {/* AI Talking Points for active calls */}
      <AITalkingPoints activeCalls={callLogs} agent={agent} leads={leads} />

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <OutcomeBreakdown campaignLeads={campaignLeads} />
        <LeadScoreDistribution leads={leads} />
      </div>

      {/* Tasks + Recent calls */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ActiveTasks activities={activities} />
        <RecentCallsTable callLogs={callLogs} leads={leads} />
      </div>
    </div>
  );
}