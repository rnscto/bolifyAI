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
import { Loader2, CreditCard, Calendar, AlertTriangle, Wallet } from 'lucide-react';
import { toast } from 'sonner';

export default function ActivateClientDialog({ client, open, onOpenChange, onUpdated }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    account_status: client?.account_status || 'trial',
    status: client?.status || 'active',
    billing_type: client?.billing_type || 'per_minute',
    subscription_plan: client?.subscription_plan || 'quarterly',
    total_channels: client?.total_channels || 1,
    monthly_rate_per_channel: client?.monthly_rate_per_channel || 6500,
    per_minute_rate: client?.per_minute_rate || 4,
    wallet_balance: client?.wallet_balance || 0,
    free_minutes_remaining: client?.free_minutes_remaining || 0,
    next_billing_date: client?.next_billing_date || '',
    trial_end_date: client?.trial_end_date ? new Date(client.trial_end_date).toISOString().slice(0, 10) : '',
  });

  const handleSave = async () => {
    setSaving(true);

    const updateData = {
      account_status: form.account_status,
      status: form.status,
      billing_type: form.billing_type,
      subscription_plan: form.subscription_plan,
      total_channels: parseInt(form.total_channels) || 1,
      monthly_rate_per_channel: parseFloat(form.monthly_rate_per_channel) || 6500,
      per_minute_rate: parseFloat(form.per_minute_rate) || 4,
      wallet_balance: parseFloat(form.wallet_balance) || 0,
      free_minutes_remaining: parseFloat(form.free_minutes_remaining) || 0,
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

    // If admin increased the wallet balance, log it as an admin top-up Payment + UsageLog
    const oldBalance = parseFloat(client.wallet_balance) || 0;
    const newBalance = parseFloat(form.wallet_balance) || 0;
    const credited = newBalance - oldBalance;
    if (credited > 0) {
      const payment = await base44.entities.Payment.create({
        client_id: client.id,
        amount: credited,
        currency: 'INR',
        status: 'paid',
        payment_method: 'admin_manual',
        cashfree_order_id: `admin_${client.id.slice(-8)}_${Date.now()}`,
        description: JSON.stringify({ type: 'wallet_topup', amount: credited, gst: 0, total: credited, source: 'admin_manual' }),
        paid_at: new Date().toISOString(),
      });
      try {
        await base44.entities.UsageLog.create({
          client_id: client.id,
          type: 'topup',
          direction: 'credit',
          amount: credited,
          balance_before: oldBalance,
          balance_after: newBalance,
          description: `Admin manual top-up ₹${credited}`,
          payment_id: payment.id,
        });
      } catch (_) { /* UsageLog optional */ }
    }

    // Also create/update a subscription record when activating with unlimited billing
    if (form.account_status === 'active' && form.billing_type === 'unlimited' && form.next_billing_date) {
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

          {/* Billing Type */}
          <div>
            <Label>Billing Type</Label>
            <Select value={form.billing_type} onValueChange={(v) => setForm({ ...form, billing_type: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per_minute">Per Minute (₹{form.per_minute_rate}/min prepaid)</SelectItem>
                <SelectItem value="unlimited">Unlimited (flat channel rate)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Per-minute wallet management */}
          {form.billing_type === 'per_minute' && (
            <div className="bg-cyan-50 border border-cyan-200 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-cyan-800">
                <Wallet className="w-4 h-4" /> Wallet & Minutes
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Rate (₹/min)</Label>
                  <Input
                    type="number"
                    min="1"
                    value={form.per_minute_rate}
                    onChange={(e) => setForm({ ...form, per_minute_rate: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Wallet Balance (₹)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={form.wallet_balance}
                    onChange={(e) => setForm({ ...form, wallet_balance: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Free Minutes</Label>
                  <Input
                    type="number"
                    min="0"
                    value={form.free_minutes_remaining}
                    onChange={(e) => setForm({ ...form, free_minutes_remaining: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-cyan-700">
                Current: ₹{(client?.wallet_balance || 0).toLocaleString()} balance, {client?.free_minutes_remaining || 0} free min, {(client?.total_minutes_used || 0).toFixed(1)} min used total
              </p>
            </div>
          )}

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

          {/* Unlimited subscription fields — only when active + unlimited */}
          {form.account_status === 'active' && form.billing_type === 'unlimited' && (
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