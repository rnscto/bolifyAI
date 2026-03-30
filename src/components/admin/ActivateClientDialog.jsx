import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, CreditCard, Calendar, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

export default function ActivateClientDialog({ client, open, onOpenChange, onUpdated }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    account_status: client?.account_status || 'trial',
    status: client?.status || 'active',
    subscription_plan: client?.subscription_plan || 'quarterly',
    total_channels: client?.total_channels || 1,
    monthly_rate_per_channel: client?.monthly_rate_per_channel || 6500,
    next_billing_date: client?.next_billing_date || '',
    trial_end_date: client?.trial_end_date ? new Date(client.trial_end_date).toISOString().slice(0, 10) : '',
  });

  const handleSave = async () => {
    setSaving(true);

    const updateData = {
      account_status: form.account_status,
      status: form.status,
      subscription_plan: form.subscription_plan,
      total_channels: parseInt(form.total_channels) || 1,
      monthly_rate_per_channel: parseFloat(form.monthly_rate_per_channel) || 6500,
    };

    // Set billing date if activating
    if (form.account_status === 'active' && form.next_billing_date) {
      updateData.next_billing_date = form.next_billing_date;
    }

    // Set trial end date if setting to trial
    if (form.account_status === 'trial' && form.trial_end_date) {
      updateData.trial_end_date = new Date(form.trial_end_date).toISOString();
    }

    // If activating from trial/expired, clear trial dates and set billing start
    if (form.account_status === 'active') {
      updateData.status = 'active';
    }

    await base44.entities.Client.update(client.id, updateData);

    // Also create/update a subscription record when activating
    if (form.account_status === 'active' && form.next_billing_date) {
      const channels = parseInt(form.total_channels) || 1;
      const rate = parseFloat(form.monthly_rate_per_channel) || 6500;
      const billingMonths = form.subscription_plan === 'quarterly' ? 3 : 1;
      const totalAmount = channels * rate * billingMonths;

      const billingStart = new Date().toISOString().split('T')[0];

      await base44.entities.Subscription.create({
        client_id: client.id,
        billing_cycle: form.subscription_plan,
        channels: channels,
        rate_per_channel: rate,
        total_amount: totalAmount,
        billing_start_date: billingStart,
        billing_end_date: form.next_billing_date,
        next_billing_date: form.next_billing_date,
        status: 'active',
        payment_status: 'paid',
      });
    }

    toast.success(`Client "${client.company_name}" updated to ${form.account_status}`);
    setSaving(false);
    onOpenChange(false);
    onUpdated();
  };

  if (!client) return null;

  const statusBadge = {
    onboarding: 'bg-yellow-100 text-yellow-800',
    trial: 'bg-blue-100 text-blue-800',
    active: 'bg-green-100 text-green-800',
    expired: 'bg-red-100 text-red-800',
    suspended: 'bg-gray-100 text-gray-800',
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            Manage Account — {client.company_name}
          </DialogTitle>
        </DialogHeader>

        {/* Current status */}
        <div className="bg-gray-50 rounded-lg p-3 flex items-center justify-between text-sm">
          <span className="text-gray-600">Current Status:</span>
          <Badge className={statusBadge[client.account_status] || 'bg-gray-100 text-gray-800'}>
            {client.account_status || 'unknown'}
          </Badge>
        </div>

        <div className="space-y-4">
          {/* Account Status */}
          <div>
            <Label>Account Status</Label>
            <Select value={form.account_status} onValueChange={(v) => setForm({ ...form, account_status: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="onboarding">Onboarding</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="active">Active (Billing)</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Trial end date — only when trial */}
          {form.account_status === 'trial' && (
            <div>
              <Label className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" /> Trial End Date
              </Label>
              <Input
                type="date"
                value={form.trial_end_date}
                onChange={(e) => setForm({ ...form, trial_end_date: e.target.value })}
              />
              <p className="text-xs text-gray-500 mt-1">Leave blank to keep the existing trial end date.</p>
            </div>
          )}

          {/* Billing fields — only when active */}
          {form.account_status === 'active' && (
            <>
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-green-700 shrink-0 mt-0.5" />
                <p className="text-xs text-green-800">
                  Activating this account will create a subscription record and set billing. Make sure payment has been received.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Subscription Plan</Label>
                  <Select value={form.subscription_plan} onValueChange={(v) => setForm({ ...form, subscription_plan: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Channels</Label>
                  <Input
                    type="number"
                    min="1"
                    value={form.total_channels}
                    onChange={(e) => setForm({ ...form, total_channels: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Rate/Channel (₹/mo)</Label>
                  <Input
                    type="number"
                    value={form.monthly_rate_per_channel}
                    onChange={(e) => setForm({ ...form, monthly_rate_per_channel: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" /> Next Billing Date
                  </Label>
                  <Input
                    type="date"
                    value={form.next_billing_date}
                    onChange={(e) => setForm({ ...form, next_billing_date: e.target.value })}
                  />
                </div>
              </div>

              <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
                Total: <strong>₹{((parseInt(form.total_channels) || 1) * (parseFloat(form.monthly_rate_per_channel) || 6500) * 3).toLocaleString()}</strong> / quarter
                ({form.total_channels} ch × ₹{parseFloat(form.monthly_rate_per_channel || 6500).toLocaleString()} × 3 months)
              </div>
            </>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
              {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Saving...</> : 'Save Changes'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}