import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Search, CheckCircle2, XCircle, Clock, Eye, Loader2, AlertTriangle, FileCheck, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-800',
  under_review: 'bg-blue-100 text-blue-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  expired: 'bg-gray-100 text-gray-800',
};

const COMPANY_TYPE_LABELS = {
  proprietorship: 'Proprietorship',
  partnership: 'Partnership',
  llp: 'LLP',
  private_limited: 'Pvt Ltd',
  public_limited: 'Public Ltd',
  one_person_company: 'OPC',
  other: 'Other',
};

const DOC_LABELS = {
  certificate_of_incorporation: 'Certificate of Incorporation',
  partnership_deed: 'Partnership Deed',
  llp_agreement: 'LLP Agreement',
  gst_certificate: 'GST Certificate',
  shop_establishment: 'Shop & Establishment',
  udyam_certificate: 'Udyam Certificate',
  other: 'Other',
};

export default function AdminKYCManagement() {
  const [kycDocs, setKycDocs] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [processing, setProcessing] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const [docs, cls] = await Promise.all([
      apiClient.KYCDocument.list('-created_at', 200),
      apiClient.Client.list('-created_at', 500),
    ]);
    setKycDocs(docs);
    setClients(cls);
    setLoading(false);
  };

  const clientMap = {};
  clients.forEach(c => { clientMap[c.id] = c; });

  const handleApprove = async (doc) => {
    setProcessing(true);
    const user = await apiClient.auth.me();
    await apiClient.KYCDocument.update(doc.id, {
      status: 'approved',
      reviewed_by: user.email,
      reviewed_date: new Date().toISOString(),
    });
    if (doc.client_id) {
      await apiClient.Client.update(doc.client_id, { kyc_status: 'approved' });
    }
    toast.success('KYC approved');
    setReviewOpen(false);
    setProcessing(false);
    loadData();
  };

  const handleReject = async (doc) => {
    if (!rejectionReason.trim()) { toast.error('Please provide a rejection reason'); return; }
    setProcessing(true);
    const user = await apiClient.auth.me();
    await apiClient.KYCDocument.update(doc.id, {
      status: 'rejected',
      rejection_reason: rejectionReason,
      reviewed_by: user.email,
      reviewed_date: new Date().toISOString(),
    });
    if (doc.client_id) {
      await apiClient.Client.update(doc.client_id, { kyc_status: 'rejected' });
    }
    // Notify client (via our own email function — not credit-gated)
    const cl = clientMap[doc.client_id];
    if (cl?.email) {
      try {
        await apiClient.functions.invoke('sendClientEmail', {
          client_id: doc.client_id,
          to: cl.email,
          subject: `[Action Required] KYC Verification Rejected — VaaniAI`,
          html: `<p>Dear ${cl.company_name},</p><p>Your KYC documents have been rejected.</p><p><strong>Reason:</strong> ${rejectionReason}</p><p>Please re-upload corrected documents from your Settings → KYC tab.</p>`,
        });
      } catch (e) { console.log('Email fail:', e); }
    }
    toast.success('KYC rejected');
    setReviewOpen(false);
    setRejectionReason('');
    setProcessing(false);
    loadData();
  };

  const filtered = kycDocs.filter(d => {
    if (filterStatus !== 'all' && d.status !== filterStatus) return false;
    if (search) {
      const name = (d.entity_name || clientMap[d.client_id]?.company_name || '').toLowerCase();
      return name.includes(search.toLowerCase());
    }
    return true;
  });

  // Stats
  const stats = {
    total: kycDocs.length,
    pending: kycDocs.filter(d => d.status === 'pending').length,
    under_review: kycDocs.filter(d => d.status === 'under_review').length,
    approved: kycDocs.filter(d => d.status === 'approved').length,
    rejected: kycDocs.filter(d => d.status === 'rejected').length,
  };

  // Clients without any KYC submission who are past deadline
  const overdueClients = clients.filter(c =>
    c.onboarding_completed &&
    c.kyc_status === 'pending' &&
    c.kyc_deadline &&
    new Date(c.kyc_deadline) < new Date() &&
    !kycDocs.some(d => d.client_id === c.id)
  );

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Total', val: stats.total, color: 'text-gray-700' },
          { label: 'Pending', val: stats.pending, color: 'text-yellow-700' },
          { label: 'Under Review', val: stats.under_review, color: 'text-blue-700' },
          { label: 'Approved', val: stats.approved, color: 'text-green-700' },
          { label: 'Rejected', val: stats.rejected, color: 'text-red-700' },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="pt-4 pb-3 text-center">
              <p className={`text-2xl font-bold ${s.color}`}>{s.val}</p>
              <p className="text-xs text-gray-500">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Overdue Alert */}
      {overdueClients.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />
          <div>
            <p className="font-semibold text-red-900">{overdueClients.length} Client(s) Past KYC Deadline</p>
            <p className="text-sm text-red-700 mt-1">
              {overdueClients.slice(0, 5).map(c => c.company_name).join(', ')}
              {overdueClients.length > 5 && ` and ${overdueClients.length - 5} more...`}
            </p>
          </div>
        </div>
      )}

      {/* Search and Filter */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by company name..." className="pl-9" />
        </div>
        <Tabs value={filterStatus} onValueChange={setFilterStatus}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="under_review">Under Review</TabsTrigger>
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="approved">Approved</TabsTrigger>
            <TabsTrigger value="rejected">Rejected</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Signatory</TableHead>
                <TableHead>Documents</TableHead>
                <TableHead>Deadline</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-500">No KYC records found</TableCell></TableRow>
              ) : (
                filtered.map(doc => {
                  const cl = clientMap[doc.client_id];
                  const docCount = [doc.signatory_aadhaar_url, doc.pan_url, doc.company_kyc_url].filter(Boolean).length;
                  return (
                    <TableRow key={doc.id}>
                      <TableCell className="font-medium">{doc.entity_name || cl?.company_name || '-'}</TableCell>
                      <TableCell>{COMPANY_TYPE_LABELS[doc.company_type] || '-'}</TableCell>
                      <TableCell className="text-sm">{doc.signatory_name || '-'}</TableCell>
                      <TableCell><Badge variant="outline">{docCount}/3</Badge></TableCell>
                      <TableCell className="text-sm">{doc.kyc_deadline ? new Date(doc.kyc_deadline).toLocaleDateString('en-IN') : '-'}</TableCell>
                      <TableCell><Badge className={STATUS_COLORS[doc.status]}>{doc.status?.replace('_', ' ')}</Badge></TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => { setSelectedDoc(doc); setReviewOpen(true); }}>
                          <Eye className="w-4 h-4 mr-1" /> Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Review Dialog */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>KYC Review — {selectedDoc?.entity_name || clientMap[selectedDoc?.client_id]?.company_name}</DialogTitle>
          </DialogHeader>
          {selectedDoc && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-gray-500">Business Type:</span> <strong>{COMPANY_TYPE_LABELS[selectedDoc.company_type]}</strong></div>
                <div><span className="text-gray-500">Signatory:</span> <strong>{selectedDoc.signatory_name || '-'}</strong></div>
                <div><span className="text-gray-500">PAN:</span> <strong>{selectedDoc.pan_number || '-'}</strong></div>
                <div><span className="text-gray-500">Aadhaar (last 4):</span> <strong>{selectedDoc.signatory_aadhaar_number || '-'}</strong></div>
              </div>

              <div className="space-y-3">
                <h4 className="font-semibold text-sm">Uploaded Documents</h4>
                <DocLink label="Aadhaar Card" url={selectedDoc.signatory_aadhaar_url} />
                <DocLink label="PAN Card" url={selectedDoc.pan_url} />
                <DocLink label={`Company Doc (${DOC_LABELS[selectedDoc.company_kyc_doc_type] || 'N/A'})`} url={selectedDoc.company_kyc_url} />
                {selectedDoc.additional_doc_url && <DocLink label="Additional Document" url={selectedDoc.additional_doc_url} />}
              </div>

              {selectedDoc.status !== 'approved' && (
                <div>
                  <Label>Rejection Reason (required to reject)</Label>
                  <Textarea
                    value={rejectionReason}
                    onChange={e => setRejectionReason(e.target.value)}
                    placeholder="Reason for rejection..."
                    className="mt-1"
                  />
                </div>
              )}

              <DialogFooter className="gap-2">
                {selectedDoc.status !== 'approved' && (
                  <>
                    <Button variant="destructive" onClick={() => handleReject(selectedDoc)} disabled={processing}>
                      <XCircle className="w-4 h-4 mr-1" /> Reject
                    </Button>
                    <Button className="bg-green-600 hover:bg-green-700" onClick={() => handleApprove(selectedDoc)} disabled={processing}>
                      {processing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle2 className="w-4 h-4 mr-1" />} Approve
                    </Button>
                  </>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DocLink({ label, url }) {
  const [opening, setOpening] = useState(false);

  // Private Azure blobs need a short-lived signed URL. Older docs use direct (public)
  // Base44 URLs — for those the signed-URL call fails and we fall back to the raw URL.
  const openDoc = async () => {
    if (!url) return;
    setOpening(true);
    try {
      const resp = await apiClient.functions.invoke('azureBlobSignedUrl', { file_uri: url });
      window.open(resp.data?.signed_url || url, '_blank', 'noopener,noreferrer');
    } catch (_) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
      {url ? <FileCheck className="w-4 h-4 text-green-600" /> : <Clock className="w-4 h-4 text-gray-400" />}
      <span className="text-sm flex-1">{label}</span>
      {url ? (
        <button type="button" onClick={openDoc} disabled={opening} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          {opening ? <Loader2 className="w-3 h-3 animate-spin" /> : <>View <ExternalLink className="w-3 h-3" /></>}
        </button>
      ) : (
        <span className="text-xs text-gray-400">Not uploaded</span>
      )}
    </div>
  );
}