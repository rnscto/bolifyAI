import React from 'react';
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, X, MapPin, Phone, AtSign } from 'lucide-react';

export default function ContactSocialTab({ form, setForm }) {
  const addAddress = () => setForm(f => ({ ...f, addresses: [...(f.addresses || []), { label: '', address: '', city: '', state: '', pincode: '' }] }));
  const removeAddress = (i) => setForm(f => ({ ...f, addresses: (f.addresses || []).filter((_, idx) => idx !== i) }));
  const updateAddress = (i, key, val) => {
    const addrs = [...(form.addresses || [])];
    addrs[i] = { ...addrs[i], [key]: val };
    setForm(f => ({ ...f, addresses: addrs }));
  };

  return (
    <div className="space-y-6">
      {/* Contact Info */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><Phone className="w-5 h-5 text-green-600" /> Contact Information</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Phone Number</Label>
              <Input placeholder="+91 98765 43210" value={form.contact_phone || ''} onChange={e => setForm(f => ({ ...f, contact_phone: e.target.value }))} />
            </div>
            <div>
              <Label>WhatsApp Number</Label>
              <Input placeholder="+91 98765 43210" value={form.contact_whatsapp || ''} onChange={e => setForm(f => ({ ...f, contact_whatsapp: e.target.value }))} />
            </div>
            <div>
              <Label>Email</Label>
              <Input placeholder="hello@yourbrand.com" value={form.contact_email || ''} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} />
            </div>
            <div>
              <Label>Website</Label>
              <Input placeholder="https://yourbrand.com" value={form.website_url || ''} onChange={e => setForm(f => ({ ...f, website_url: e.target.value }))} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Social Handles */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><AtSign className="w-5 h-5 text-pink-600" /> Social Media Handles</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Instagram</Label>
              <Input placeholder="@yourbrand" value={form.social_instagram || ''} onChange={e => setForm(f => ({ ...f, social_instagram: e.target.value }))} />
            </div>
            <div>
              <Label>Facebook</Label>
              <Input placeholder="facebook.com/yourbrand" value={form.social_facebook || ''} onChange={e => setForm(f => ({ ...f, social_facebook: e.target.value }))} />
            </div>
            <div>
              <Label>LinkedIn</Label>
              <Input placeholder="linkedin.com/company/yourbrand" value={form.social_linkedin || ''} onChange={e => setForm(f => ({ ...f, social_linkedin: e.target.value }))} />
            </div>
            <div>
              <Label>Twitter / X</Label>
              <Input placeholder="@yourbrand" value={form.social_twitter || ''} onChange={e => setForm(f => ({ ...f, social_twitter: e.target.value }))} />
            </div>
            <div>
              <Label>YouTube</Label>
              <Input placeholder="youtube.com/@yourbrand" value={form.social_youtube || ''} onChange={e => setForm(f => ({ ...f, social_youtube: e.target.value }))} />
            </div>
            <div>
              <Label>Google Maps Link</Label>
              <Input placeholder="https://maps.google.com/..." value={form.google_maps_link || ''} onChange={e => setForm(f => ({ ...f, google_maps_link: e.target.value }))} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Addresses */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-lg">
            <span className="flex items-center gap-2"><MapPin className="w-5 h-5 text-red-600" /> Business Addresses</span>
            <Button size="sm" variant="outline" onClick={addAddress}><Plus className="w-4 h-4 mr-1" /> Add</Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(!form.addresses || form.addresses.length === 0) && <p className="text-sm text-gray-400">No addresses added yet.</p>}
          {(form.addresses || []).map((addr, i) => (
            <div key={i} className="border rounded-lg p-3 space-y-2 relative">
              <button onClick={() => removeAddress(i)} className="absolute top-2 right-2 text-gray-400 hover:text-red-500"><X className="w-4 h-4" /></button>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pr-6">
                <div>
                  <Label className="text-xs">Label</Label>
                  <Input placeholder="Head Office, Branch..." value={addr.label || ''} onChange={e => updateAddress(i, 'label', e.target.value)} className="text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Pincode</Label>
                  <Input placeholder="110001" value={addr.pincode || ''} onChange={e => updateAddress(i, 'pincode', e.target.value)} className="text-sm" />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs">Full Address</Label>
                  <Input placeholder="123, MG Road..." value={addr.address || ''} onChange={e => updateAddress(i, 'address', e.target.value)} className="text-sm" />
                </div>
                <div>
                  <Label className="text-xs">City</Label>
                  <Input placeholder="Mumbai" value={addr.city || ''} onChange={e => updateAddress(i, 'city', e.target.value)} className="text-sm" />
                </div>
                <div>
                  <Label className="text-xs">State</Label>
                  <Input placeholder="Maharashtra" value={addr.state || ''} onChange={e => updateAddress(i, 'state', e.target.value)} className="text-sm" />
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}