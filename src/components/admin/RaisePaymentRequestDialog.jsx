import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Upload, Loader2, FileImage } from 'lucide-react';
import { uploadPrivateFile, getSignedUrl } from '@/lib/azureBlob';

const TYPE_LABELS = {
  client_activation: 'Client Activation',
  wallet_topup: 'Wallet Top-Up',
  crm_integration_access: 'CRM Integration Access',
  social_media_access: 'Social Media Add-on',
  subscription_renewal: 'Subscription Renewal',
  channel_addition: 'Channel Addition',
  other: 'Other'
};

/**
 * Generic dialog the CEO admin uses to raise any payment approval request.
 * Props:
 *  - open, onOpenChange
 *  - defaultType (optional) — preselect a request_type
 *  - clientId, clientName (optional) — preselect a client
 *  - clients (optional) — list to render dropdown when clientId not provided
 *  - metadata (optional) — request_metadata pre-fill
 *  - onSubmitted() — called after success
 */
export default function RaisePaymentRequestDialog({
  open, onOpenChange,
  defaultType = 'other',
  clientId = null,
  clientName = '',
  clients = [],
  metadata = {},
  onSubmitted
}) {
  const [me, setMe] = useState(null);
  const [type, setType] = useState(defaultType);
  const [selectedClientId, setSelectedClientId] = useState(clientId || '');
  const [amount, setAmount] = useState('');
  const [txn, setTxn] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('bank_transfer');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [screenshotUrl, setScreenshotUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { apiClient.auth.me().then(setMe).catch(() => {}); }, []);
  useEffect(() => { if (open) { setType(defaultType); setSelectedClientId(clientId || ''); setAmount(''); setTxn(''); setScreenshotUrl(''); setNotes(''); } }, [open, defaultType, clientId]);

  const isAdmin = ['admin', 'master_admin'].includes(me?.role);

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const { file_uri } = await uploadPrivateFile(file, 'payment-proofs');
      setScreenshotUrl(file_uri);
      toast.success('Screenshot uploaded securely');
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

  const handleSubmit = async () => {
    if (!selectedClientId) return toast.error('Select a client');
    if (!amount || Number(amount) <= 0) return toast.error('Enter a valid amount');
    if (!txn.trim()) return toast.error('Transaction number is required');
    if (!screenshotUrl) return toast.error('Upload a payment screenshot');
    setSubmitting(true);
    try {
      const res = await apiClient.functions.invoke('submitPaymentApproval', {
        request_type: type,
        client_id: selectedClientId,
        amount: Number(amount),
        transaction_number: txn.trim(),
        payment_method: paymentMethod,
        payment_date: paymentDate,
        screenshot_url: screenshotUrl,
        request_notes: notes,
        request_metadata: metadata
      });
      if (res.data?.error) throw new Error(res.data.error);
      toast.success('Payment approval request submitted to main admin');
      onSubmitted && onSubmitted();
      onOpenChange(false);
    } catch (e) {
      toast.error(e.message || 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isAdmin && me) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader><DialogTitle>Restricted</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-700">
            Only <code className="bg-gray-100 px-1 rounded">admins</code> may raise payment approval requests.
          </p>
          <DialogFooter><Button onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Raise Payment Approval Request</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Request Type *</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(TYPE_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Client *</Label>
            {clientId ? (
              <Input value={clientName} disabled />
            ) : (
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger><SelectValue placeholder="Select client" /></SelectTrigger>
                <SelectContent>
                  {clients.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.company_name} — {c.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Amount (₹) *</Label>
              <Input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 4999" />
            </div>
            <div>
              <Label>Payment Date *</Label>
              <Input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Transaction Number *</Label>
              <Input value={txn} onChange={e => setTxn(e.target.value)} placeholder="UPI / Bank ref" />
            </div>
            <div>
              <Label>Payment Method</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
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
            <Label>Payment Screenshot * (proof of payment)</Label>
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
                <FileImage className="w-3 h-3" /> View uploaded screenshot
              </button>
            )}
          </div>

          <div>
            <Label>Notes for main admin (optional)</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Any context for the approver..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || uploading} className="bg-indigo-600 hover:bg-indigo-700">
            {submitting ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Submitting…</> : <><Upload className="w-4 h-4 mr-1" /> Submit for Approval</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}