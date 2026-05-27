import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  CheckCircle2, XCircle, Clock, FileImage, IndianRupee, ShieldCheck, Plus, Loader2
} from 'lucide-react';
import RaisePaymentRequestDialog from '../components/admin/RaisePaymentRequestDialog';

const CEO_EMAIL = 'ceo@getwaygroup.com';
const MAIN_ADMIN_EMAIL = 'neerajyrns@gmail.com';

const TYPE_LABELS = {
  client_activation: 'Client Activation',
  wallet_topup: 'Wallet Top-Up',
  crm_integration_access: 'CRM Integration',
  social_media_access: 'Social Media Add-on',
  subscription_renewal: 'Subscription Renewal',
  channel_addition: 'Channel Addition',
  other: 'Other'
};

const STATUS_META = {
  pending: { label: 'Pending', color: 'bg-amber-100 text-amber-800', Icon: Clock },
  approved: { label: 'Approved', color: 'bg-green-100 text-green-800', Icon: CheckCircle2 },
  rejected: { label: 'Rejected', color: 'bg-red-100 text-red-800', Icon: XCircle }
};

export default function AdminPaymentApprovals() {
  const [me, setMe] = useState(null);
  const [requests, setRequests] = useState([]);
  const [clients, setClients] = useState([]);
  const [filter, setFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [reviewing, setReviewing] = useState(null); // request being reviewed
  const [decision, setDecision] = useState(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const user = await base44.auth.me();
      setMe(user);
      const [reqs, cs] = await Promise.all([
        base44.entities.PaymentApprovalRequest.list('-created_date', 500),
        base44.entities.Client.list('-created_date', 1000)
      ]);
      setRequests(reqs || []);
      setClients(cs || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const isCEO = (me?.email || '').toLowerCase() === CEO_EMAIL;
  const isMain = (me?.email || '').toLowerCase() === MAIN_ADMIN_EMAIL;

  const counts = {
    pending: requests.filter(r => r.status === 'pending').length,
    approved: requests.filter(r => r.status === 'approved').length,
    rejected: requests.filter(r => r.status === 'rejected').length
  };
  const totalApprovedAmount = requests.filter(r => r.status === 'approved').reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const filtered = requests.filter(r => filter === 'all' ? true : r.status === filter);

  const openReview = (r, d) => { setReviewing(r); setDecision(d); setReviewNotes(''); };
  const closeReview = () => { setReviewing(null); setDecision(null); setReviewNotes(''); };

  const submitReview = async () => {
    if (!reviewing || !decision) return;
    setSubmitting(true);
    try {
      const res = await base44.functions.invoke('processPaymentApproval', {
        request_id: reviewing.id,
        decision,
        review_notes: reviewNotes
      });
      if (res.data?.error) throw new Error(res.data.error);
      if (res.data?.apply_error) toast.warning('Approved but apply failed: ' + res.data.apply_error);
      else toast.success(`Request ${decision}d`);
      closeReview();
      await load();
    } catch (e) {
      toast.error(e.message || 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 text-indigo-600" /> Payment Approvals
          </h1>
          <p className="text-gray-600 mt-1">
            CEO ({CEO_EMAIL}) raises requests with payment proof. Main admin ({MAIN_ADMIN_EMAIL}) approves.
          </p>
        </div>
        {isCEO && (
          <Button className="bg-indigo-600 hover:bg-indigo-700" onClick={() => setRaiseOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Raise New Request
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-2 text-amber-700"><Clock className="w-4 h-4" /><span className="text-sm font-medium">Pending</span></div>
          <p className="text-3xl font-bold mt-1">{counts.pending}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-2 text-green-700"><CheckCircle2 className="w-4 h-4" /><span className="text-sm font-medium">Approved</span></div>
          <p className="text-3xl font-bold mt-1">{counts.approved}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-2 text-red-700"><XCircle className="w-4 h-4" /><span className="text-sm font-medium">Rejected</span></div>
          <p className="text-3xl font-bold mt-1">{counts.rejected}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="flex items-center gap-2 text-indigo-700"><IndianRupee className="w-4 h-4" /><span className="text-sm font-medium">Approved Amount</span></div>
          <p className="text-3xl font-bold mt-1">₹{totalApprovedAmount.toLocaleString()}</p>
        </CardContent></Card>
      </div>

      <div className="flex gap-2 flex-wrap">
        {['pending', 'approved', 'rejected', 'all'].map(f => (
          <Button key={f} variant={filter === f ? 'default' : 'outline'} size="sm" onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)} {f !== 'all' && `(${counts[f]})`}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle>Requests</CardTitle></CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No requests in this filter.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-600">
                  <tr>
                    <th className="px-4 py-2">Type</th>
                    <th className="px-4 py-2">Client</th>
                    <th className="px-4 py-2">Amount</th>
                    <th className="px-4 py-2">Txn #</th>
                    <th className="px-4 py-2">Proof</th>
                    <th className="px-4 py-2">Requested By</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const meta = STATUS_META[r.status] || STATUS_META.pending;
                    const StatusIcon = meta.Icon;
                    return (
                      <tr key={r.id} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-3"><Badge variant="outline">{TYPE_LABELS[r.request_type] || r.request_type}</Badge></td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{r.client_name}</div>
                          <div className="text-xs text-gray-500">{r.client_email}</div>
                        </td>
                        <td className="px-4 py-3 font-semibold">₹{Number(r.amount).toLocaleString()}</td>
                        <td className="px-4 py-3 font-mono text-xs">{r.transaction_number}</td>
                        <td className="px-4 py-3">
                          {r.screenshot_url ? (
                            <a href={r.screenshot_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 text-xs">
                              <FileImage className="w-3 h-3" /> View
                            </a>
                          ) : <span className="text-xs text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">
                          {r.requested_by}
                          <div className="text-gray-400">{new Date(r.created_date).toLocaleString()}</div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={meta.color}><StatusIcon className="w-3 h-3 mr-1 inline" />{meta.label}</Badge>
                          {r.status === 'approved' && r.apply_error && (
                            <div className="text-xs text-red-600 mt-1">Apply failed: {r.apply_error}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right space-x-1">
                          {r.status === 'pending' && isMain && (
                            <>
                              <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => openReview(r, 'approve')}>
                                <CheckCircle2 className="w-4 h-4 mr-1" /> Approve
                              </Button>
                              <Button size="sm" variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => openReview(r, 'reject')}>
                                <XCircle className="w-4 h-4 mr-1" /> Reject
                              </Button>
                            </>
                          )}
                          {r.status !== 'pending' && r.review_notes && (
                            <span className="text-xs text-gray-500 italic">{r.review_notes.substring(0, 60)}</span>
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

      {/* Raise dialog */}
      <RaisePaymentRequestDialog
        open={raiseOpen}
        onOpenChange={setRaiseOpen}
        clients={clients}
        onSubmitted={load}
      />

      {/* Review dialog */}
      <Dialog open={!!reviewing} onOpenChange={(o) => !o && closeReview()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision === 'approve' ? 'Approve' : 'Reject'} Payment Request
            </DialogTitle>
          </DialogHeader>
          {reviewing && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm bg-gray-50 p-3 rounded">
                <div><strong>Type:</strong> {TYPE_LABELS[reviewing.request_type]}</div>
                <div><strong>Amount:</strong> ₹{Number(reviewing.amount).toLocaleString()}</div>
                <div><strong>Client:</strong> {reviewing.client_name}</div>
                <div><strong>Txn:</strong> <code className="text-xs">{reviewing.transaction_number}</code></div>
                <div className="col-span-2"><strong>Raised by:</strong> {reviewing.requested_by}</div>
                {reviewing.request_notes && <div className="col-span-2 text-xs text-gray-600">"{reviewing.request_notes}"</div>}
              </div>
              {reviewing.screenshot_url && (
                <a href={reviewing.screenshot_url} target="_blank" rel="noreferrer">
                  <img src={reviewing.screenshot_url} alt="Payment proof" className="max-h-48 rounded border" />
                </a>
              )}
              <div>
                <label className="text-sm font-medium">Review notes (optional)</label>
                <Textarea value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} rows={3} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeReview} disabled={submitting}>Cancel</Button>
            <Button
              onClick={submitReview}
              disabled={submitting}
              className={decision === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}
            >
              {submitting ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Processing…</> : (decision === 'approve' ? 'Confirm Approval' : 'Confirm Rejection')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}