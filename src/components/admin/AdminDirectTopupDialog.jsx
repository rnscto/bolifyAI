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
import { Loader2, Zap } from 'lucide-react';

export default function AdminDirectTopupDialog({
  open, onOpenChange,
  clients = [],
  onSubmitted
}) {
  const [selectedClientId, setSelectedClientId] = useState('');
  const [amount, setAmount] = useState('');
  const [txn, setTxn] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { 
    if (open) { setSelectedClientId(''); setAmount(''); setTxn(''); setNotes(''); } 
  }, [open]);

  const handleSubmit = async () => {
    if (!selectedClientId) return toast.error('Select a client');
    if (!amount || Number(amount) <= 0) return toast.error('Enter a valid amount');
    setSubmitting(true);
    try {
      const res = await apiClient.functions.invoke('adminDirectTopup', {
        client_id: selectedClientId,
        amount: Number(amount),
        transaction_number: txn.trim(),
        notes: notes
      });
      if (res.data?.error) throw new Error(res.data.error);
      toast.success('Wallet topped up successfully');
      onSubmitted && onSubmitted();
      onOpenChange(false);
    } catch (e) {
      toast.error(e.message || 'Failed to topup');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Direct Wallet Top-Up</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Client *</Label>
            <Select value={selectedClientId} onValueChange={setSelectedClientId}>
              <SelectTrigger><SelectValue placeholder="Select client" /></SelectTrigger>
              <SelectContent>
                {clients.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.company_name} — {c.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Amount (₹) *</Label>
            <Input type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 5000" />
          </div>
          <div>
            <Label>Transaction / Reference Number</Label>
            <Input value={txn} onChange={e => setTxn(e.target.value)} placeholder="Optional offline ref" />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional reason..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting} className="bg-blue-600 hover:bg-blue-700">
            {submitting ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Processing…</> : <><Zap className="w-4 h-4 mr-1" /> Top-Up Now</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
