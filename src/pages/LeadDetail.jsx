import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft, Phone, Mail, PhoneCall, Loader2,
  Calendar, Clock, Send, Sparkles
} from 'lucide-react';
import { toast } from 'sonner';
import LeadProfileCard from '../components/leads/LeadProfileCard';
import LeadTimeline from '../components/leads/LeadTimeline';
import EmailComposer from '../components/email/EmailComposer';

export default function LeadDetail() {
  const [lead, setLead] = useState(null);
  const [client, setClient] = useState(null);
  const [callLogs, setCallLogs] = useState([]);
  const [activities, setActivities] = useState([]);
  const [outreachLogs, setOutreachLogs] = useState([]);
  const [campaignLeads, setCampaignLeads] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [callingLead, setCallingLead] = useState(false);
  const [emailComposerOpen, setEmailComposerOpen] = useState(false);
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [rescoring, setRescoring] = useState(false);

  const handleRescore = async () => {
    setRescoring(true);
    try {
      const res = await apiClient.functions.invoke('rescoreLeadFromHistory', { lead_id: leadId });
      if (res.data?.success) {
        toast.success(`Score updated: ${res.data.previous_score} → ${res.data.new_score}`);
        await loadAllData();
      } else if (res.data?.skipped) {
        toast.info('No call history with transcript found for this lead.');
      } else {
        toast.error(res.data?.error || 'Re-score failed');
      }
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    } finally {
      setRescoring(false);
    }
  };

  const urlParams = new URLSearchParams(window.location.search);
  const leadId = urlParams.get('id');

  useEffect(() => {
    if (leadId) loadAllData();
  }, [leadId]);

  const loadAllData = async () => {
    setLoading(true);
    const user = await apiClient.auth.me();
    let clientData = null;

    if (user.role === 'admin') {
      // Admin: get lead first, then load client from lead's client_id
      const leadData = await apiClient.Lead.get(leadId);
      setLead(leadData);
      clientData = await apiClient.Client.get(leadData.client_id);
    } else {
      const clients = await apiClient.Client.filter({ user_id: user.id });
      if (clients.length > 0) clientData = clients[0];
      const leadData = await apiClient.Lead.get(leadId);
      setLead(leadData);
    }
    setClient(clientData);

    // Fetch all related data in parallel
    const [calls, acts, emails, campLeads, agentsData] = await Promise.all([
      apiClient.CallLog.filter({ lead_id: leadId }, '-created_at', 50),
      apiClient.Activity.filter({ lead_id: leadId }, '-scheduled_date', 50),
      apiClient.OutreachLog.filter({ lead_id: leadId }, '-created_at', 50),
      apiClient.CampaignLead.filter({ lead_id: leadId }, '-created_at', 20),
      clientData ? apiClient.Agent.filter({ client_id: clientData.id }) : Promise.resolve([]),
    ]);

    setCallLogs(calls);
    setActivities(acts);
    setOutreachLogs(emails);
    setCampaignLeads(campLeads);
    setAgents(agentsData);
    setLoading(false);

    // Auto-fetch missing recordings in the background
    apiClient.post('/api/voice/fetch-recording', { bulk: true }).then(res => {
      if (res?.updated > 0) {
        apiClient.CallLog.filter({ lead_id: leadId }, '-created_at', 50)
          .then(data => setCallLogs(data));
      }
    }).catch(console.error);
  };

  const sendToGetwayCRM = async () => {
    setSendingWhatsApp(true);
    const response = await apiClient.functions.invoke('sendGetwayCRM', {
      lead_id: lead.id,
      contact_name: lead.name,
      contact_phone: lead.phone,
      contact_email: lead.email,
      client_company: client?.company_name,
      source: 'manual',
      lead_status: lead.status,
      lead_score: lead.score,
      qualification_tier: lead.qualification_tier
    });
    if (response.data.success) {
      toast.success('Contact sent to WhatsApp/RCS automation');
    } else {
      toast.error(response.data.error || 'Failed to send');
    }
    setSendingWhatsApp(false);
  };

  const initiateCall = async () => {
    const activeAgents = agents.filter(a => a.status === 'active');
    if (activeAgents.length === 0) {
      toast.error('No active agents available.');
      return;
    }
    setCallingLead(true);
    const response = await apiClient.functions.invoke('initiateCall', {
      lead_id: lead.id,
      agent_id: activeAgents[0].id,
      phone_number: lead.phone
    });
    if (response.data.success) {
      toast.success('Call initiated!');
      setTimeout(() => { setCallingLead(false); loadAllData(); }, 5000);
    } else {
      setCallingLead(false);
      toast.error(response.data.error || 'Failed to initiate call');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="text-center py-20 text-gray-500">
        <p>Lead not found.</p>
        <Link to={createPageUrl('ClientLeads')}>
          <Button variant="outline" className="mt-4"><ArrowLeft className="w-4 h-4 mr-2" /> Back to Leads</Button>
        </Link>
      </div>
    );
  }

  // Stats summary
  const totalCalls = callLogs.length;
  const completedCalls = callLogs.filter(c => c.status === 'completed').length;
  const emailsSent = outreachLogs.filter(o => o.status === 'sent').length;
  const pendingActivities = activities.filter(a => a.status === 'scheduled').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link to={createPageUrl('ClientLeads')}>
            <Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{lead.name}</h1>
            <p className="text-sm text-gray-500">{lead.phone} {lead.email ? `· ${lead.email}` : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to={createPageUrl('ClientCallLogs') + `?lead_phone=${encodeURIComponent(lead.phone)}`}>
              <PhoneCall className="w-4 h-4 mr-1.5" /> Call Logs
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to={createPageUrl('ClientCallbacks')}>
              <Calendar className="w-4 h-4 mr-1.5" /> Callbacks
            </Link>
          </Button>
          {lead?.phone && (
            <Button
              size="sm" variant="outline"
              onClick={sendToGetwayCRM}
              disabled={sendingWhatsApp}
              className="gap-1"
            >
              {sendingWhatsApp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              WhatsApp/RCS
            </Button>
          )}
          {lead?.email && (
            <Button
              size="sm" variant="outline"
              onClick={() => setEmailComposerOpen(true)}
              className="gap-1"
            >
              <Mail className="w-4 h-4" /> Email
            </Button>
          )}
          <Button
            size="sm" variant="outline"
            onClick={handleRescore}
            disabled={rescoring}
            className="gap-1"
            title="Re-score this lead using AI based on their most recent call"
          >
            {rescoring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Re-Score
          </Button>
          <Button
            size="sm"
            onClick={initiateCall}
            disabled={callingLead}
            className={callingLead ? 'bg-green-600 hover:bg-green-700 animate-pulse' : 'bg-blue-600 hover:bg-blue-700'}
          >
            {callingLead ? <><Loader2 className="w-4 h-4 animate-spin mr-1" /> Calling...</> : <><Phone className="w-4 h-4 mr-1.5" /> Call Now</>}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Profile + Stats */}
        <div className="space-y-4">
          <LeadProfileCard lead={lead} />

          {/* Quick stats */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Total Calls', value: totalCalls, icon: PhoneCall, color: 'text-blue-600 bg-blue-50' },
              { label: 'Completed', value: completedCalls, icon: Phone, color: 'text-green-600 bg-green-50' },
              { label: 'Emails Sent', value: emailsSent, icon: Mail, color: 'text-purple-600 bg-purple-50' },
              { label: 'Pending Tasks', value: pendingActivities, icon: Clock, color: 'text-orange-600 bg-orange-50' },
            ].map(s => (
              <Card key={s.label}>
                <CardContent className="p-3 flex items-center gap-2.5">
                  <div className={`p-2 rounded-lg ${s.color}`}><s.icon className="w-4 h-4" /></div>
                  <div>
                    <p className="text-lg font-bold leading-tight">{s.value}</p>
                    <p className="text-[11px] text-gray-500">{s.label}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Intent signals */}
          {lead.intent_signals?.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Intent Signals</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {lead.intent_signals.map(s => (
                  <Badge key={s} variant="outline" className="text-xs">{s.replace(/_/g, ' ')}</Badge>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: Full timeline */}
        <div className="lg:col-span-2">
          <LeadTimeline
            callLogs={callLogs}
            activities={activities}
            outreachLogs={outreachLogs}
            campaignLeads={campaignLeads}
            lead={lead}
          />
        </div>
      </div>

      <EmailComposer
        open={emailComposerOpen}
        onOpenChange={setEmailComposerOpen}
        lead={lead}
        client={client}
        onEmailSent={loadAllData}
      />
    </div>
  );
}