import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import {
  TrendingUp, Users, Target, DollarSign, Plus, BarChart3,
  Phone, Activity, Loader2, ArrowRight
} from 'lucide-react';
import CRMTrialBanner from '../components/crm/CRMTrialBanner';
import DealKanban from '../components/crm/DealKanban';
import SalesReports from '../components/crm/SalesReports';
import { toast } from 'sonner';

export default function ClientCRMDashboard() {
  const [client, setClient] = useState(null);
  const [crmConfig, setCrmConfig] = useState(null);
  const [deals, setDeals] = useState([]);
  const [leads, setLeads] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('pipeline');

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) { setLoading(false); return; }

    const clientData = clients[0];
    setClient(clientData);

    if (!clientData.has_custom_crm) {
      setLoading(false);
      return;
    }

    const [configs, dealsData, leadsData, activitiesData] = await Promise.all([
      base44.entities.CRMConfig.filter({ client_id: clientData.id }),
      base44.entities.Deal.filter({ client_id: clientData.id }, '-created_at'),
      base44.entities.Lead.filter({ client_id: clientData.id }, '-created_at'),
      base44.entities.Activity.filter({ client_id: clientData.id }, '-scheduled_date')
    ]);

    if (configs.length > 0) setCrmConfig(configs[0]);
    setDeals(dealsData);
    setLeads(leadsData);
    setActivities(activitiesData);
    setLoading(false);
  };

  const handleStageDrop = async (dealId, newStage) => {
    const deal = deals.find(d => d.id === dealId);
    if (!deal || deal.stage === newStage) return;

    await base44.entities.Deal.update(dealId, { stage: newStage, last_activity_date: new Date().toISOString() });
    toast.success(`Deal moved to ${newStage}`);
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, stage: newStage } : d));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!client?.has_custom_crm) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-gray-500">CRM not set up yet.</p>
        <Link to={createPageUrl('ClientCRMSetup')}>
          <Button className="bg-indigo-600 hover:bg-indigo-700">Set Up CRM</Button>
        </Link>
      </div>
    );
  }

  const stages = crmConfig?.deal_stages || [];
  const openDeals = deals.filter(d => d.status === 'open');
  const pipelineValue = openDeals.reduce((s, d) => s + (d.value || 0), 0);
  const wonValue = deals.filter(d => d.status === 'won').reduce((s, d) => s + (d.value || 0), 0);
  const newLeadsToday = leads.filter(l => l.created_at?.startsWith(new Date().toISOString().split('T')[0])).length;

  return (
    <div className="space-y-6">
      <CRMTrialBanner client={client} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">CRM Dashboard</h1>
          <p className="text-gray-500 mt-1">
            <Badge variant="outline" className="mr-2">{crmConfig?.industry_name}</Badge>
            Sales Pipeline Overview
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={createPageUrl('ClientCRMDeals')}>
            <Button className="bg-indigo-600 hover:bg-indigo-700">
              <Plus className="w-4 h-4 mr-2" /> New Deal
            </Button>
          </Link>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-50"><DollarSign className="w-5 h-5 text-indigo-600" /></div>
              <div>
                <p className="text-xs text-gray-500">Pipeline</p>
                <p className="text-xl font-bold">₹{pipelineValue.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-50"><Target className="w-5 h-5 text-green-600" /></div>
              <div>
                <p className="text-xs text-gray-500">Won</p>
                <p className="text-xl font-bold">₹{wonValue.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-50"><Users className="w-5 h-5 text-purple-600" /></div>
              <div>
                <p className="text-xs text-gray-500">Open Deals</p>
                <p className="text-xl font-bold">{openDeals.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-50"><TrendingUp className="w-5 h-5 text-amber-600" /></div>
              <div>
                <p className="text-xs text-gray-500">New Leads Today</p>
                <p className="text-xl font-bold">{newLeadsToday}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="pipeline" className="mt-4">
          <DealKanban
            deals={openDeals}
            stages={stages}
            onStageDrop={handleStageDrop}
          />
        </TabsContent>

        <TabsContent value="reports" className="mt-4">
          <SalesReports
            deals={deals}
            leads={leads}
            activities={activities}
            stages={stages}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}