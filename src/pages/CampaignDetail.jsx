import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import CampaignLeadsTable from '../components/campaigns/CampaignLeadsTable';
import CampaignOutcomeChart from '../components/campaigns/CampaignOutcomeChart';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { ArrowLeft, Play, Pause, Square, RefreshCw, Users, Phone, Mail, Clock, AlertCircle, RotateCcw } from 'lucide-react';
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

  // Real-time subscriptions for live status updates
  useEffect(() => {
    if (!campaignId) return;

    // Subscribe to CampaignLead changes (status, outcome, transcript updates)
    const unsubLeads = base44.entities.CampaignLead.subscribe((event) => {
      if (event.data?.campaign_id !== campaignId) return;
      
      if (event.type === 'update') {
        setCampaignLeads(prev => prev.map(cl => cl.id === event.id ? { ...cl, ...event.data } : cl));
      } else if (event.type === 'create') {
        setCampaignLeads(prev => {
          if (prev.some(cl => cl.id === event.id)) return prev;
          return [...prev, event.data];
        });
      } else if (event.type === 'delete') {
        setCampaignLeads(prev => prev.filter(cl => cl.id !== event.id));
      }
    });

    // Subscribe to Campaign changes (status, counters, completion)
    const unsubCampaign = base44.entities.Campaign.subscribe((event) => {
      if (event.id === campaignId && event.type === 'update') {
        setCampaign(prev => prev ? { ...prev, ...event.data } : prev);
      }
    });

    return () => {
      unsubLeads();
      unsubCampaign();
    };
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
      } else if (res.data.error === 'insufficient_balance') {
        toast.error(`Insufficient balance! ₹${res.data.wallet_balance || 0} in wallet. Recommended top-up: ₹${res.data.recommended_topup || 500}`, {
          action: {
            label: 'Top Up Now',
            onClick: () => { window.location.href = createPageUrl('ClientSubscription'); }
          },
          duration: 10000
        });
      } else {
        toast.error(res.data.error || `Failed to ${action}`);
      }
      loadData();
    } catch (err) {
      // Handle 402 (insufficient balance) from axios error response
      const errData = err?.response?.data;
      if (errData?.error === 'insufficient_balance') {
        toast.error(`Insufficient balance! ₹${errData.wallet_balance || 0} in wallet. Please top up.`, {
          action: {
            label: 'Top Up Now',
            onClick: () => { window.location.href = createPageUrl('ClientSubscription'); }
          },
          duration: 10000
        });
      } else {
        toast.error(`Failed to ${action} campaign`);
      }
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

  // Calculate stats from actual CampaignLead data (more accurate than campaign counters)
  const completedLeads = campaignLeads.filter(cl => cl.status === 'completed').length;
  const failedLeads = campaignLeads.filter(cl => cl.status === 'failed').length;
  const callingLeads = campaignLeads.filter(cl => cl.status === 'calling').length;
  const pendingLeads = campaignLeads.filter(cl => cl.status === 'pending').length;
  const pendingReadyNow = campaignLeads.filter(cl => 
    cl.status === 'pending' && (!cl.followup_call_date || new Date(cl.followup_call_date) <= new Date())
  ).length;
  const pendingWaitingRetry = pendingLeads - pendingReadyNow;
  const processedLeads = completedLeads + failedLeads + callingLeads;
  const totalLeads = campaignLeads.length || campaign.total_leads || 0;

  // Build outcomes from lead data
  const outcomes = {};
  campaignLeads.forEach(cl => {
    if (cl.outcome) {
      outcomes[cl.outcome] = (outcomes[cl.outcome] || 0) + 1;
    }
  });

  const emailsSent = campaignLeads.filter(cl => cl.followup_email_sent).length;
  const callbacksScheduled = campaignLeads.filter(cl => cl.followup_scheduled).length;
  const progress = totalLeads > 0
    ? Math.round((processedLeads / totalLeads) * 100)
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
            <span>Progress: {processedLeads} / {totalLeads} calls</span>
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

      {/* Pending retry banner */}
      {pendingWaitingRetry > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-4 pb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600" />
              <div>
                <p className="text-sm font-medium text-amber-800">
                  {pendingWaitingRetry} leads waiting for scheduled retry
                </p>
                <p className="text-xs text-amber-600">
                  These leads were not answered and are scheduled for auto-retry later.
                  {pendingReadyNow > 0 && ` ${pendingReadyNow} leads are ready to call now.`}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-amber-300 text-amber-700 hover:bg-amber-100"
              onClick={async () => {
                try {
                  const waitingLeads = campaignLeads.filter(cl =>
                    cl.status === 'pending' && cl.followup_call_date && new Date(cl.followup_call_date) > new Date()
                  );
                  for (const cl of waitingLeads) {
                    await base44.entities.CampaignLead.update(cl.id, { followup_call_date: null });
                  }
                  toast.success(`${waitingLeads.length} leads cleared for immediate calling`);
                  loadData();
                } catch (err) {
                  toast.error('Failed to clear retry schedule');
                }
              }}
            >
              <RotateCcw className="w-4 h-4 mr-1" /> Call All Now
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Users className="w-6 h-6 text-blue-600" />
            <div>
              <p className="text-xl font-bold">{totalLeads}</p>
              <p className="text-xs text-gray-500">Total Leads</p>
            </div>
          </CardContent>
        </Card>
        <Card className={pendingLeads > 0 ? 'border-amber-200' : ''}>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Clock className="w-6 h-6 text-amber-600" />
            <div>
              <p className="text-xl font-bold">{pendingLeads}</p>
              <p className="text-xs text-gray-500">
                Pending {pendingWaitingRetry > 0 ? `(${pendingWaitingRetry} waiting)` : ''}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Phone className="w-6 h-6 text-green-600" />
            <div>
              <p className="text-xl font-bold">{completedLeads}</p>
              <p className="text-xs text-gray-500">Completed</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <Phone className="w-6 h-6 text-red-600" />
            <div>
              <p className="text-xl font-bold">{failedLeads}</p>
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

        {/* Call Script */}
        {campaign.call_script && Object.values(campaign.call_script).some(v => v && v.trim()) && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">📋 Call Script</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { key: 'opening', label: 'Opening / Greeting', color: 'border-l-blue-500' },
                  { key: 'pitch', label: 'Main Pitch', color: 'border-l-green-500' },
                  { key: 'objection_handling', label: 'Objection Handling', color: 'border-l-yellow-500' },
                  { key: 'closing', label: 'Closing / CTA', color: 'border-l-purple-500' },
                ].filter(s => campaign.call_script[s.key]?.trim()).map(section => (
                  <div key={section.key} className={`border-l-4 ${section.color} pl-3`}>
                    <p className="text-xs font-semibold text-gray-600 uppercase mb-1">{section.label}</p>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{campaign.call_script[section.key]}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI Follow-up Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-xs font-semibold text-yellow-700 uppercase mb-1">Interested (Meeting/Demo)</p>
              {campaign.followup_rules?.interested_email && (
                <p className="text-yellow-600">✓ AI-personalized follow-up email{campaign.followup_rules?.interested_ai_email ? ' ✨' : ''}</p>
              )}
              {campaign.followup_rules?.interested_callback_days && (
                <p className="text-yellow-600">✓ Callback in {campaign.followup_rules.interested_callback_days} days</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold text-purple-700 uppercase mb-1">Callback</p>
              {campaign.followup_rules?.callback_create_task !== false && (
                <p className="text-purple-600">✓ Auto-create agent task{campaign.followup_rules?.callback_ai_talking_points !== false ? ' with AI talking points ✨' : ''}</p>
              )}
              {campaign.followup_rules?.callback_email && (
                <p className="text-purple-600">✓ Confirmation email</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-600 uppercase mb-1">Not Answered</p>
              {campaign.followup_rules?.no_answer_retry ? (
                <p className="text-gray-600">✓ Auto-retry every {campaign.followup_rules.no_answer_retry_hours || 4}h, max {campaign.followup_rules.no_answer_max_retries || 3} retries</p>
              ) : (
                <p className="text-gray-400">✗ No retry</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Leads table with transcripts */}
      <CampaignLeadsTable campaignLeads={campaignLeads} />
    </div>
  );
}