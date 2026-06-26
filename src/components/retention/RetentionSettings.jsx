import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Save, Loader2, Phone, Gift, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';

export default function RetentionSettings({ config, dids, agents, onSave, saving }) {
  const [form, setForm] = useState({
    is_active: config?.is_active !== false,
    retention_did: config?.retention_did || '',
    retention_agent_id: config?.retention_agent_id || '',
    call_days_after_expiry: config?.call_days_after_expiry || [2, 5],
    call_time_start: config?.call_time_start || '10:00',
    call_time_end: config?.call_time_end || '18:00',
    custom_instructions: config?.custom_instructions || '',
    active_offer: config?.active_offer || '',
    offer_code: config?.offer_code || '',
    offer_expiry: config?.offer_expiry || '',
    greeting_template: config?.greeting_template || '',
    max_calls_per_client: config?.max_calls_per_client || 3,
    enable_incoming_identification: config?.enable_incoming_identification !== false,
  });

  const [callDaysInput, setCallDaysInput] = useState(
    (config?.call_days_after_expiry || [2, 5]).join(', ')
  );

  const handleSave = () => {
    const days = callDaysInput.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d) && d > 0);
    if (days.length === 0) {
      toast.error('Please enter at least one call day');
      return;
    }
    onSave({ ...form, call_days_after_expiry: days });
  };

  const availableAgents = agents.filter(a => a.assigned_did && a.assigned_did.trim() !== '');
  const assignedDids = dids.filter(d => d.status === 'assigned' || d.status === 'available');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* DID & Agent Mapping */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Phone className="w-4 h-4" /> DID & Agent Mapping</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>System Active</Label>
            <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
          </div>

          <div>
            <Label>Retention DID (Caller ID)</Label>
            <Select value={form.retention_did} onValueChange={(v) => setForm({ ...form, retention_did: v })}>
              <SelectTrigger><SelectValue placeholder="Select DID for retention calls" /></SelectTrigger>
              <SelectContent>
                {assignedDids.map(d => (
                  <SelectItem key={d.id} value={d.number}>{d.number} ({d.status})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-400 mt-1">This number will show as caller ID for retention calls</p>
          </div>

          <div>
            <Label>Retention AI Agent</Label>
            <Select value={form.retention_agent_id} onValueChange={(v) => setForm({ ...form, retention_agent_id: v })}>
              <SelectTrigger><SelectValue placeholder="Select agent for retention" /></SelectTrigger>
              <SelectContent>
                {agents.map(a => (
                  <SelectItem key={a.id} value={a.id}>{a.name} {a.assigned_did ? `(DID: ${a.assigned_did})` : '(No DID)'}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Call Days After Expiry</Label>
            <Input
              value={callDaysInput}
              onChange={(e) => setCallDaysInput(e.target.value)}
              placeholder="2, 5, 8"
            />
            <p className="text-xs text-gray-400 mt-1">Comma-separated days (e.g. 2, 5 means call on day 2 and day 5 after trial expiry)</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Call Window Start (IST)</Label>
              <Input type="time" value={form.call_time_start} onChange={(e) => setForm({ ...form, call_time_start: e.target.value })} />
            </div>
            <div>
              <Label>Call Window End (IST)</Label>
              <Input type="time" value={form.call_time_end} onChange={(e) => setForm({ ...form, call_time_end: e.target.value })} />
            </div>
          </div>

          <div>
            <Label>Max Calls Per Client</Label>
            <Input type="number" min={1} max={10} value={form.max_calls_per_client} onChange={(e) => setForm({ ...form, max_calls_per_client: parseInt(e.target.value) || 3 })} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Identify Incoming Callers</Label>
              <p className="text-xs text-gray-400">Match incoming calls to registered client phone numbers</p>
            </div>
            <Switch checked={form.enable_incoming_identification} onCheckedChange={(v) => setForm({ ...form, enable_incoming_identification: v })} />
          </div>
        </CardContent>
      </Card>

      {/* Offers & Promotions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Gift className="w-4 h-4" /> Offers & Promotions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Active Offer</Label>
            <Input
              value={form.active_offer}
              onChange={(e) => setForm({ ...form, active_offer: e.target.value })}
              placeholder="e.g. 20% off first quarter"
            />
            <p className="text-xs text-gray-400 mt-1">This offer text will be included in the AI agent's script</p>
          </div>

          <div>
            <Label>Promo Code</Label>
            <Input
              value={form.offer_code}
              onChange={(e) => setForm({ ...form, offer_code: e.target.value })}
              placeholder="e.g. WELCOME20"
            />
          </div>

          <div>
            <Label>Offer Expiry</Label>
            <Input
              type="date"
              value={form.offer_expiry}
              onChange={(e) => setForm({ ...form, offer_expiry: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Custom Instructions */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="w-4 h-4" /> AI Agent Instructions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Custom Greeting Template</Label>
            <Textarea
              value={form.greeting_template}
              onChange={(e) => setForm({ ...form, greeting_template: e.target.value })}
              placeholder="Hi {company_name}, this is VaaniAI calling to check in about your experience..."
              className="h-24"
            />
            <p className="text-xs text-gray-400 mt-1">Variables: {'{company_name}'}, {'{industry}'}, {'{days_since_expiry}'}, {'{offer}'}</p>
          </div>

          <div>
            <Label>Custom Instructions for AI Agent</Label>
            <Textarea
              value={form.custom_instructions}
              onChange={(e) => setForm({ ...form, custom_instructions: e.target.value })}
              placeholder="Additional instructions for the AI retention agent. E.g., mention specific features, address industry-specific pain points, etc."
              className="h-32"
            />
            <p className="text-xs text-gray-400 mt-1">These instructions override the default retention script generation</p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Settings
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}