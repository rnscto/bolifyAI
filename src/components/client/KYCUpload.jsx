import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, FileCheck, AlertTriangle, Clock, CheckCircle2, XCircle, Loader2, Shield } from 'lucide-react';
import { toast } from 'sonner';

const COMPANY_TYPE_LABELS = {
  proprietorship: 'Proprietorship',
  partnership: 'Partnership Firm',
  llp: 'LLP',
  private_limited: 'Private Limited',
  public_limited: 'Public Limited',
  one_person_company: 'One Person Company',
  other: 'Other',
};

const COMPANY_DOC_OPTIONS = {
  proprietorship: ['gst_certificate', 'shop_establishment', 'udyam_certificate'],
  partnership: ['partnership_deed', 'gst_certificate'],
  llp: ['llp_agreement', 'certificate_of_incorporation', 'gst_certificate'],
  private_limited: ['certificate_of_incorporation', 'gst_certificate'],
  public_limited: ['certificate_of_incorporation', 'gst_certificate'],
  one_person_company: ['certificate_of_incorporation', 'gst_certificate'],
  other: ['gst_certificate', 'other'],
};

const DOC_LABELS = {
  certificate_of_incorporation: 'Certificate of Incorporation',
  partnership_deed: 'Partnership Deed',
  llp_agreement: 'LLP Agreement',
  gst_certificate: 'GST Certificate',
  shop_establishment: 'Shop & Establishment Certificate',
  udyam_certificate: 'Udyam Registration Certificate',
  other: 'Other Document',
};

const STATUS_CONFIG = {
  pending: { icon: Clock, color: 'bg-yellow-100 text-yellow-800', label: 'Pending Upload' },
  under_review: { icon: Clock, color: 'bg-blue-100 text-blue-800', label: 'Under Review' },
  approved: { icon: CheckCircle2, color: 'bg-green-100 text-green-800', label: 'Approved' },
  rejected: { icon: XCircle, color: 'bg-red-100 text-red-800', label: 'Rejected' },
};

export default function KYCUpload({ client }) {
  const [kycDoc, setKycDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState({});

  const [formData, setFormData] = useState({
    company_type: client?.company_type || '',
    signatory_name: '',
    signatory_aadhaar_number: '',
    pan_number: '',
    company_kyc_doc_type: '',
  });

  useEffect(() => { loadKYC(); }, [client]);

  const loadKYC = async () => {
    if (!client) return;
    const docs = await base44.entities.KYCDocument.filter({ client_id: client.id, entity_type: 'client' });
    if (docs.length > 0) {
      setKycDoc(docs[0]);
      setFormData({
        company_type: docs[0].company_type || client.company_type || '',
        signatory_name: docs[0].signatory_name || '',
        signatory_aadhaar_number: docs[0].signatory_aadhaar_number || '',
        pan_number: docs[0].pan_number || '',
        company_kyc_doc_type: docs[0].company_kyc_doc_type || '',
      });
    }
    setLoading(false);
  };

  const handleFileUpload = async (field, file) => {
    if (!file) return;
    // Basic client-side size guard (10MB) for clearer errors
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File too large. Please upload a file under 10MB.');
      return;
    }
    setUploading(prev => ({ ...prev, [field]: true }));
    try {
      // Upload directly to our own Azure Blob storage (private container) instead of
      // Base44's credit-gated Core.UploadFile. This keeps KYC uploads working regardless
      // of integration-credit limits and keeps sensitive docs in the private container.
      const fd = new FormData();
      fd.append('file', file);
      fd.append('visibility', 'private');
      fd.append('folder', `kyc/${client.id}`);
      const resp = await base44.functions.invoke('azureBlobUpload', fd);
      const file_url = resp.data?.file_uri;
      if (!file_url) throw new Error(resp.data?.error || 'Upload failed');
      if (kycDoc) {
        await base44.entities.KYCDocument.update(kycDoc.id, { [field]: file_url });
        setKycDoc(prev => ({ ...prev, [field]: file_url }));
      } else {
        // Create KYC doc on first upload. Only include company_type if user has selected one
        // (entity used to require it, which blocked uploads before selection).
        const payload = {
          client_id: client.id,
          entity_type: 'client',
          entity_name: client.company_name,
          signatory_name: formData.signatory_name,
          status: 'pending',
          kyc_deadline: client.kyc_deadline,
          [field]: file_url,
        };
        const ct = formData.company_type || client.company_type;
        if (ct) payload.company_type = ct;
        const newDoc = await base44.entities.KYCDocument.create(payload);
        setKycDoc(newDoc);
      }
      toast.success('Document uploaded');
    } catch (err) {
      console.error('KYC upload failed:', err);
      toast.error(`Upload failed: ${err?.message || 'Please try again'}`);
    } finally {
      setUploading(prev => ({ ...prev, [field]: false }));
    }
  };

  const handleSubmitKYC = async () => {
    if (!kycDoc) {
      toast.error('Please upload at least one document first');
      return;
    }
    if (!kycDoc.signatory_aadhaar_url) { toast.error('Aadhaar document is required'); return; }
    if (!kycDoc.pan_url) { toast.error('PAN document is required'); return; }
    if (!kycDoc.company_kyc_url) { toast.error('Company KYC document is required'); return; }

    setSaving(true);
    await base44.entities.KYCDocument.update(kycDoc.id, {
      status: 'under_review',
      signatory_name: formData.signatory_name,
      signatory_aadhaar_number: formData.signatory_aadhaar_number,
      pan_number: formData.pan_number,
      company_type: formData.company_type,
      company_kyc_doc_type: formData.company_kyc_doc_type,
    });
    await base44.entities.Client.update(client.id, { kyc_status: 'under_review' });

    // Notify admin (best-effort, via our own email function — not credit-gated)
    try {
      await base44.functions.invoke('sendClientEmail', {
        to: 'yadav.nandkishor73@gmail.com',
        subject: `[KYC Submitted] ${client.company_name}`,
        html: `<p>Client <strong>${client.company_name}</strong> has submitted KYC documents for review.</p>`,
      });
    } catch (e) { console.log('Admin email fail:', e); }

    setKycDoc(prev => ({ ...prev, status: 'under_review' }));
    toast.success('KYC documents submitted for review!');
    setSaving(false);
  };

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  const status = kycDoc?.status || client?.kyc_status || 'pending';
  const statusInfo = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const StatusIcon = statusInfo.icon;
  const companyType = formData.company_type || client?.company_type || '';
  const docOptions = COMPANY_DOC_OPTIONS[companyType] || COMPANY_DOC_OPTIONS.other;
  const daysLeft = client?.kyc_deadline ? Math.ceil((new Date(client.kyc_deadline) - new Date()) / 86400000) : null;
  const isSubmitted = ['under_review', 'approved'].includes(status);

  return (
    <div className="space-y-6">
      {/* Status Banner */}
      <div className={`flex items-center gap-3 p-4 rounded-xl border ${
        status === 'approved' ? 'bg-green-50 border-green-200' :
        status === 'rejected' ? 'bg-red-50 border-red-200' :
        status === 'under_review' ? 'bg-blue-50 border-blue-200' :
        'bg-amber-50 border-amber-200'
      }`}>
        <StatusIcon className={`w-6 h-6 ${
          status === 'approved' ? 'text-green-600' :
          status === 'rejected' ? 'text-red-600' :
          status === 'under_review' ? 'text-blue-600' :
          'text-amber-600'
        }`} />
        <div className="flex-1">
          <p className="font-semibold text-gray-900">KYC Status: {statusInfo.label}</p>
          {status === 'pending' && daysLeft !== null && (
            <p className="text-sm text-gray-600">
              {daysLeft > 0 ? `${daysLeft} days remaining to complete KYC` : 'KYC deadline has passed — please complete immediately'}
            </p>
          )}
          {status === 'rejected' && kycDoc?.rejection_reason && (
            <p className="text-sm text-red-700 mt-1">Reason: {kycDoc.rejection_reason}</p>
          )}
          {status === 'approved' && <p className="text-sm text-green-700">Your KYC has been verified successfully.</p>}
        </div>
        <Badge className={statusInfo.color}>{statusInfo.label}</Badge>
      </div>

      {/* Company Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Shield className="w-5 h-5" /> Business Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Business Entity Type</Label>
              <Select value={formData.company_type} onValueChange={v => setFormData({...formData, company_type: v})} disabled={isSubmitted}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {Object.entries(COMPANY_TYPE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Authorized Signatory Name</Label>
              <Input
                value={formData.signatory_name}
                onChange={e => setFormData({...formData, signatory_name: e.target.value})}
                placeholder="Full legal name"
                disabled={isSubmitted}
                className="mt-1"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Document Uploads */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Upload className="w-5 h-5" /> KYC Documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Aadhaar */}
          <DocumentUploadField
            label="Aadhaar Card of Authorized Signatory *"
            field="signatory_aadhaar_url"
            existingUrl={kycDoc?.signatory_aadhaar_url}
            uploading={uploading.signatory_aadhaar_url}
            onUpload={(f) => handleFileUpload('signatory_aadhaar_url', f)}
            disabled={isSubmitted}
            extra={
              <div className="mt-2">
                <Label className="text-xs text-gray-500">Last 4 digits of Aadhaar</Label>
                <Input
                  value={formData.signatory_aadhaar_number}
                  onChange={e => setFormData({...formData, signatory_aadhaar_number: e.target.value})}
                  placeholder="XXXX"
                  maxLength={4}
                  disabled={isSubmitted}
                  className="w-32 mt-1"
                />
              </div>
            }
          />

          {/* PAN */}
          <DocumentUploadField
            label="PAN Card *"
            field="pan_url"
            existingUrl={kycDoc?.pan_url}
            uploading={uploading.pan_url}
            onUpload={(f) => handleFileUpload('pan_url', f)}
            disabled={isSubmitted}
            extra={
              <div className="mt-2">
                <Label className="text-xs text-gray-500">PAN Number</Label>
                <Input
                  value={formData.pan_number}
                  onChange={e => setFormData({...formData, pan_number: e.target.value.toUpperCase()})}
                  placeholder="ABCDE1234F"
                  maxLength={10}
                  disabled={isSubmitted}
                  className="w-40 mt-1"
                />
              </div>
            }
          />

          {/* Company Document */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Label>Company KYC Document *</Label>
              {!isSubmitted && (
                <Select value={formData.company_kyc_doc_type} onValueChange={v => setFormData({...formData, company_kyc_doc_type: v})}>
                  <SelectTrigger className="w-56 h-8 text-xs"><SelectValue placeholder="Document type" /></SelectTrigger>
                  <SelectContent>
                    {docOptions.map(opt => (
                      <SelectItem key={opt} value={opt}>{DOC_LABELS[opt]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <DocumentUploadField
              label=""
              field="company_kyc_url"
              existingUrl={kycDoc?.company_kyc_url}
              uploading={uploading.company_kyc_url}
              onUpload={(f) => handleFileUpload('company_kyc_url', f)}
              disabled={isSubmitted}
              hideLabel
            />
            {formData.company_kyc_doc_type && (
              <p className="text-xs text-gray-500 mt-1">Type: {DOC_LABELS[formData.company_kyc_doc_type]}</p>
            )}
          </div>

          {/* Additional (optional) */}
          <DocumentUploadField
            label="Additional Supporting Document (Optional)"
            field="additional_doc_url"
            existingUrl={kycDoc?.additional_doc_url}
            uploading={uploading.additional_doc_url}
            onUpload={(f) => handleFileUpload('additional_doc_url', f)}
            disabled={isSubmitted}
          />
        </CardContent>
      </Card>

      {/* Submit */}
      {!isSubmitted && (
        <Button
          onClick={handleSubmitKYC}
          disabled={saving || !kycDoc?.signatory_aadhaar_url || !kycDoc?.pan_url || !kycDoc?.company_kyc_url}
          className="w-full bg-blue-600 hover:bg-blue-700 h-12 text-base"
        >
          {saving ? <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Submitting...</> : <><FileCheck className="w-5 h-5 mr-2" /> Submit KYC for Verification</>}
        </Button>
      )}
    </div>
  );
}

function DocumentUploadField({ label, field, existingUrl, uploading, onUpload, disabled, extra, hideLabel }) {
  const [opening, setOpening] = useState(false);

  // Private Azure blobs require a short-lived signed URL to view.
  const openDocument = async () => {
    if (!existingUrl) return;
    setOpening(true);
    try {
      const resp = await base44.functions.invoke('azureBlobSignedUrl', { file_uri: existingUrl });
      const signed = resp.data?.signed_url || existingUrl;
      window.open(signed, '_blank', 'noopener,noreferrer');
    } catch (_) {
      window.open(existingUrl, '_blank', 'noopener,noreferrer');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div>
      {!hideLabel && label && <Label className="font-medium">{label}</Label>}
      <div className="flex items-center gap-3 mt-1">
        {existingUrl ? (
          <div className="flex items-center gap-2 flex-1 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            <FileCheck className="w-4 h-4 text-green-600" />
            <button type="button" onClick={openDocument} disabled={opening} className="text-sm text-green-700 hover:underline truncate flex items-center gap-1">
              {opening && <Loader2 className="w-3 h-3 animate-spin" />}
              Document uploaded
            </button>
          </div>
        ) : (
          <div className="flex-1 text-sm text-gray-400">No document uploaded</div>
        )}
        {!disabled && (
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              className="hidden"
              onChange={(e) => onUpload(e.target.files[0])}
            />
            <div className="flex items-center gap-1 px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {existingUrl ? 'Replace' : 'Upload'}
            </div>
          </label>
        )}
      </div>
      {extra}
    </div>
  );
}