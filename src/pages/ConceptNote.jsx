import React, { useState } from 'react';
import { apiClient } from '@/api/apiClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { FileText, Download, Loader2, CheckCircle2 } from 'lucide-react';

export default function ConceptNote() {
  const [loading, setLoading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    setDownloaded(false);
    const response = await apiClient.functions.invoke('generateConceptNote', {}, { responseType: 'arraybuffer' });
    const blob = new Blob([response.data], { type: 'application/pdf' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'VaaniAI_Concept_Note_Rajasthan_eGovernance.pdf';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
    setLoading(false);
    setDownloaded(true);
  };

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <Card className="border-2 border-blue-100">
        <CardHeader className="text-center pb-2">
          <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <FileText className="w-8 h-8 text-blue-600" />
          </div>
          <CardTitle className="text-2xl">VaaniAI Concept Note</CardTitle>
          <CardDescription className="text-base mt-2">
            AI-Powered Voice Agent for e-Governance — Government of Rajasthan
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-4">
          <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-600 space-y-2">
            <p><strong>Contents include:</strong></p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Executive Summary</li>
              <li>Problem Statement</li>
              <li>Proposed Solution & Features</li>
              <li>Technology Architecture</li>
              <li>Expected Impact & Measurable Outcomes</li>
              <li>Scalability & Sustainability</li>
              <li>Support Required from Department</li>
              <li>Indicative Budget Estimate</li>
              <li>Implementation Timeline</li>
            </ul>
          </div>

          <Button
            onClick={handleDownload}
            disabled={loading}
            className="w-full h-12 text-base bg-gradient-to-r from-blue-600 to-blue-800 hover:from-blue-700 hover:to-blue-900"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Generating PDF...
              </>
            ) : downloaded ? (
              <>
                <CheckCircle2 className="w-5 h-5 mr-2" />
                Downloaded! Click to Download Again
              </>
            ) : (
              <>
                <Download className="w-5 h-5 mr-2" />
                Download Concept Note PDF
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}