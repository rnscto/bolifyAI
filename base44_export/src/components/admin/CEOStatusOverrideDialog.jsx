import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import { toast } from 'sonner';
import { AlertTriangle, Loader2 } from 'lucide-react';

const TARGET_OPTIONS = [
  { value: 'expired', label: 'Expired' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'trial', label: 'Trial' }
];

/**
 * CEO-only quick override to flip a client's account_status back to
 * Expired / Suspended / Trial without an approval cycle.
 * Renders nothing for non-CEO users.
 */
export default function CEOStatusOverrideDialog({ client, currentUser, open, onOpenChange, onUpdated }) {
  const [targetStatus, setTargetStatus] = useState('expired');
  const [notes, setNotes] = useState('');
  const [trialDays, setTrialDays] = useState(7);
  const [saving, setSaving] = useState(false);

  const isCEO = (currentUser?.email || '').toLowerCase() === 'ceo@getwaygroup.com';
  if (!isCEO || !client) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch = { account_status: targetStatus };
      if (targetStatus === 'suspended') {
        patch.status = 'suspended';
      } else {
        // expired & trial: keep top-level status as 'active' so the account record itself isn't cancelled
        patch.status = client.status === 'cancelled' ? client.status : 'active';
      }
      if (targetStatus === 'trial') {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + (Number(trialDays) || 7));
        patch.trial_start_date = new Date().toISOString();
        patch.trial_end_date = trialEnd.toISOString();
      }

      await base44.entities.Client.update(client.id, patch);

      // Best-effort audit log entry (silently ignore if not permitted)
      try {
        await base44.entities.ClientLifecycleEvent.create({
          client_id: client.id,
          client_name: client.company_name,
          event_type: targetStatus === 'suspended' ? 'suspended'
            : targetStatus === 'expired' ? 'expired'
            : 'trial_started',
          from_value: client.account_status || '',
          to_value: targetStatus,
          performed_by: currentUser.email,
          source: 'admin_manual',
          notes: notes || `CEO override: ${client.account_status || 'unknown'} → ${targetStatus}`
        });
      } catch (_) {}

      toast.success(`Client moved to ${targetStatus}`);
      onUpdated?.();
      onOpenChange(false);
    } catch (e) {
      console.error(e);
      toast.error('Failed: ' + (e.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Override Account Status
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800">
            CEO direct override — no approval required. Use to roll a paid/active client
            back to Expired, Suspended, or Trial. Activation back to paid still requires the
            main admin's approval.
          </div>

          <div className="bg-gray-50 rounded p-3 text-sm">
            <div><strong>Client:</strong> {client.company_name}</div>
            <div><strong>Current status:</strong> {client.account_status || 'unknown'}</div>
          </div>

          <div>
            <Label>Move account status to</Label>
            <Select value={targetStatus} onValueChange={setTargetStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TARGET_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {targetStatus === 'trial' && (
            <div>
              <Label>Trial duration (days)</Label>
              <input
                type="number"
                min={1}
                max={90}
                value={trialDays}
                onChange={(e) => setTrialDays(parseInt(e.target.value) || 7)}
                className="w-full mt-1 border rounded px-3 py-2 text-sm"
              />
            </div>
          )}

          <div>
            <Label>Reason / notes</Label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why is this being changed?" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-amber-600 hover:bg-amber-700">
            {saving ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Saving…</> : 'Apply Override'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}