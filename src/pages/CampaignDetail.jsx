import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import CampaignLeadsTable from '../components/campaigns/CampaignLeadsTable';
import CampaignOutcomeChart from '../components/campaigns/CampaignOutcomeChart';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { ArrowLeft, Play, Pause, Square, RefreshCw, Users, Phone, Mail, Clock } from 'lucide-react';
import { toast } from 'sonner';

const statusColors = {
  draft: 'bg-gray-100 text-gray-700',
  scheduled: 'bg-blue-100 text-blue-700',
  running: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
};

export default function CampaignDetail() {
  const [campaign, setCampaign] = useState(null);
  const [campaignLeads, setCampaignLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  const urlParams = new URLSearchParams(window.location.search);
  const campaignId = urlParams.get('id');

  useEffect(() => {
    if (campaignId) loadData();
  }, [campaignId]);

  const loadData = async () => {
    try {
      const [campaignData, leadsData] = await Promise.all([
        base44.entities.Campaign.get(campaignId),
        base44.entities.CampaignLead.filter({ campaign_id: campaignId }, 'created_date', 500)
      ]);
      setCampaign(campaignData);
      setCampaignLeads(leadsData);
    } catch (err) {
      console.error('Error loading campaign:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action) => {
    try {
      const res = await base44.functions.invoke('executeCampaign', {
        campaign_id: campaignId,
        action
      });
      if (res.data.success) {
        if (action === 'start') {
          toast.success(`${res.data.initiated || 0} calls initiated, ${res.data.remaining || 0} remaining`);
        } else {
          toast.success(`Campaign ${action}d`);
        }
      } else {
        toast.error(res.data.error || `Failed to ${action}`);
      }
      loadData();
    } catch (err) {
      toast.error(`Failed to ${action} campaign`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!campaign) {
    return <div className="text-center py-16 text-gray-500">Campaign not found</div>;
  }

  const outcomes = campaign.outcomes_summary || {};
  const emailsSent = campaignLeads.filter(cl => cl.followup_email_sent).length;
  const callbacksScheduled = campaignLeads.filter(cl => cl.followup_scheduled).length;
  const progress = campaign.total_leads > 0
    ? Math.round(((campaign.calls_completed + campaign.calls_failed) / campaign.total_leads) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Link to={createPageUrl('ClientCampaigns')}>
            <Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{campaign.name}</h1>
            <div className="flex gap-2 mt-1">
              <Badge className={statusColors[campaign.status]}>{campaign.status}</Badge>
              <Badge variant="outline">{campaign.type === 'cold_call' ? 'Cold Call' : 'Follow-up'}</Badge>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadData}>
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
          {['draft', 'paused'].includes(campaign.status) && (
            <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => handleAction('start')}>
              <Play className="w-4 h-4 mr-1" /> {campaign.status === 'paused' ? 'Resume' : 'Start'}
            </Button>
          )}
          {campaign.status === 'running' && (
            <Button size="sm" variant="outline" onClick={() => handleAction('pause')}>
              <Pause className="w-4 h-4 mr-1" /> Pause
            </Button>
          )}
          {['draft', 'paused', 'running'].includes(campaign.status) && (
            <Button size="sm" variant="destructive" onClick={() => handleAction('cancel')}>
              <Square className="w-4 h-4 mr-1" /> Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Progress */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex justify-between text-sm text-gray-600 mb-2">
            <span>Progress: {campaign.calls_completed + campaign.calls_failed} / {campaign.total_leads} calls</span>
            <span className="font-semibold">{progress}%</span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
          {campaign.started_at && (
            <p className="text-xs text-gray-400 mt-2">
              Started: {new Date(campaign.started_at).toLocaleString()}
              {campaign.completed_at && ` • Completed: ${new Date(campaign.completed_at).toLocaleString()}`}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Users className="w-6 h-6 text-blue-600" />
            <div>
              <p className="text-xl font-bold">{campaign.total_leads}</p>
              <p className="text-xs text-gray-500">Total Leads</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Phone className="w-6 h-6 text-green-600" />
            <div>
              <p className="text-xl font-bold">{campaign.calls_completed}</p>
              <p className="text-xs text-gray-500">Completed</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Phone className="w-6 h-6 text-red-600" />
            <div>
              <p className="text-xl font-bold">{campaign.calls_failed}</p>
              <p className="text-xs text-gray-500">Failed</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Mail className="w-6 h-6 text-indigo-600" />
            <div>
              <p className="text-xl font-bold">{emailsSent}</p>
              <p className="text-xs text-gray-500">Emails Sent</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Clock className="w-6 h-6 text-orange-600" />
            <div>
              <p className="text-xl font-bold">{callbacksScheduled}</p>
              <p className="text-xs text-gray-500">Callbacks</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Outcome chart + follow-up rules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <CampaignOutcomeChart outcomes={outcomes} />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Follow-up Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {campaign.followup_rules?.interested_email && (
              <p className="text-green-700">✓ Send email if interested</p>
            )}
            {campaign.followup_rules?.interested_callback_days && (
              <p className="text-blue-700">✓ Schedule callback in {campaign.followup_rules.interested_callback_days} days</p>
            )}
            {campaign.followup_rules?.callback_email && (
              <p className="text-yellow-700">✓ Confirmation email for callbacks</p>
            )}
            {campaign.followup_rules?.no_answer_retry && (
              <p className="text-gray-600">✓ Retry no-answer leads after {campaign.followup_rules.no_answer_retry_hours || 4}h</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Leads table with transcripts */}
      <CampaignLeadsTable campaignLeads={campaignLeads} />
    </div>
  );
}