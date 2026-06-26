import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, Save, Upload } from 'lucide-react';
import { toast } from 'sonner';

export default function AdminPartnerEditDialog({ partner, open, onOpenChange, onSaved }) {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (partner) {
      setForm({
        name: partner.name || '',
        phone: partner.phone || '',
        company_name: partner.company_name || '',
        city: partner.city || '',
        state: partner.state || '',
        commission_rate: partner.commission_rate ?? 20,
        gst_number: partner.gst_number || '',
        pan_number: partner.pan_number || '',
        bank_name: partner.bank_name || '',
        bank_account_number: partner.bank_account_number || '',
        bank_ifsc: partner.bank_ifsc || '',
        upi_id: partner.upi_id || '',
        notes: partner.notes || '',
        brand_logo_url: partner.brand_logo_url || '',
        brand_color: partner.brand_color || '#2563eb',
        brand_tagline: partner.brand_tagline || '',
      });
    }
  }, [partner]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const { file_url } = await apiClient.integrations.Core.UploadFile({ file });
    set('brand_logo_url', file_url);
    setUploading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await apiClient.Partner.update(partner.id, form);
    toast.success(`${form.name} updated`);
    setSaving(false);
    onSaved?.();
    onOpenChange(false);
  };

  if (!partner) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Partner — {partner.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          {/* Contact */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Contact</p>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Name</Label><Input value={form.name} onChange={e => set('name', e.target.value)} /></div>
              <div><Label className="text-xs">Phone</Label><Input value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
              <div><Label className="text-xs">Company</Label><Input value={form.company_name} onChange={e => set('company_name', e.target.value)} /></div>
              <div><Label className="text-xs">City</Label><Input value={form.city} onChange={e => set('city', e.target.value)} /></div>
              <div><Label className="text-xs">State</Label><Input value={form.state} onChange={e => set('state', e.target.value)} /></div>
              <div><Label className="text-xs">Commission Rate (%)</Label><Input type="number" min={0} max={100} value={form.commission_rate} onChange={e => set('commission_rate', Number(e.target.value))} /></div>
            </div>
          </div>

          {/* Tax */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Tax Details</p>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">GST</Label><Input value={form.gst_number} onChange={e => set('gst_number', e.target.value)} /></div>
              <div><Label className="text-xs">PAN</Label><Input value={form.pan_number} onChange={e => set('pan_number', e.target.value)} /></div>
            </div>
          </div>

          {/* Bank */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Bank / Payout</p>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Bank Name</Label><Input value={form.bank_name} onChange={e => set('bank_name', e.target.value)} /></div>
              <div><Label className="text-xs">Account No.</Label><Input value={form.bank_account_number} onChange={e => set('bank_account_number', e.target.value)} /></div>
              <div><Label className="text-xs">IFSC</Label><Input value={form.bank_ifsc} onChange={e => set('bank_ifsc', e.target.value)} /></div>
              <div><Label className="text-xs">UPI ID</Label><Input value={form.upi_id} onChange={e => set('upi_id', e.target.value)} /></div>
            </div>
          </div>

          {/* Branding */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Branding</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label className="text-xs">Logo</Label>
                <div className="flex items-center gap-3 mt-1">
                  {form.brand_logo_url ? (
                    <img src={form.brand_logo_url} alt="Logo" className="h-10 object-contain rounded border p-1" />
                  ) : (
                    <div className="h-10 w-20 bg-gray-100 rounded border flex items-center justify-center text-xs text-gray-400">No logo</div>
                  )}
                  <label className="cursor-pointer">
                    <Button variant="outline" size="sm" asChild disabled={uploading}>
                      <span>{uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Upload className="w-3 h-3 mr-1" /> Upload</>}</span>
                    </Button>
                    <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                  </label>
                </div>
              </div>
              <div>
                <Label className="text-xs">Brand Color</Label>
                <div className="flex items-center gap-2 mt-1">
                  <input type="color" value={form.brand_color} onChange={e => set('brand_color', e.target.value)} className="w-10 h-9 rounded border cursor-pointer" />
                  <Input value={form.brand_color} onChange={e => set('brand_color', e.target.value)} className="font-mono" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Tagline</Label>
                <Input value={form.brand_tagline} onChange={e => set('brand_tagline', e.target.value)} placeholder="e.g. Powered by YourBrand" />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label className="text-xs">Admin Notes</Label>
            <Input value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Internal notes..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}