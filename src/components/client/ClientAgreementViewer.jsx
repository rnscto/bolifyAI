import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileText, Download, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import moment from 'moment';

export default function ClientAgreementViewer({ clientId }) {
  const [agreements, setAgreements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewHtml, setViewHtml] = useState(null);

  useEffect(() => {
    if (clientId) loadAgreements();
  }, [clientId]);

  const loadAgreements = async () => {
    const agrs = await base44.entities.ClientAgreement.filter({ client_id: clientId }, '-created_date');
    setAgreements(agrs);
    setLoading(false);
  };

  const handlePrint = (agreement) => {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html><head><title>Agreement - ${agreement.agreement_number}</title>
      <style>body{margin:0}@media print{body{-webkit-print-color-adjust:exact}}</style>
      </head><body>${agreement.rendered_html}</body></html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  if (agreements.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-gray-500">
          <FileText className="w-10 h-10 mx-auto mb-3 text-gray-300" />
          <p className="font-medium">No agreements found</p>
          <p className="text-sm mt-1">Your service agreement will appear here once signed.</p>
        </CardContent>
      </Card>
    );
  }

  if (viewHtml) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={() => setViewHtml(null)}>← Back to list</Button>
        <Card><CardContent className="p-6"><div dangerouslySetInnerHTML={{ __html: viewHtml }} /></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {agreements.map((agr) => (
        <Card key={agr.id}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${agr.status === 'signed' ? 'bg-green-100' : 'bg-yellow-100'}`}>
                  {agr.status === 'signed' ? <CheckCircle2 className="w-5 h-5 text-green-600" /> : <Clock className="w-5 h-5 text-yellow-600" />}
                </div>
                <div>
                  <p className="font-semibold text-sm">{agr.agreement_number}</p>
                  <p className="text-xs text-gray-500">
                    {agr.status === 'signed' ? `Signed on ${moment(agr.signed_date).format('DD MMM YYYY, h:mm A')}` : 'Awaiting signature'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={agr.status === 'signed' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}>
                  {agr.status === 'signed' ? 'Signed' : 'Pending'}
                </Badge>
                {agr.status === 'signed' && agr.rendered_html && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setViewHtml(agr.rendered_html)}><FileText className="w-4 h-4 mr-1" /> View</Button>
                    <Button size="sm" variant="outline" onClick={() => handlePrint(agr)}><Download className="w-4 h-4 mr-1" /> Print/PDF</Button>
                  </>
                )}
              </div>
            </div>
            {agr.status === 'signed' && (
              <div className="mt-3 pt-3 border-t text-xs text-gray-400 flex gap-4 flex-wrap">
                <span>Signed by: <strong className="text-gray-600">{agr.signature_name}</strong></span>
                <span>Effective: {agr.effective_date}</span>
                <span>Expires: {agr.expiry_date}</span>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}