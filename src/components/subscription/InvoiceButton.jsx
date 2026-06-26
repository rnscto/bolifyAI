import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { apiClient } from '@/api/apiClient';
import { toast } from 'sonner';

export default function InvoiceButton({ paymentId, size = 'sm' }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async (e) => {
    e.stopPropagation();
    setDownloading(true);
    try {
      const response = await fetch(`${apiClient.baseUrl}/billing/generate-invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ payment_id: paymentId })
      });

      if (!response.ok) throw new Error('Failed to download invoice');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `VaaniAI-Invoice-${paymentId.slice(-8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
      toast.success('Invoice downloaded');
    } catch (e) {
      toast.error(e.message);
    }

    setDownloading(false);
  };

  return (
    <Button
      variant="ghost"
      size={size}
      onClick={handleDownload}
      disabled={downloading}
      className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
    >
      {downloading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Download className="w-4 h-4" />
      )}
      <span className="ml-1 hidden sm:inline">Invoice</span>
    </Button>
  );
}