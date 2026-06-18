import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import FeatureGate from '../components/FeatureGate';
import CampaignCard from '../components/campaigns/CampaignCard';
import CreateCampaignDialog from '../components/campaigns/CreateCampaignDialog';
import { useCampaignLiveStats } from '../components/campaigns/useCampaignLiveStats';
import { Plus, Megaphone } from 'lucide-react';
import { toast } from 'sonner';

export default function ClientCampaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  // Live stats computed from CampaignLead records (does NOT depend on integration credits)
  const liveStats = useCampaignLiveStats(campaigns);

  useEffect(() => {
    loadData();
    // Pause background polling while the tab is hidden to avoid wasted refreshes.
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') loadData();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (clients.length > 0) {
        setClient(clients[0]);
        const data = await base44.entities.Campaign.filter(
          { client_id: clients[0].id }, '-created_date', 50
        );
        setCampaigns(data);
      }
    } catch (err) {
      console.error('Error loading campaigns:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async (campaignId) => {
    try {
      toast.info('Starting campaign...');
      const res = await base44.functions.invoke('executeCampaign', {
        campaign_id: campaignId,
        action: 'start'
      });
      if (res.data.success) {
        toast.success(`Batch started: ${res.data.initiated || 0} calls initiated`);
      } else {
        toast.error(res.data.error || 'Failed to start');
      }
      loadData();
    } catch (err) {
      toast.error('Failed to start campaign');
    }
  };

  const handlePause = async (campaignId) => {
    try {
      await base44.functions.invoke('executeCampaign', {
        campaign_id: campaignId,
        action: 'pause'
      });
      toast.success('Campaign paused');
      loadData();
    } catch (err) {
      toast.error('Failed to pause campaign');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Merge live (credit-independent) stats over the stored counters
  const enrichedCampaigns = campaigns.map(c => liveStats[c.id] ? { ...c, ...liveStats[c.id] } : c);

  const running = enrichedCampaigns.filter(c => c.status === 'running').length;
  const completed = enrichedCampaigns.filter(c => c.status === 'completed').length;
  const totalLeads = enrichedCampaigns.reduce((s, c) => s + (c.total_leads || 0), 0);

  return (
    <FeatureGate client={client} featureName="Campaigns">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Campaigns</h1>
            <p className="text-gray-600 mt-1">Schedule bulk cold calls & follow-up campaigns</p>
          </div>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-2" /> New Campaign
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white border rounded-xl p-4">
            <p className="text-2xl font-bold text-gray-900">{campaigns.length}</p>
            <p className="text-sm text-gray-500">Total Campaigns</p>
          </div>
          <div className="bg-white border rounded-xl p-4">
            <p className="text-2xl font-bold text-green-600">{running}</p>
            <p className="text-sm text-gray-500">Running</p>
          </div>
          <div className="bg-white border rounded-xl p-4">
            <p className="text-2xl font-bold text-emerald-600">{completed}</p>
            <p className="text-sm text-gray-500">Completed</p>
          </div>
          <div className="bg-white border rounded-xl p-4">
            <p className="text-2xl font-bold text-blue-600">{totalLeads}</p>
            <p className="text-sm text-gray-500">Total Leads</p>
          </div>
        </div>

        {/* Campaign list */}
        {campaigns.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border">
            <Megaphone className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 mb-4">No campaigns yet. Create your first campaign to start calling.</p>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> Create Campaign
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {enrichedCampaigns.map(c => (
              <CampaignCard key={c.id} campaign={c} onStart={handleStart} onPause={handlePause} />
            ))}
          </div>
        )}

        <CreateCampaignDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          client={client}
          onCreated={loadData}
        />
      </div>
    </FeatureGate>
  );
}