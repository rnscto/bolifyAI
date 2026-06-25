import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Database, Clock, Ban, IndianRupee, Upload } from 'lucide-react';
import RaisePaymentRequestDialog from '../components/admin/RaisePaymentRequestDialog';

const CEO_EMAIL = 'yadavnand886@gmail.com';
const MAIN_ADMIN_EMAIL = 'yadavnand886@gmail.com';

const STATUS_META = {
  not_requested: { label: 'Not requested', color: 'bg-gray-100 text-gray-700' },
  requested: { label: 'Pending Approval', color: 'bg-amber-100 text-amber-800' },
  active: { label: 'Active', color: 'bg-green-100 text-green-800' },
  rejected: { label: 'Rejected', color: 'bg-red-100 text-red-800' },
  revoked: { label: 'Revoked', color: 'bg-red-100 text-red-800' }
};

export default function AdminCRMRequests() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('requested');
  const [selected, setSelected] = useState(null);
  const [action, setAction] = useState(null); // 'approve' | 'reject' | 'revoke'
  const [fee, setFee] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [me, setMe] = useState(null);
  const [raiseClient, setRaiseClient] = useState(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const user = await base44.auth.me();
      setMe(user);
      // Pull all clients (admin RLS allows). We'll filter in-memory.
      const all = await base44.entities.Client.list('-crm_api_access_requested_at', 500);
      setClients(all || []);
    } catch (e) {
      console.error(e);
      toast.error('Failed to load clients');
    } finally {
      setLoading(false);
    }
  };

  const openAction = (client, act) => {
    setSelected(client);
    setAction(act);
    setFee(client.crm_api_access_fee != null ? String(client.crm_api_access_fee) : '');
    setNotes(client.crm_api_access_notes || '');
  };

  const closeDialog = () => {
    setSelected(null);
    setAction(null);
    setFee('');
    setNotes('');
  };

  const handleSubmit = async () => {
    if (!selected || !action) return;
    setSaving(true);
    try {
      const patch = { crm_api_access_notes: notes || '' };
      if (action === 'reject') patch.crm_api_access_status = 'rejected';
      else if (action === 'revoke') patch.crm_api_access_status = 'revoked';
      await base44.entities.Client.update(selected.id, patch);
      toast.success(`CRM access ${action}d for ${selected.company_name}`);
      closeDialog();
      await load();
    } catch (e) {
      toast.error(e.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const filtered = clients.filter(c => {
    if (filter === 'all') return true;
    if (filter === 'pending') return c.crm_api_access_status === 'requested';
    if (filter === 'active') return c.crm_api_access_status === 'active';
    if (filter === 'rejected') return ['rejected', 'revoked'].includes(c.crm_api_access_status);
    return c.crm_api_access_status === filter;
  });

  const counts = {
    pending: clients.filter(c => c.crm_api_access_status === 'requested').length,
    active: clients.filter(c => c.crm_api_access_status === 'active').length,
    rejected: clients.filter(c => ['rejected', 'revoked'].includes(c.crm_api_access_status)).length
  };

  const totalRevenue = clients
    .filter(c => c.crm_api_access_status === 'active')
    .reduce((sum, c) => sum + (Number(c.crm_api_access_fee) || 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
          <Database className="w-7 h-7 text-indigo-600" /> CRM Integration Access
        </h1>
        <p className="text-gray-600 mt-1">Approve / reject client CRM API requests. Charge a one-time fee per activation.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-2 text-amber-700"><Clock className="w-4 h-4" /><span className="text-sm font-medium">Pending</span></div>
          <p className="text-3xl font-bold mt-1">{counts.pending}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-2 text-green-700"><CheckCircle2 className="w-4 h-4" /><span className="text-sm font-medium">Active</span></div>
          <p className="text-3xl font-bold mt-1">{counts.active}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-2 text-red-700"><Ban className="w-4 h-4" /><span className="text-sm font-medium">Rejected / Revoked</span></div>
          <p className="text-3xl font-bold mt-1">{counts.rejected}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-2 text-indigo-700"><IndianRupee className="w-4 h-4" /><span className="text-sm font-medium">Total Activation Revenue</span></div>
          <p className="text-3xl font-bold mt-1">₹{totalRevenue.toLocaleString()}</p>
        </CardContent></Card>
      </div>

      <div className="flex gap-2 flex-wrap">
        {[
          { key: 'pending', label: `Pending (${counts.pending})` },
          { key: 'active', label: `Active (${counts.active})` },
          { key: 'rejected', label: 'Rejected / Revoked' },
          { key: 'all', label: 'All Clients' }
        ].map(f => (
          <Button key={f.key} variant={filter === f.key ? 'default' : 'outline'} size="sm" onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Clients</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No clients in this filter.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-600">
                  <tr>
                    <th className="px-4 py-2">Client</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Requested</th>
                    <th className="px-4 py-2">Fee</th>
                    <th className="px-4 py-2">Activated By</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(c => {
                    const status = c.crm_api_access_status || 'not_requested';
                    const meta = STATUS_META[status] || STATUS_META.not_requested;
                    return (
                      <tr key={c.id} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{c.company_name}</div>
                          <div className="text-xs text-gray-500">{c.email}</div>
                        </td>
                        <td className="px-4 py-3"><Badge className={meta.color}>{meta.label}</Badge></td>
                        <td className="px-4 py-3 text-gray-700">
                          {c.crm_api_access_requested_at ? new Date(c.crm_api_access_requested_at).toLocaleString() : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {c.crm_api_access_fee != null ? `₹${Number(c.crm_api_access_fee).toLocaleString()}` : '—'}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">
                          {c.crm_api_access_activated_by || '—'}
                          {c.crm_api_access_activated_at && (
                            <div className="text-gray-400">{new Date(c.crm_api_access_activated_at).toLocaleDateString()}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right space-x-1">
                          {/* Activation (any non-active status) → CEO raises payment approval request */}
                          {status !== 'active' && (me?.email || '').toLowerCase() === CEO_EMAIL && (
                            <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700" onClick={() => setRaiseClient(c)}>
                              <Upload className="w-4 h-4 mr-1" /> Raise Payment Approval
                            </Button>
                          )}
                          {/* Reject (only main admin, direct) */}
                          {status === 'requested' && (me?.email || '').toLowerCase() === MAIN_ADMIN_EMAIL && (
                            <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => openAction(c, 'reject')}>
                              <XCircle className="w-4 h-4 mr-1" /> Reject
                            </Button>
                          )}
                          {/* Revoke (main admin only, direct) */}
                          {status === 'active' && (me?.email || '').toLowerCase() === MAIN_ADMIN_EMAIL && (
                            <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => openAction(c, 'revoke')}>
                              <Ban className="w-4 h-4 mr-1" /> Revoke
                            </Button>
                          )}
                          {status === 'active' && (me?.email || '').toLowerCase() !== MAIN_ADMIN_EMAIL && (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === 'reject' && `Reject CRM Request — ${selected?.company_name}`}
              {action === 'revoke' && `Revoke CRM Access — ${selected?.company_name}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={action === 'reject' ? 'Reason for rejection (visible to client)…' : 'Internal notes…'}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={saving}
              className="bg-red-600 hover:bg-red-700"
            >
              {saving ? 'Saving…' : action === 'reject' ? 'Confirm Rejection' : 'Confirm Revoke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CEO raises payment approval request for CRM activation */}
      <RaisePaymentRequestDialog
        open={!!raiseClient}
        onOpenChange={(o) => !o && setRaiseClient(null)}
        defaultType="crm_integration_access"
        clientId={raiseClient?.id || null}
        clientName={raiseClient?.company_name || ''}
        onSubmitted={() => { setRaiseClient(null); load(); }}
      />
    </div>
  );
}