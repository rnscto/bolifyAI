import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, FileText, Shield, CheckCircle2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import SignatureCanvas from '../partner/SignatureCanvas';

export default function AgreementSignStep({ onNext, onBack, profileData, user }) {
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [signatureName, setSignatureName] = useState(user?.full_name || '');
  const [signatureImage, setSignatureImage] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [renderedHtml, setRenderedHtml] = useState('');
  const [noTemplate, setNoTemplate] = useState(false);

  useEffect(() => {
    loadTemplate();
  }, []);

  const loadTemplate = async () => {
    const templates = await apiClient.ClientAgreementTemplate.filter({ status: 'active' });
    if (templates.length > 0) {
      setTemplate(templates[0]);
      renderPreview(templates[0]);
    } else {
      setNoTemplate(true);
    }
    setLoading(false);
  };

  const renderPreview = (tmpl) => {
    if (!tmpl?.body_html) return;
    const now = new Date();
    const formattedDate = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    let html = tmpl.body_html
      .replace(/\{\{agreement_number\}\}/g, 'BOLIFY-CSA-XXXX-XXX')
      .replace(/\{\{effective_date_formatted\}\}/g, formattedDate)
      .replace(/\{\{client_name\}\}/g, profileData.company_name || '')
      .replace(/\{\{signatory_name\}\}/g, user?.full_name || '')
      .replace(/\{\{signatory_email\}\}/g, user?.email || '')
      .replace(/\{\{client_address\}\}/g, 'As registered')
      .replace(/\{\{company_signatory_name\}\}/g, tmpl.company_signatory_name || '')
      .replace(/\{\{company_signatory_designation\}\}/g, tmpl.company_signatory_designation || '')
      .replace(/\{\{signed_date_formatted\}\}/g, '___________________')
      .replace(/\{\{client_signature\}\}/g, '<em style="color:#999">Awaiting signature...</em>')
      .replace(/\{\{signed_timestamp\}\}/g, '___________________')
      .replace(/\{\{signed_ip\}\}/g, '___________________');
    setRenderedHtml(html);
  };

  const handleSign = async () => {
    if (!signatureName.trim()) { toast.error('Please type your full name'); return; }
    if (!signatureImage) { toast.error('Please draw your signature'); return; }
    if (!agreed) { toast.error('Please accept the terms'); return; }

    setSigning(true);

    // Upload signature
    const blob = await (await fetch(signatureImage)).blob();
    const file = new File([blob], `client_sig_${Date.now()}.png`, { type: 'image/png' });
    const { file_url } = await apiClient.integrations.Core.UploadFile({ file });

    const signedDate = new Date();
    const signedTimestamp = signedDate.toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'medium', timeZone: 'Asia/Kolkata' }) + ' IST';

    // Generate agreement number
    const allAgr = await apiClient.ClientAgreement.list();
    const agrNum = `BOLIFY-CSA-${signedDate.getFullYear()}-${String(allAgr.length + 1).padStart(3, '0')}`;
    const effectiveDate = signedDate.toISOString().split('T')[0];
    const expiryDate = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
    const formattedEffective = signedDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    // Render final HTML
    let finalHtml = template.body_html
      .replace(/\{\{agreement_number\}\}/g, agrNum)
      .replace(/\{\{effective_date_formatted\}\}/g, formattedEffective)
      .replace(/\{\{client_name\}\}/g, profileData.company_name || '')
      .replace(/\{\{signatory_name\}\}/g, signatureName)
      .replace(/\{\{signatory_email\}\}/g, user?.email || '')
      .replace(/\{\{client_address\}\}/g, 'As registered')
      .replace(/\{\{company_signatory_name\}\}/g, template.company_signatory_name || '')
      .replace(/\{\{company_signatory_designation\}\}/g, template.company_signatory_designation || '')
      .replace(/\{\{signed_date_formatted\}\}/g, formattedEffective)
      .replace(/\{\{client_signature\}\}/g, `<img src="${file_url}" style="max-height:60px;" alt="Client Signature" />`)
      .replace(/\{\{signed_timestamp\}\}/g, signedTimestamp)
      .replace(/\{\{signed_ip\}\}/g, 'Recorded on server');

    // Pass agreement data to parent for saving after client creation
    onNext({
      template_id: template.id,
      template_version: template.version,
      agreement_number: agrNum,
      signature_name: signatureName,
      signature_image_url: file_url,
      signed_date: signedDate.toISOString(),
      effective_date: effectiveDate,
      expiry_date: expiryDate,
      rendered_html: finalHtml,
      company_signatory_name: template.company_signatory_name,
      company_signatory_designation: template.company_signatory_designation,
    });

    setSigning(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  // If no template configured, skip this step
  if (noTemplate) {
    return (
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-8 h-8 text-green-600" />
        </div>
        <h2 className="text-2xl font-bold">No Agreement Required</h2>
        <p className="text-gray-500">Service agreement is not configured yet. You can proceed.</p>
        <div className="flex justify-between pt-4">
          <Button variant="outline" onClick={onBack} className="h-11"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Button>
          <Button onClick={() => onNext(null)} className="bg-blue-600 hover:bg-blue-700 h-11">Continue</Button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="text-center mb-4">
        <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <FileText className="w-8 h-8 text-blue-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Service Agreement</h2>
        <p className="text-gray-500 mt-2 max-w-md mx-auto">
          Please review and digitally sign the Client Service Agreement before activating your account.
        </p>
      </div>

      {/* Agreement Body */}
      <Card>
        <CardContent className="p-0">
          <div className="max-h-[400px] overflow-y-auto p-6 border-b">
            <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </div>

          {/* Signature Section */}
          <div className="p-6 bg-gray-50 space-y-5">
            <div className="flex items-center gap-2 text-blue-700 bg-blue-50 p-3 rounded-lg">
              <Shield className="w-5 h-5 shrink-0" />
              <p className="text-xs">This digital signature is legally valid under the IT Act, 2000 (Section 5). Your signature, name, and timestamp are recorded.</p>
            </div>

            <div>
              <Label className="text-sm font-semibold">Draw Your Signature *</Label>
              <SignatureCanvas onSignature={setSignatureImage} />
            </div>

            <div>
              <Label className="text-sm font-semibold">Type Your Full Legal Name *</Label>
              <Input
                value={signatureName}
                onChange={(e) => setSignatureName(e.target.value)}
                placeholder="Enter your full name"
                className="mt-1"
              />
            </div>

            <div className="flex items-start gap-3">
              <Checkbox id="agree-client" checked={agreed} onCheckedChange={setAgreed} className="mt-0.5" />
              <label htmlFor="agree-client" className="text-sm text-gray-700 cursor-pointer">
                I, <strong>{signatureName || user?.full_name}</strong>, have read, understood, and agree to all the terms and conditions in this Service Agreement. I accept full responsibility for compliance with all applicable regulations during my use of the Platform.
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack} className="h-11"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Button>
        <Button
          onClick={handleSign}
          disabled={signing || !signatureImage || !signatureName.trim() || !agreed}
          className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 h-11"
        >
          {signing ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Signing...</> : <><CheckCircle2 className="w-4 h-4 mr-2" /> Sign & Continue</>}
        </Button>
      </div>
    </motion.div>
  );
}