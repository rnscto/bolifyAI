import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Loader2, FileText, Shield, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import SignatureCanvas from './SignatureCanvas';

export default function AgreementAcceptance({ partner, agreement, onSigned }) {
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [signatureName, setSignatureName] = useState('');
  const [signatureImage, setSignatureImage] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [renderedHtml, setRenderedHtml] = useState('');

  useEffect(() => {
    loadTemplate();
  }, [agreement]);

  const loadTemplate = async () => {
    if (!agreement?.template_id) {
      setLoading(false);
      return;
    }
    const tmpl = await apiClient.AgreementTemplate.get(agreement.template_id);
    setTemplate(tmpl);
    renderAgreement(tmpl);
    setLoading(false);
  };

  const renderAgreement = (tmpl) => {
    if (!tmpl?.body_html) return;
    const now = new Date();
    const effectiveDate = agreement.effective_date || now.toISOString().split('T')[0];
    const effectiveDateObj = new Date(effectiveDate);
    const formattedEffective = effectiveDateObj.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    let html = tmpl.body_html
      .replace(/\{\{agreement_number\}\}/g, agreement.agreement_number || '')
      .replace(/\{\{effective_date_formatted\}\}/g, formattedEffective)
      .replace(/\{\{partner_name\}\}/g, partner.name || '')
      .replace(/\{\{partner_company\}\}/g, partner.company_name || partner.name || '')
      .replace(/\{\{partner_address\}\}/g, `${partner.city || ''}, ${partner.state || ''}, India`)
      .replace(/\{\{company_signatory_name\}\}/g, agreement.company_signatory_name || tmpl.company_signatory_name || '')
      .replace(/\{\{company_signatory_designation\}\}/g, agreement.company_signatory_designation || tmpl.company_signatory_designation || '')
      .replace(/\{\{signed_date_formatted\}\}/g, '___________________')
      .replace(/\{\{partner_signature\}\}/g, '<em style="color:#999">Awaiting signature...</em>')
      .replace(/\{\{signed_timestamp\}\}/g, '___________________')
      .replace(/\{\{signed_ip\}\}/g, '___________________');

    setRenderedHtml(html);
  };

  const handleSign = async () => {
    if (!signatureName.trim()) {
      toast.error('Please type your full name');
      return;
    }
    if (!signatureImage) {
      toast.error('Please draw your signature');
      return;
    }
    if (!agreed) {
      toast.error('Please accept the terms');
      return;
    }

    setSigning(true);

    // Upload signature image
    const blob = await (await fetch(signatureImage)).blob();
    const file = new File([blob], `signature_${partner.id}.png`, { type: 'image/png' });
    const { file_url } = await apiClient.integrations.Core.UploadFile({ file });

    const signedDate = new Date();
    const signedDateFormatted = signedDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const signedTimestamp = signedDate.toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'medium', timeZone: 'Asia/Kolkata' }) + ' IST';

    // Render final HTML with signature
    let finalHtml = template.body_html
      .replace(/\{\{agreement_number\}\}/g, agreement.agreement_number || '')
      .replace(/\{\{effective_date_formatted\}\}/g, new Date(agreement.effective_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }))
      .replace(/\{\{partner_name\}\}/g, partner.name || '')
      .replace(/\{\{partner_company\}\}/g, partner.company_name || partner.name || '')
      .replace(/\{\{partner_address\}\}/g, `${partner.city || ''}, ${partner.state || ''}, India`)
      .replace(/\{\{company_signatory_name\}\}/g, agreement.company_signatory_name || '')
      .replace(/\{\{company_signatory_designation\}\}/g, agreement.company_signatory_designation || '')
      .replace(/\{\{signed_date_formatted\}\}/g, signedDateFormatted)
      .replace(/\{\{partner_signature\}\}/g, `<img src="${file_url}" style="max-height:60px;" alt="Partner Signature" />`)
      .replace(/\{\{signed_timestamp\}\}/g, signedTimestamp)
      .replace(/\{\{signed_ip\}\}/g, 'Recorded on server');

    // Update agreement
    await apiClient.PartnerAgreement.update(agreement.id, {
      status: 'signed',
      signature_name: signatureName,
      signature_image_url: file_url,
      signed_date: signedDate.toISOString(),
      signed_ip_address: 'Captured',
      rendered_html: finalHtml
    });

    // Send email notification via ACS
    try {
      await apiClient.functions.invoke('sendAgreementEmail', {
        type: 'partner_signed',
        data: { partner_name: partner.name, partner_email: partner.email, agreement_number: agreement.agreement_number, signed_timestamp: signedTimestamp }
      });
    } catch (e) {
      console.error('Email notification failed:', e);
    }

    // Send copy to admin via ACS
    try {
      await apiClient.functions.invoke('sendAgreementEmail', {
        type: 'partner_admin_notify',
        data: { partner_name: partner.name, partner_email: partner.email, partner_company: partner.company_name || 'N/A', agreement_number: agreement.agreement_number, signed_timestamp: signedTimestamp }
      });
    } catch (e) {
      console.error('Admin email failed:', e);
    }

    toast.success('Agreement signed successfully!');
    setSigning(false);
    onSigned();
  };

  if (loading) {
    return <div className="flex items-center justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card>
        <CardHeader className="text-center border-b bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="flex items-center justify-center gap-2 mb-2">
            <FileText className="w-6 h-6 text-blue-600" />
            <CardTitle className="text-xl">Partner Agreement</CardTitle>
          </div>
          <p className="text-sm text-gray-500">Agreement No: <strong>{agreement.agreement_number}</strong></p>
          <Badge className="bg-yellow-100 text-yellow-800 w-fit mx-auto mt-2">Pending Your Signature</Badge>
        </CardHeader>
        <CardContent className="p-0">
          {/* Agreement Body - Scrollable */}
          <div className="max-h-[500px] overflow-y-auto p-6 border-b">
            <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </div>

          {/* Signature Section */}
          <div className="p-6 bg-gray-50 space-y-5">
            <div className="flex items-center gap-2 text-blue-700 bg-blue-50 p-3 rounded-lg">
              <Shield className="w-5 h-5 shrink-0" />
              <p className="text-sm">This digital signature is legally valid under the Information Technology Act, 2000 (Section 5). Your signature, name, timestamp, and IP address are recorded for legal authentication.</p>
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
                placeholder="Enter your full name as it appears on official documents"
                className="mt-1"
              />
            </div>

            <div className="flex items-start gap-3">
              <Checkbox
                id="agree"
                checked={agreed}
                onCheckedChange={setAgreed}
                className="mt-0.5"
              />
              <label htmlFor="agree" className="text-sm text-gray-700 cursor-pointer">
                I, <strong>{signatureName || partner.name}</strong>, have read, understood, and agree to all the terms and conditions outlined in this Master Channel Partner Agreement. I confirm that I am authorized to sign this agreement on behalf of <strong>{partner.company_name || partner.name}</strong>.
              </label>
            </div>

            <Button
              onClick={handleSign}
              disabled={signing || !signatureImage || !signatureName.trim() || !agreed}
              className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 h-12 text-base"
            >
              {signing ? (
                <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Signing Agreement...</>
              ) : (
                <><CheckCircle2 className="w-5 h-5 mr-2" /> Sign & Accept Agreement</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}