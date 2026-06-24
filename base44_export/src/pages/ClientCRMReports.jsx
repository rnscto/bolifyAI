import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2 } from 'lucide-react';
import CRMTrialBanner from '../components/crm/CRMTrialBanner';
import SalesReports from '../components/crm/SalesReports';

export default function ClientCRMReports() {
  const [client, setClient] = useState(null);
  const [crmConfig, setCrmConfig] = useState(null);
  const [deals, setDeals] = useState([]);
  const [leads, setLeads] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) { setLoading(false); return; }

    const clientData = clients[0];
    setClient(clientData);

    const [configs, dealsData, leadsData, activitiesData] = await Promise.all([
      base44.entities.CRMConfig.filter({ client_id: clientData.id }),
      base44.entities.Deal.filter({ client_id: clientData.id }, '-created_date'),
      base44.entities.Lead.filter({ client_id: clientData.id }, '-created_date'),
      base44.entities.Activity.filter({ client_id: clientData.id }, '-scheduled_date')
    ]);

    if (configs.length > 0) setCrmConfig(configs[0]);
    setDeals(dealsData);
    setLeads(leadsData);
    setActivities(activitiesData);
    setLoading(false);
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-600" /></div>;

  return (
    <div className="space-y-6">
      <CRMTrialBanner client={client} />
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Sales Reports</h1>
        <p className="text-gray-600 mt-1">Comprehensive analytics and forecasting</p>
      </div>
      <SalesReports
        deals={deals}
        leads={leads}
        activities={activities}
        stages={crmConfig?.deal_stages || []}
      />
    </div>
  );
}