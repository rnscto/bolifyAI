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
    
    const response = await apiClient.functions.invoke('generateInvoice', { payment_id: paymentId });
    const blob = new Blob([response.data], { type: 'application/pdf' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VaaniAI-Invoice-${paymentId.slice(-8)}.pdf`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
    toast.success('Invoice downloaded');
    
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