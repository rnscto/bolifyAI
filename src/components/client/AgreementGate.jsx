import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, FileText, Shield, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import SignatureCanvas from '../partner/SignatureCanvas';

export default function AgreementGate({ client, user, onSigned }) {
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [signatureName, setSignatureName] = useState(user?.full_name || '');
  const [signatureImage, setSignatureImage] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [renderedHtml, setRenderedHtml] = useState('');
  const [noTemplate, setNoTemplate] = useState(false);

  useEffect(() => { loadTemplate(); }, []);

  const loadTemplate = async () => {
    const templates = await base44.entities.ClientAgreementTemplate.filter({ status: 'active' });
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
    const formatted = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    let html = tmpl.body_html
      .replace(/\{\{agreement_number\}\}/g, 'GETWAY-CSA-XXXX-XXX')
      .replace(/\{\{effective_date_formatted\}\}/g, formatted)
      .replace(/\{\{client_name\}\}/g, client?.company_name || '')
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

    const blob = await (await fetch(signatureImage)).blob();
    const file = new File([blob], `client_sig_${Date.now()}.png`, { type: 'image/png' });
    const { file_url } = await base44.integrations.Core.UploadFile({ file });

    const signedDate = new Date();
    const signedTimestamp = signedDate.toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'medium', timeZone: 'Asia/Kolkata' }) + ' IST';

    const allAgr = await base44.entities.ClientAgreement.list();
    const agrNum = `GETWAY-CSA-${signedDate.getFullYear()}-${String(allAgr.length + 1).padStart(3, '0')}`;
    const effectiveDate = signedDate.toISOString().split('T')[0];
    const expiryDate = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
    const formattedEffective = signedDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    let finalHtml = template.body_html
      .replace(/\{\{agreement_number\}\}/g, agrNum)
      .replace(/\{\{effective_date_formatted\}\}/g, formattedEffective)
      .replace(/\{\{client_name\}\}/g, client?.company_name || '')
      .replace(/\{\{signatory_name\}\}/g, signatureName)
      .replace(/\{\{signatory_email\}\}/g, user?.email || '')
      .replace(/\{\{client_address\}\}/g, 'As registered')
      .replace(/\{\{company_signatory_name\}\}/g, template.company_signatory_name || '')
      .replace(/\{\{company_signatory_designation\}\}/g, template.company_signatory_designation || '')
      .replace(/\{\{signed_date_formatted\}\}/g, formattedEffective)
      .replace(/\{\{client_signature\}\}/g, `<img src="${file_url}" style="max-height:60px;" alt="Signature" />`)
      .replace(/\{\{signed_timestamp\}\}/g, signedTimestamp)
      .replace(/\{\{signed_ip\}\}/g, 'Recorded on server');

    await base44.entities.ClientAgreement.create({
      client_id: client.id,
      template_id: template.id,
      template_version: template.version,
      agreement_number: agrNum,
      status: 'signed',
      client_name: client.company_name,
      signatory_name: signatureName,
      signatory_email: user.email,
      signatory_designation: 'Authorized Signatory',
      signature_name: signatureName,
      signature_image_url: file_url,
      signed_date: signedDate.toISOString(),
      effective_date: effectiveDate,
      expiry_date: expiryDate,
      rendered_html: finalHtml,
      company_signatory_name: template.company_signatory_name,
      company_signatory_designation: template.company_signatory_designation,
    });

    // Notify admin via ACS
    try {
      await base44.functions.invoke('sendAgreementEmail', {
        type: 'client_gate_admin_notify',
        data: { company_name: client.company_name, email: user.email, agreement_number: agrNum }
      });
    } catch (e) { console.log('Admin email failed:', e); }

    toast.success('Agreement signed successfully!');
    setSigning(false);
    onSigned();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // If no template is configured, don't block
  if (noTemplate) {
    onSigned();
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-blue-50 flex items-start justify-center p-4 pt-8">
      <div className="w-full max-w-3xl space-y-6">
        {/* Header Banner */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h2 className="font-bold text-amber-900 text-lg">Action Required: Sign Service Agreement</h2>
            <p className="text-amber-700 text-sm mt-1">
              To continue using the Getway AI platform, you must review and sign the updated Client Service Agreement.
              This is a one-time requirement for regulatory compliance.
            </p>
          </div>
        </div>

        {/* Agreement Body */}
        <Card className="shadow-lg">
          <CardContent className="p-0">
            <div className="p-4 border-b bg-white rounded-t-xl flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-600" />
              <h3 className="font-semibold">Client Service Agreement</h3>
            </div>
            <div className="max-h-[400px] overflow-y-auto p-6 border-b bg-white">
              <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            </div>

            {/* Signature Section */}
            <div className="p-6 bg-gray-50 rounded-b-xl space-y-5">
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
                <Checkbox id="agree-gate" checked={agreed} onCheckedChange={setAgreed} className="mt-0.5" />
                <label htmlFor="agree-gate" className="text-sm text-gray-700 cursor-pointer">
                  I, <strong>{signatureName || user?.full_name}</strong>, have read, understood, and agree to all the terms and conditions in this Service Agreement. I accept full responsibility for compliance with all applicable regulations during my use of the Platform.
                </label>
              </div>

              <Button
                onClick={handleSign}
                disabled={signing || !signatureImage || !signatureName.trim() || !agreed}
                className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 h-12 text-base"
              >
                {signing ? <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Signing...</> : <><CheckCircle2 className="w-5 h-5 mr-2" /> Sign Agreement & Continue</>}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}