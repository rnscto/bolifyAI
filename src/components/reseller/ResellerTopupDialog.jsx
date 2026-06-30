import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, ArrowRightLeft } from 'lucide-react';

export default function ResellerTopupDialog({
  open, onOpenChange,
  client,
  me,
  onSubmitted
}) {
  const [amount, setAmount] = useState('');
  const [sourceWallet, setSourceWallet] = useState('commission_balance');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { 
    if (open) { setAmount(''); setSourceWallet('commission_balance'); } 
  }, [open]);

  const handleSubmit = async () => {
    if (!client) return toast.error('No client selected');
    if (!amount || Number(amount) <= 0) return toast.error('Enter a valid amount');
    setSubmitting(true);
    try {
      // Direct call to reseller API
      await apiClient.post('/reseller/topup-downline', {
        downline_id: client.id,
        amount: Number(amount),
        source_wallet: sourceWallet
      });
      toast.success('Wallet topped up successfully');
      onSubmitted && onSubmitted();
      onOpenChange(false);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || 'Failed to topup');
    } finally {
      setSubmitting(false);
    }
  };

  if (!client) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Top-Up Client Wallet</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="bg-gray-50 p-3 rounded-lg text-sm text-gray-700">
            Transferring funds to <strong>{client.company_name}</strong>
          </div>
          <div>
            <Label>Source Wallet</Label>
            <Select value={sourceWallet} onValueChange={setSourceWallet}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="commission_balance">Commission Balance (₹{Number(me?.commission_balance || 0).toLocaleString()})</SelectItem>
                <SelectItem value="wallet_balance">Main Wallet Balance (₹{Number(me?.wallet_balance || 0).toLocaleString()})</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Amount (₹) *</Label>
            <Input type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 5000" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
            {submitting ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Processing…</> : <><ArrowRightLeft className="w-4 h-4 mr-1" /> Transfer Funds</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
