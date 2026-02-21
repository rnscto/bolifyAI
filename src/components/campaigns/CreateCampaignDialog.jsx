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

export default function CreateCampaignDialog({ open, onOpenChange, client, onCreated }) {
  const [agents, setAgents] = useState([]);
  const [leads, setLeads] = useState([]);
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [leadFilter, setLeadFilter] = useState('all');
  const [loading, setLoading] = useState(false);
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
  });

  useEffect(() => {
    if (open && client) loadData();
  }, [open, client]);

  const loadData = async () => {
    const [agentsData, leadsData] = await Promise.all([
      base44.entities.Agent.filter({ client_id: client.id }),
      base44.entities.Lead.filter({ client_id: client.id }, '-created_date', 500)
    ]);
    setAgents(agentsData.filter(a => a.status === 'active'));
    setLeads(leadsData);
  };

  const filteredLeads = leads.filter(l => {
    if (leadFilter === 'all') return true;
    return l.status === leadFilter;
  });

  const toggleLead = (id) => {
    setSelectedLeads(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (selectedLeads.length === filteredLeads.length) {
      setSelectedLeads([]);
    } else {
      setSelectedLeads(filteredLeads.map(l => l.id));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.agent_id) return toast.error('Select an agent');
    if (selectedLeads.length === 0) return toast.error('Select at least one lead');

    setLoading(true);
    try {
      const campaign = await base44.entities.Campaign.create({
        client_id: client.id,
        name: form.name,
        type: form.type,
        agent_id: form.agent_id,
        max_concurrent_calls: form.max_concurrent_calls,
        total_leads: selectedLeads.length,
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
        status: 'draft'
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

      await base44.entities.CampaignLead.bulkCreate(campaignLeads);
      toast.success(`Campaign created with ${selectedLeads.length} leads`);
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
            <div className="flex items-center justify-between">
              <p className="font-semibold text-sm text-gray-700">Select Leads ({selectedLeads.length} selected)</p>
              <div className="flex gap-2">
                <Select value={leadFilter} onValueChange={setLeadFilter}>
                  <SelectTrigger className="w-36 h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="new">New</SelectItem>
                    <SelectItem value="contacted">Contacted</SelectItem>
                    <SelectItem value="interested">Interested</SelectItem>
                    <SelectItem value="callback">Callback</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="button" size="sm" variant="outline" onClick={selectAll}>
                  {selectedLeads.length === filteredLeads.length ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {filteredLeads.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">No leads found</p>
              ) : (
                filteredLeads.map(lead => (
                  <label key={lead.id} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                    <Checkbox checked={selectedLeads.includes(lead.id)} onCheckedChange={() => toggleLead(lead.id)} />
                    <span className="text-sm font-medium flex-1">{lead.name || lead.phone}</span>
                    <span className="text-xs text-gray-500">{lead.phone}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${lead.status === 'new' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                      {lead.status}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={loading} className="bg-blue-600 hover:bg-blue-700">
              {loading ? 'Creating...' : 'Create Campaign'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}