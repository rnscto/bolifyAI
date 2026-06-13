import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import CallScriptEditor from './CallScriptEditor';
import CampaignWhatsAppRules from './CampaignWhatsAppRules';
import PhoneMaskToggle from '../PhoneMaskToggle';
import { usePhoneMask } from '../../lib/phoneMask';

export default function CreateCampaignDialog({ open, onOpenChange, client, onCreated }) {
  const [agents, setAgents] = useState([]);
  const [leads, setLeads] = useState([]);
  const [leadGroups, setLeadGroups] = useState([]);
  const [notAnsweredIds, setNotAnsweredIds] = useState(new Set());
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [leadFilter, setLeadFilter] = useState('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');
  const { mask: maskPhoneNumber } = usePhoneMask();
  const [form, setForm] = useState({
    name: '',
    type: 'cold_call',
    agent_id: '',
    max_concurrent_calls: 5,
    interested_email: true,
    interested_ai_email: true,
    interested_callback_days: 2,
    callback_email: true,
    callback_create_task: true,
    callback_ai_talking_points: true,
    not_interested_email: false,
    no_answer_retry: true,
    no_answer_retry_hours: 4,
    no_answer_max_retries: 3,
    call_script: { opening: '', pitch: '', objection_handling: '', closing: '' },
    whatsapp_auto_send: { enabled: false, intent_template_map: {} },
  });

  useEffect(() => {
    if (open && client) loadData();
  }, [open, client]);

  const loadData = async () => {
    const [agentsData, leadsData, groupsData, notAnsweredCLs] = await Promise.all([
      base44.entities.Agent.filter({ client_id: client.id }),
      base44.entities.Lead.filter({ client_id: client.id }, '-created_date', 10000),
      base44.entities.LeadGroup.filter({ client_id: client.id }, '-created_date', 100),
      base44.entities.CampaignLead.filter({ client_id: client.id, call_status: 'not_answered' }, '-created_date', 5000)
    ]);
    setAgents(agentsData.filter(a => a.status === 'active'));
    setLeads(leadsData);
    setLeadGroups(groupsData);
    setNotAnsweredIds(new Set(notAnsweredCLs.map(cl => cl.lead_id)));
  };

  const [leadSearch, setLeadSearch] = useState('');

  const filteredLeads = leads.filter(l => {
    if (leadFilter === 'not_answered') {
      if (!notAnsweredIds.has(l.id)) return false;
    } else if (leadFilter !== 'all' && l.status !== leadFilter) {
      return false;
    }
    if (groupFilter === 'ungrouped' && l.group_id) return false;
    if (groupFilter !== 'all' && groupFilter !== 'ungrouped' && l.group_id !== groupFilter) return false;
    if (leadSearch) {
      const s = leadSearch.toLowerCase();
      if (!((l.name || '').toLowerCase().includes(s) || (l.phone || '').includes(s))) return false;
    }
    return true;
  });

  // O(1) selection lookups — `.includes()` on a large array inside each rendered
  // row is O(n²) and locks up the UI with thousands of leads.
  const selectedSet = React.useMemo(() => new Set(selectedLeads), [selectedLeads]);

  // Only render the first N rows so the DOM never holds thousands of checkboxes.
  const RENDER_CAP = 200;
  const visibleLeads = filteredLeads.slice(0, RENDER_CAP);

  const toggleLead = (id) => {
    setSelectedLeads(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 5000) {
        toast.error('Campaign limit reached (5000 leads). Remove one to add another.');
        return prev;
      }
      return [...prev, id];
    });
  };

  const selectAll = () => {
    if (selectedLeads.length === filteredLeads.length) {
      setSelectedLeads([]);
    } else {
      // Cap at 5000 leads per campaign
      const capped = filteredLeads.slice(0, 5000).map(l => l.id);
      if (filteredLeads.length > 5000) {
        toast.warning(`Selected first 5000 of ${filteredLeads.length} leads (campaign limit).`);
      }
      setSelectedLeads(capped);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.agent_id) return toast.error('Select an agent');
    if (selectedLeads.length === 0) return toast.error('Select at least one lead');
    if (selectedLeads.length > 5000) {
      return toast.error(`Each campaign is limited to 5000 leads. You selected ${selectedLeads.length}. Please split into multiple campaigns.`);
    }

    let scheduledISO = null;
    if (scheduleEnabled) {
      if (!scheduledDate) return toast.error('Pick a schedule date/time');
      // Treat the datetime-local input as IST regardless of browser timezone.
      // datetime-local format: "YYYY-MM-DDTHH:MM" — we parse the parts and build a UTC
      // timestamp that represents that exact wall-clock time in IST (UTC+5:30).
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(scheduledDate);
      if (!m) return toast.error('Invalid schedule date');
      const [, y, mo, d, hh, mm] = m;
      const istHour = parseInt(hh, 10);
      // TRAI: only between 9 AM (inclusive) and 9 PM (exclusive) IST
      if (istHour < 9 || istHour >= 21) {
        return toast.error('TRAI rule: campaigns can only be scheduled between 9:00 AM and 9:00 PM IST');
      }
      // IST = UTC+05:30 → subtract 5h30m to get the equivalent UTC instant
      const utcMs = Date.UTC(+y, +mo - 1, +d, istHour, +mm) - (5 * 60 + 30) * 60 * 1000;
      if (isNaN(utcMs) || utcMs <= Date.now()) return toast.error('Schedule time must be in the future (IST)');
      scheduledISO = new Date(utcMs).toISOString();
    }

    setLoading(true);
    try {
      // Only include call_script if any section has content
      const hasScript = form.call_script && Object.values(form.call_script).some(v => v && v.trim());

      const campaign = await base44.entities.Campaign.create({
        client_id: client.id,
        name: form.name,
        type: form.type,
        agent_id: form.agent_id,
        max_concurrent_calls: form.max_concurrent_calls,
        total_leads: selectedLeads.length,
        ...(hasScript ? { call_script: form.call_script } : {}),
        ...(scheduledISO ? { scheduled_date: scheduledISO } : {}),
        whatsapp_auto_send: form.whatsapp_auto_send,
        followup_rules: {
          interested_email: form.interested_email,
          interested_ai_email: form.interested_ai_email,
          interested_callback_days: form.interested_callback_days,
          callback_email: form.callback_email,
          callback_create_task: form.callback_create_task,
          callback_ai_talking_points: form.callback_ai_talking_points,
          not_interested_email: form.not_interested_email,
          no_answer_retry: form.no_answer_retry,
          no_answer_retry_hours: form.no_answer_retry_hours,
          no_answer_max_retries: form.no_answer_max_retries,
        },
        status: scheduledISO ? 'scheduled' : 'draft'
      });

      // Create campaign leads
      const campaignLeads = selectedLeads.map(lid => {
        const lead = leads.find(l => l.id === lid);
        return {
          campaign_id: campaign.id,
          lead_id: lid,
          client_id: client.id,
          status: 'pending',
          lead_name: lead?.name || '',
          lead_phone: lead?.phone || ''
        };
      });

      // bulkCreate caps at 500 records per call — chunk to insert ALL selected leads
      const CHUNK_SIZE = 500;
      for (let i = 0; i < campaignLeads.length; i += CHUNK_SIZE) {
        const chunk = campaignLeads.slice(i, i + CHUNK_SIZE);
        await base44.entities.CampaignLead.bulkCreate(chunk);
      }
      if (scheduledISO) {
        const istLabel = new Date(scheduledISO).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
        toast.success(`Campaign scheduled for ${istLabel} IST`);
      } else {
        toast.success(`Campaign created with ${selectedLeads.length} leads`);
      }
      onCreated?.();
      onOpenChange(false);
    } catch (err) {
      toast.error('Failed to create campaign');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Campaign</DialogTitle>
          <DialogDescription>Configure your campaign settings and select leads to call.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Campaign Name</Label>
              <Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required placeholder="e.g. Q1 Cold Outreach" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={form.type} onValueChange={v => setForm({...form, type: v})}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cold_call">Cold Call</SelectItem>
                  <SelectItem value="followup">Follow-up</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Agent</Label>
              <Select value={form.agent_id} onValueChange={v => setForm({...form, agent_id: v})}>
                <SelectTrigger><SelectValue placeholder="Select agent" /></SelectTrigger>
                <SelectContent>
                  {agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Max Concurrent Calls</Label>
              <Input type="number" min={1} max={10} value={form.max_concurrent_calls}
                onChange={e => setForm({...form, max_concurrent_calls: parseInt(e.target.value) || 5})} />
            </div>
          </div>

          {/* Schedule */}
          <div className="border rounded-lg p-4 space-y-3 bg-blue-50/30">
            <div className="flex items-center gap-2">
              <Checkbox checked={scheduleEnabled} onCheckedChange={v => setScheduleEnabled(!!v)} id="schedule-toggle" />
              <label htmlFor="schedule-toggle" className="font-semibold text-sm text-gray-700 cursor-pointer">
                Schedule for later
              </label>
            </div>
            {scheduleEnabled && (
              <div>
                <Label>Start Date & Time (IST)</Label>
                <Input
                  type="datetime-local"
                  value={scheduledDate}
                  onChange={e => setScheduledDate(e.target.value)}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Time is in <strong>IST (Indian Standard Time)</strong>. Campaign auto-starts at this time (checked every 5 min).
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  ⚖️ TRAI compliance: campaigns can only run between <strong>9:00 AM – 9:00 PM IST</strong>.
                </p>
              </div>
            )}
          </div>

          {/* Call Script */}
          <CallScriptEditor
            script={form.call_script}
            onChange={(script) => setForm({ ...form, call_script: script })}
            agentName={agents.find(a => a.id === form.agent_id)?.name}
            campaignType={form.type}
          />

          {/* Auto-WhatsApp Rules */}
          <CampaignWhatsAppRules
            clientId={client?.id}
            value={form.whatsapp_auto_send}
            onChange={(v) => setForm({ ...form, whatsapp_auto_send: v })}
          />

          {/* Follow-up Rules */}
          <div className="border rounded-lg p-4 space-y-4">
            <p className="font-semibold text-sm text-gray-700">AI-Driven Follow-up Rules</p>

            {/* Interested section */}
            <div className="space-y-2 pb-3 border-b">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">When Interested</p>
              <div className="flex items-center gap-2">
                <Checkbox checked={form.interested_email} onCheckedChange={v => setForm({...form, interested_email: v})} />
                <span className="text-sm">Send follow-up email</span>
              </div>
              {form.interested_email && (
                <div className="flex items-center gap-2 ml-6">
                  <Checkbox checked={form.interested_ai_email} onCheckedChange={v => setForm({...form, interested_ai_email: v})} />
                  <span className="text-sm text-gray-600">✨ AI-personalize email from call transcript</span>
                </div>
              )}
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600">Schedule callback after</span>
                <Input type="number" className="w-16" min={1} max={14} value={form.interested_callback_days}
                  onChange={e => setForm({...form, interested_callback_days: parseInt(e.target.value) || 2})} />
                <span className="text-sm text-gray-600">days</span>
              </div>
            </div>

            {/* Callback section */}
            <div className="space-y-2 pb-3 border-b">
              <p className="text-xs font-semibold text-yellow-700 uppercase tracking-wide">When Callback Requested</p>
              <div className="flex items-center gap-2">
                <Checkbox checked={form.callback_create_task} onCheckedChange={v => setForm({...form, callback_create_task: v})} />
                <span className="text-sm">Auto-create callback task for agent</span>
              </div>
              {form.callback_create_task && (
                <div className="flex items-center gap-2 ml-6">
                  <Checkbox checked={form.callback_ai_talking_points} onCheckedChange={v => setForm({...form, callback_ai_talking_points: v})} />
                  <span className="text-sm text-gray-600">✨ Generate AI talking points from transcript</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Checkbox checked={form.callback_email} onCheckedChange={v => setForm({...form, callback_email: v})} />
                <span className="text-sm">Send confirmation email</span>
              </div>
            </div>

            {/* No-answer section */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">When No Answer</p>
              <div className="flex items-center gap-2">
                <Checkbox checked={form.no_answer_retry} onCheckedChange={v => setForm({...form, no_answer_retry: v})} />
                <span className="text-sm">Auto-retry no-answer leads</span>
              </div>
              {form.no_answer_retry && (
                <div className="flex items-center gap-3 ml-6">
                  <span className="text-sm text-gray-600">Retry after</span>
                  <Input type="number" className="w-16" min={1} max={48} value={form.no_answer_retry_hours}
                    onChange={e => setForm({...form, no_answer_retry_hours: parseInt(e.target.value) || 4})} />
                  <span className="text-sm text-gray-600">hours, max</span>
                  <Input type="number" className="w-16" min={1} max={10} value={form.no_answer_max_retries}
                    onChange={e => setForm({...form, no_answer_max_retries: parseInt(e.target.value) || 3})} />
                  <span className="text-sm text-gray-600">retries</span>
                </div>
              )}
            </div>
          </div>

          {/* Lead Selection */}
          <div className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="font-semibold text-sm text-gray-700">
                Select Leads ({selectedLeads.length} / 5000 max)
                {selectedLeads.length >= 5000 && <span className="ml-2 text-red-600 text-xs">⚠ Limit reached</span>}
              </p>
              <div className="flex gap-2 flex-wrap">
                <Select value={groupFilter} onValueChange={setGroupFilter}>
                  <SelectTrigger className="w-40 h-8"><SelectValue placeholder="Group" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Groups</SelectItem>
                    <SelectItem value="ungrouped">Ungrouped</SelectItem>
                    {leadGroups.map(g => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={leadFilter} onValueChange={setLeadFilter}>
                  <SelectTrigger className="w-44 h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="new">New</SelectItem>
                    <SelectItem value="contacted">Contacted</SelectItem>
                    <SelectItem value="interested">Interested</SelectItem>
                    <SelectItem value="callback">Callback</SelectItem>
                    <SelectItem value="not_answered">Not Answered ({notAnsweredIds.size})</SelectItem>
                  </SelectContent>
                </Select>
                <PhoneMaskToggle />
                <Button type="button" size="sm" variant="outline" onClick={selectAll}>
                  {selectedLeads.length === filteredLeads.length ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
            </div>
            <Input
              placeholder="Search leads by name or phone..."
              value={leadSearch}
              onChange={e => setLeadSearch(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="max-h-48 overflow-y-auto space-y-1">
              {filteredLeads.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">No leads found</p>
              ) : (
                visibleLeads.map(lead => (
                  <label key={lead.id} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                    <Checkbox checked={selectedSet.has(lead.id)} onCheckedChange={() => toggleLead(lead.id)} />
                    <span className="text-sm font-medium flex-1">{lead.name || maskPhoneNumber(lead.phone)}</span>
                    <span className="text-xs text-gray-500">{maskPhoneNumber(lead.phone)}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${lead.status === 'new' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                      {lead.status}
                    </span>
                  </label>
                ))
              )}
              {filteredLeads.length > RENDER_CAP && (
                <p className="text-xs text-gray-400 text-center py-2">
                  Showing first {RENDER_CAP} of {filteredLeads.length}. Use search to narrow, or "Select All" to include every matching lead.
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={loading} className="bg-blue-600 hover:bg-blue-700">
              {loading ? 'Creating...' : (scheduleEnabled ? 'Schedule Campaign' : 'Create Campaign')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}