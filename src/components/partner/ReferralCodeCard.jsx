import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Copy, Check, Link2, QrCode } from 'lucide-react';
import { toast } from 'sonner';

export default function ReferralCodeCard({ partner }) {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const copyToClipboard = (text, type) => {
    navigator.clipboard.writeText(text);
    if (type === 'code') {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } else {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
    toast.success('Copied to clipboard!');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2"><Link2 className="w-5 h-5" /> Your Referral Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-xs text-gray-500 font-medium">Referral Code</label>
          <div className="flex gap-2 mt-1">
            <Input value={partner?.referral_code || ''} readOnly className="font-mono text-lg font-bold tracking-wider" />
            <Button variant="outline" size="icon" onClick={() => copyToClipboard(partner?.referral_code, 'code')}>
              {copiedCode ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500 font-medium">Referral Link</label>
          <div className="flex gap-2 mt-1">
            <Input value={partner?.referral_link || ''} readOnly className="text-sm text-blue-600" />
            <Button variant="outline" size="icon" onClick={() => copyToClipboard(partner?.referral_link, 'link')}>
              {copiedLink ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500 font-medium">Branded Referral Page</label>
          <div className="flex gap-2 mt-1">
            <Input value={`${window.location.origin}/PartnerReferral?code=${partner?.referral_code}`} readOnly className="text-sm text-blue-600" />
            <Button variant="outline" size="icon" onClick={() => copyToClipboard(`${window.location.origin}/PartnerReferral?code=${partner?.referral_code}`, 'link')}>
              {copiedLink ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-xs text-gray-400 mt-1">Share this page — it shows your branding</p>
        </div>
        <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-800">
          <p className="font-medium">Commission: {partner?.commission_rate || 20}% recurring revenue</p>
          <p className="text-xs text-blue-600 mt-1">You earn every month as long as your referred client stays active.</p>
        </div>
      </CardContent>
    </Card>
  );
}