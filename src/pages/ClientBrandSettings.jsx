import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Save, Loader2, MessageSquare, ShoppingBag, Phone, CalendarDays } from 'lucide-react';
import { toast } from "@/components/ui/use-toast";
import BrandVoiceTab from '../components/brand/BrandVoiceTab';
import ProductsServicesTab from '../components/brand/ProductsServicesTab';
import ContactSocialTab from '../components/brand/ContactSocialTab';
import OccasionsTab from '../components/brand/OccasionsTab';

const DEFAULT_FORM = {
  brand_voice: '', tone: 'professional', target_audience: '', logo_url: '', brand_colors: '',
  tagline: '', content_themes: [], avoid_topics: '', language_preference: 'english',
  posting_frequency: 'daily', cta_style: '', competitor_brands: '', about_brand: '',
  products: [], services: [], usps: [], features: [], pricing_info: '', current_offers: [],
  addresses: [], contact_phone: '', contact_email: '', contact_whatsapp: '', website_url: '',
  social_instagram: '', social_facebook: '', social_linkedin: '', social_twitter: '',
  social_youtube: '', google_maps_link: '', enabled_occasions: [], custom_occasions: [],
};

export default function ClientBrandSettings() {
  const [client, setClient] = useState(null);
  const [settingsId, setSettingsId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newTheme, setNewTheme] = useState('');
  const [form, setForm] = useState({ ...DEFAULT_FORM });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) { setLoading(false); return; }
    setClient(clients[0]);

    const existing = await base44.entities.BrandSettings.filter({ client_id: clients[0].id });
    if (existing.length > 0) {
      const s = existing[0];
      setSettingsId(s.id);
      const merged = { ...DEFAULT_FORM };
      Object.keys(DEFAULT_FORM).forEach(k => {
        if (s[k] !== undefined && s[k] !== null) merged[k] = s[k];
      });
      setForm(merged);
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const data = { ...form, client_id: client.id };
    if (settingsId) {
      await base44.entities.BrandSettings.update(settingsId, data);
    } else {
      const created = await base44.entities.BrandSettings.create(data);
      setSettingsId(created.id);
    }
    toast({ title: "Saved!", description: "Brand settings updated successfully." });
    setSaving(false);
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Brand Profile</h1>
          <p className="text-gray-500 text-sm">Complete your brand info for better AI-generated social media content</p>
        </div>
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save All'}
        </Button>
      </div>

      <Tabs defaultValue="brand" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="brand" className="gap-1.5 text-xs sm:text-sm"><MessageSquare className="w-4 h-4 hidden sm:inline" /> Brand & Voice</TabsTrigger>
          <TabsTrigger value="products" className="gap-1.5 text-xs sm:text-sm"><ShoppingBag className="w-4 h-4 hidden sm:inline" /> Products & Services</TabsTrigger>
          <TabsTrigger value="contact" className="gap-1.5 text-xs sm:text-sm"><Phone className="w-4 h-4 hidden sm:inline" /> Contact & Social</TabsTrigger>
          <TabsTrigger value="occasions" className="gap-1.5 text-xs sm:text-sm"><CalendarDays className="w-4 h-4 hidden sm:inline" /> Marketing Calendar</TabsTrigger>
        </TabsList>

        <TabsContent value="brand">
          <BrandVoiceTab form={form} setForm={setForm} newTheme={newTheme} setNewTheme={setNewTheme} />
        </TabsContent>
        <TabsContent value="products">
          <ProductsServicesTab form={form} setForm={setForm} />
        </TabsContent>
        <TabsContent value="contact">
          <ContactSocialTab form={form} setForm={setForm} />
        </TabsContent>
        <TabsContent value="occasions">
          <OccasionsTab form={form} setForm={setForm} />
        </TabsContent>
      </Tabs>

      <div className="flex justify-end pb-8">
        <Button onClick={handleSave} disabled={saving} className="gap-2 px-8">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Brand Profile'}
        </Button>
      </div>
    </div>
  );
}