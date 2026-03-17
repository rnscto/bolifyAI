import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, Save, Upload, User, Building2, CreditCard, Palette } from 'lucide-react';
import { toast } from 'sonner';

export default function PartnerProfileEditor({ partner, onSaved }) {
  const [form, setForm] = useState({
    name: partner?.name || '',
    phone: partner?.phone || '',
    company_name: partner?.company_name || '',
    city: partner?.city || '',
    state: partner?.state || '',
    gst_number: partner?.gst_number || '',
    pan_number: partner?.pan_number || '',
    bank_name: partner?.bank_name || '',
    bank_account_number: partner?.bank_account_number || '',
    bank_ifsc: partner?.bank_ifsc || '',
    upi_id: partner?.upi_id || '',
    brand_logo_url: partner?.brand_logo_url || '',
    brand_color: partner?.brand_color || '#2563eb',
    brand_tagline: partner?.brand_tagline || '',
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    set('brand_logo_url', file_url);
    setUploading(false);
    toast.success('Logo uploaded');
  };

  const handleSave = async () => {
    setSaving(true);
    await base44.entities.Partner.update(partner.id, form);
    toast.success('Profile updated!');
    setSaving(false);
    onSaved?.();
  };

  const Section = ({ icon: Icon, title, children }) => (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
        <Icon className="w-4 h-4" /> {title}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {children}
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Edit Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <Section icon={User} title="Contact Info">
          <div><Label className="text-xs">Full Name</Label><Input value={form.name} onChange={e => set('name', e.target.value)} /></div>
          <div><Label className="text-xs">Phone</Label><Input value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
          <div><Label className="text-xs">Company Name</Label><Input value={form.company_name} onChange={e => set('company_name', e.target.value)} /></div>
          <div><Label className="text-xs">City</Label><Input value={form.city} onChange={e => set('city', e.target.value)} /></div>
          <div><Label className="text-xs">State</Label><Input value={form.state} onChange={e => set('state', e.target.value)} /></div>
        </Section>

        <Section icon={Building2} title="Tax Details">
          <div><Label className="text-xs">GST Number</Label><Input value={form.gst_number} onChange={e => set('gst_number', e.target.value)} /></div>
          <div><Label className="text-xs">PAN Number</Label><Input value={form.pan_number} onChange={e => set('pan_number', e.target.value)} /></div>
        </Section>

        <Section icon={CreditCard} title="Bank / Payout Details">
          <div><Label className="text-xs">Bank Name</Label><Input value={form.bank_name} onChange={e => set('bank_name', e.target.value)} /></div>
          <div><Label className="text-xs">Account Number</Label><Input value={form.bank_account_number} onChange={e => set('bank_account_number', e.target.value)} /></div>
          <div><Label className="text-xs">IFSC Code</Label><Input value={form.bank_ifsc} onChange={e => set('bank_ifsc', e.target.value)} /></div>
          <div><Label className="text-xs">UPI ID</Label><Input value={form.upi_id} onChange={e => set('upi_id', e.target.value)} /></div>
        </Section>

        <Section icon={Palette} title="Branding (White-Label Referral Page)">
          <div className="md:col-span-2">
            <Label className="text-xs">Brand Logo</Label>
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
        </Section>

        <div className="flex justify-end pt-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            Save Changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}