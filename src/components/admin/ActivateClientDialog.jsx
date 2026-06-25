import React, { useState, useEffect } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, CreditCard, Calendar, Wallet, Upload, FileImage, ShieldCheck, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { uploadPrivateFile, getSignedUrl } from '@/lib/azureBlob';

const CEO_EMAIL = 'yadavnand886@gmail.com';
const MAIN_ADMIN_EMAIL = 'yadavnand886@gmail.com';

export default function ActivateClientDialog({ client, open, onOpenChange, onUpdated }) {
  const [me, setMe] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [form, setForm] = useState({
    account_status: client?.account_status || 'trial',
    status: client?.status || 'active',
    billing_type: client?.billing_type || 'per_minute',
    subscription_plan: client?.subscription_plan || 'quarterly',
    total_channels: client?.total_channels || 1,
    monthly_rate_per_channel: client?.monthly_rate_per_channel || 6500,
    per_minute_rate: client?.per_minute_rate || 4,
    wallet_credit: 0, // amount to ADD to wallet (₹)
    free_minutes_remaining: client?.free_minutes_remaining || 0,
    next_billing_date: client?.next_billing_date || '',
    trial_end_date: client?.trial_end_date ? new Date(client.trial_end_date).toISOString().slice(0, 10) : '',
  });

  // Payment proof (required for CEO submissions)
  const [payAmount, setPayAmount] = useState('');
  const [txn, setTxn] = useState('');
  const [payMethod, setPayMethod] = useState('bank_transfer');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);
  const [screenshotUrl, setScreenshotUrl] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => { base44.auth.me().then(setMe).catch(() => {}); }, []);

  const myEmail = (me?.email || '').toLowerCase();
  const isCEO = myEmail === CEO_EMAIL;
  const isMainAdmin = myEmail === MAIN_ADMIN_EMAIL;

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const { file_uri } = await uploadPrivateFile(file, 'payment-proofs');
      setScreenshotUrl(file_uri);
      toast.success('Payment screenshot uploaded securely');
    } catch (e) {
      toast.error('Upload failed: ' + (e.message || 'unknown'));
    } finally {
      setUploading(false);
    }
  };

  const handleViewProof = async () => {
    try {
      const { signed_url } = await getSignedUrl(screenshotUrl, 600);
      window.open(signed_url, '_blank');
    } catch (e) {
      toast.error('Could not open proof: ' + e.message);
    }
  };

  // ── CEO: submit a payment approval request to main admin ──
  const handleSubmitForApproval = async () => {
    if (!payAmount || Number(payAmount) <= 0) return toast.error('Enter the amount paid (₹)');
    if (!txn.trim()) return toast.error('Transaction number is required');
    if (!screenshotUrl) return toast.error('Upload payment proof (screenshot)');

    setSaving(true);
    try {
      const metadata = {
        account_status: form.account_status,
        status: form.status,
        billing_type: form.billing_type,
        subscription_plan: form.subscription_plan,
        total_channels: parseInt(form.total_channels) || 1,
        monthly_rate_per_channel: parseFloat(form.monthly_rate_per_channel) || 6500,
        per_minute_rate: parseFloat(form.per_minute_rate) || 4,
        wallet_credit: parseFloat(form.wallet_credit) || 0,
        free_minutes_remaining: parseFloat(form.free_minutes_remaining) || 0,
        next_billing_date: form.next_billing_date || null,
        trial_days: form.trial_end_date ? null : 7
      };
      const res = await base44.functions.invoke('submitPaymentApproval', {
        request_type: 'client_activation',
        client_id: client.id,
        amount: Number(payAmount),
        transaction_number: txn.trim(),
        payment_method: payMethod,
        payment_date: payDate,
        screenshot_url: screenshotUrl,
        request_notes: notes,
        request_metadata: metadata
      });
      if (res.data?.error) throw new Error(res.data.error);
      toast.success('Submitted to main admin for approval');
      onOpenChange(false);
      onUpdated && onUpdated();
    } catch (e) {
      toast.error(e.message || 'Failed to submit');
    } finally {
      setSaving(false);
    }
  };

  // ── Main admin: direct save (no payment proof required) ──
  const handleDirectSave = async () => {
    setSaving(true);
    try {
      const oldBalance = parseFloat(client.wallet_balance) || 0;
      const credit = parseFloat(form.wallet_credit) || 0;
      const updateData = {
        account_status: form.account_status,
        status: form.status,
        billing_type: form.billing_type,
        subscription_plan: form.subscription_plan,
        total_channels: parseInt(form.total_channels) || 1,
        monthly_rate_per_channel: parseFloat(form.monthly_rate_per_channel) || 6500,
        per_minute_rate: parseFloat(form.per_minute_rate) || 4,
        free_minutes_remaining: parseFloat(form.free_minutes_remaining) || 0,
        wallet_balance: oldBalance + credit,
      };
      if (form.account_status === 'active' && form.next_billing_date) {
        updateData.next_billing_date = form.next_billing_date;
      }
      if (form.account_status === 'trial' && form.trial_end_date) {
        updateData.trial_end_date = new Date(form.trial_end_date).toISOString();
      }
      await base44.entities.Client.update(client.id, updateData);
      toast.success(`Client "${client.company_name}" updated`);
      onOpenChange(false);
      onUpdated && onUpdated();
    } catch (e) {
      toast.error(e.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  if (!client) return null;
  if (!me) return null;

  // Block other admins (not CEO, not main admin)
  if (!isCEO && !isMainAdmin) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restricted</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-700">
            Only the CEO ({CEO_EMAIL}) or main admin ({MAIN_ADMIN_EMAIL}) may manage client billing.
          </p>
          <div className="flex justify-end">
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const statusBadge = {
    onboarding: 'bg-yellow-100 text-yellow-800',
    trial: 'bg-blue-100 text-blue-800',
    active: 'bg-green-100 text-green-800',
    expired: 'bg-red-100 text-red-800',
    suspended: 'bg-gray-100 text-gray-800',
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            Manage Account — {client.company_name}
          </DialogTitle>
        </DialogHeader>

        {/* Mode banner */}
        {isCEO && (
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-indigo-700 mt-0.5 shrink-0" />
            <p className="text-xs text-indigo-800">
              <strong>Two-tier approval:</strong> Set the target billing/status below, attach payment proof, and submit.
              The main admin ({MAIN_ADMIN_EMAIL}) will review and approve — your changes will be applied only after approval.
            </p>
          </div>
        )}
        {isMainAdmin && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-green-700 mt-0.5 shrink-0" />
            <p className="text-xs text-green-800">
              <strong>Main admin mode:</strong> Direct save (no payment proof required). To approve a CEO-submitted request, go to <em>Payment Approvals</em>.
            </p>
          </div>
        )}

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
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="onboarding">Onboarding</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="active">Active (Paid)</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Billing Type */}
          <div>
            <Label>Billing Type</Label>
            <Select value={form.billing_type} onValueChange={(v) => setForm({ ...form, billing_type: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="per_minute">Per Minute (₹{form.per_minute_rate}/min prepaid)</SelectItem>
                <SelectItem value="unlimited">Unlimited (flat channel rate)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Per-minute wallet credit + free minutes */}
          {form.billing_type === 'per_minute' && (
            <div className="bg-cyan-50 border border-cyan-200 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-cyan-800">
                <Wallet className="w-4 h-4" /> Wallet & Minutes
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Rate (₹/min)</Label>
                  <Input
                    type="number" min="1"
                    value={form.per_minute_rate}
                    onChange={(e) => setForm({ ...form, per_minute_rate: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Credit to Wallet (₹)</Label>
                  <Input
                    type="number" min="0"
                    value={form.wallet_credit}
                    onChange={(e) => setForm({ ...form, wallet_credit: e.target.value })}
                    placeholder="0"
                  />
                </div>
                <div>
                  <Label className="text-xs">Free Minutes</Label>
                  <Input
                    type="number" min="0"
                    value={form.free_minutes_remaining}
                    onChange={(e) => setForm({ ...form, free_minutes_remaining: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-cyan-700">
                Current wallet: ₹{Number(client?.wallet_balance || 0).toLocaleString()} · {client?.free_minutes_remaining || 0} free min · {Number(client?.total_minutes_used || 0).toFixed(1)} min used
              </p>
            </div>
          )}

          {/* Trial end */}
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
            </div>
          )}

          {/* Unlimited subscription fields */}
          {form.account_status === 'active' && form.billing_type === 'unlimited' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Subscription Plan</Label>
                  <Select value={form.subscription_plan} onValueChange={(v) => setForm({ ...form, subscription_plan: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Channels</Label>
                  <Input
                    type="number" min="1"
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
              {(() => {
                const months = form.subscription_plan === 'yearly' ? 12 : form.subscription_plan === 'quarterly' ? 3 : 1;
                const total = (parseInt(form.total_channels) || 1) * (parseFloat(form.monthly_rate_per_channel) || 6500) * months;
                return (
                  <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
                    Plan Total: <strong>₹{total.toLocaleString()}</strong>
                  </div>
                );
              })()}
            </>
          )}

          {/* Payment proof block — CEO only */}
          {isCEO && (
            <div className="border-2 border-indigo-200 rounded-lg p-3 space-y-3 bg-indigo-50/40">
              <div className="text-sm font-semibold text-indigo-900 flex items-center gap-2">
                <Upload className="w-4 h-4" /> Payment Proof (required)
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Amount Paid (₹) *</Label>
                  <Input type="number" min="0" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="e.g. 14999" />
                </div>
                <div>
                  <Label>Payment Date *</Label>
                  <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Transaction Number *</Label>
                  <Input value={txn} onChange={(e) => setTxn(e.target.value)} placeholder="UPI / Bank ref" />
                </div>
                <div>
                  <Label>Method</Label>
                  <Select value={payMethod} onValueChange={setPayMethod}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                      <SelectItem value="upi">UPI</SelectItem>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="cheque">Cheque</SelectItem>
                      <SelectItem value="card">Card</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Screenshot / Receipt *</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => handleUpload(e.target.files?.[0])}
                    disabled={uploading}
                  />
                  {uploading && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
                </div>
                {screenshotUrl && (
                  <button type="button" onClick={handleViewProof} className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1">
                    <FileImage className="w-3 h-3" /> View uploaded proof
                  </button>
                )}
              </div>
              <div>
                <Label>Notes to main admin (optional)</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            {isCEO ? (
              <Button onClick={handleSubmitForApproval} disabled={saving || uploading} className="bg-indigo-600 hover:bg-indigo-700">
                {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Submitting…</> : <><Upload className="w-4 h-4 mr-2" /> Submit to Main Admin</>}
              </Button>
            ) : (
              <Button onClick={handleDirectSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
                {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Saving…</> : 'Save Changes'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}