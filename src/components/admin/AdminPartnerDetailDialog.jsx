import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  suspended: 'bg-red-100 text-red-800',
  rejected: 'bg-gray-100 text-gray-800',
};

export default function AdminPartnerDetailDialog({ partner, open, onOpenChange }) {
  if (!partner) return null;

  const brandColor = partner.brand_color || '#2563eb';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Partner Details
            <Badge className={STATUS_COLORS[partner.status]}>{partner.status}</Badge>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {/* Contact */}
          <div className="grid grid-cols-2 gap-3">
            <div><span className="text-gray-500">Name:</span> <strong>{partner.name}</strong></div>
            <div><span className="text-gray-500">Email:</span> {partner.email}</div>
            <div><span className="text-gray-500">Phone:</span> {partner.phone}</div>
            <div><span className="text-gray-500">Company:</span> {partner.company_name || '-'}</div>
            <div><span className="text-gray-500">City:</span> {partner.city || '-'}</div>
            <div><span className="text-gray-500">State:</span> {partner.state || '-'}</div>
          </div>

          {/* Tax */}
          <div className="border-t pt-3 grid grid-cols-2 gap-3">
            <div><span className="text-gray-500">GST:</span> {partner.gst_number || '-'}</div>
            <div><span className="text-gray-500">PAN:</span> {partner.pan_number || '-'}</div>
          </div>

          {/* Bank */}
          <div className="border-t pt-3 grid grid-cols-2 gap-3">
            <div><span className="text-gray-500">Bank:</span> {partner.bank_name || '-'}</div>
            <div><span className="text-gray-500">A/C:</span> {partner.bank_account_number || '-'}</div>
            <div><span className="text-gray-500">IFSC:</span> {partner.bank_ifsc || '-'}</div>
            <div><span className="text-gray-500">UPI:</span> {partner.upi_id || '-'}</div>
          </div>

          {/* Referral Stats */}
          <div className="border-t pt-3 grid grid-cols-2 gap-3">
            <div><span className="text-gray-500">Referral Code:</span> <strong className="font-mono">{partner.referral_code}</strong></div>
            <div><span className="text-gray-500">Commission:</span> {partner.commission_rate}%</div>
            <div><span className="text-gray-500">Total Referrals:</span> {partner.total_referrals || 0}</div>
            <div><span className="text-gray-500">Active:</span> {partner.active_referrals || 0}</div>
            <div><span className="text-gray-500">Earned:</span> ₹{(partner.total_earned || 0).toLocaleString('en-IN')}</div>
            <div><span className="text-gray-500">Paid:</span> ₹{(partner.total_paid || 0).toLocaleString('en-IN')}</div>
          </div>

          {/* Branding Preview */}
          <div className="border-t pt-3">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Branding Preview</p>
            <div className="rounded-lg border overflow-hidden">
              <div className="p-4 text-white text-center" style={{ backgroundColor: brandColor }}>
                {partner.brand_logo_url ? (
                  <img src={partner.brand_logo_url} alt="Logo" className="h-8 mx-auto mb-2 object-contain brightness-0 invert" />
                ) : (
                  <p className="font-bold text-lg">{partner.company_name || partner.name}</p>
                )}
                <p className="text-sm opacity-80">{partner.brand_tagline || `Recommended by ${partner.name}`}</p>
              </div>
              <div className="p-3 bg-gray-50 text-xs text-gray-500 text-center">
                Referral page: /PartnerReferral?code={partner.referral_code}
              </div>
            </div>
          </div>

          {/* Notes */}
          {partner.notes && (
            <div className="border-t pt-3">
              <span className="text-gray-500">Admin Notes:</span>
              <p className="mt-1 text-gray-700">{partner.notes}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}