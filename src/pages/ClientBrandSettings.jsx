import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Palette, Target, MessageSquare, Globe, Sparkles, Save, Loader2, Upload, X, Plus } from 'lucide-react';
import { toast } from "@/components/ui/use-toast";

export default function ClientBrandSettings() {
  const [client, setClient] = useState(null);
  const [settings, setSettings] = useState(null);
  const [settingsId, setSettingsId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newTheme, setNewTheme] = useState('');

  const [form, setForm] = useState({
    brand_voice: '',
    tone: 'professional',
    target_audience: '',
    logo_url: '',
    brand_colors: '',
    tagline: '',
    content_themes: [],
    avoid_topics: '',
    language_preference: 'english',
    posting_frequency: 'daily',
    cta_style: '',
    competitor_brands: ''
  });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const user = await base44.auth.me();
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) { setLoading(false); return; }
    const c = clients[0];
    setClient(c);

    const existing = await base44.entities.BrandSettings.filter({ client_id: c.id });
    if (existing.length > 0) {
      const s = existing[0];
      setSettingsId(s.id);
      setSettings(s);
      setForm({
        brand_voice: s.brand_voice || '',
        tone: s.tone || 'professional',
        target_audience: s.target_audience || '',
        logo_url: s.logo_url || '',
        brand_colors: s.brand_colors || '',
        tagline: s.tagline || '',
        content_themes: s.content_themes || [],
        avoid_topics: s.avoid_topics || '',
        language_preference: s.language_preference || 'english',
        posting_frequency: s.posting_frequency || 'daily',
        cta_style: s.cta_style || '',
        competitor_brands: s.competitor_brands || ''
      });
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
    toast({ title: "Saved!", description: "Brand settings updated successfully" });
    setSaving(false);
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    setForm(f => ({ ...f, logo_url: file_url }));
  };

  const addTheme = () => {
    if (newTheme.trim() && !form.content_themes.includes(newTheme.trim())) {
      setForm(f => ({ ...f, content_themes: [...f.content_themes, newTheme.trim()] }));
      setNewTheme('');
    }
  };

  const removeTheme = (theme) => {
    setForm(f => ({ ...f, content_themes: f.content_themes.filter(t => t !== theme) }));
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">Brand Settings</h1>
        <p className="text-gray-500 text-sm">Define your brand identity for AI-generated social media content</p>
      </div>

      {/* Brand Voice & Tone */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><MessageSquare className="w-5 h-5 text-purple-600" /> Brand Voice & Tone</CardTitle>
          <CardDescription>How should your content sound?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Brand Voice</Label>
            <Textarea placeholder="e.g., We are a modern fitness brand that inspires people to live healthier lives through accessible, science-backed wellness solutions..." value={form.brand_voice} onChange={e => setForm(f => ({ ...f, brand_voice: e.target.value }))} rows={3} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Tone</Label>
              <Select value={form.tone} onValueChange={v => setForm(f => ({ ...f, tone: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="casual">Casual</SelectItem>
                  <SelectItem value="witty">Witty</SelectItem>
                  <SelectItem value="inspirational">Inspirational</SelectItem>
                  <SelectItem value="bold">Bold</SelectItem>
                  <SelectItem value="friendly">Friendly</SelectItem>
                  <SelectItem value="formal">Formal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Language</Label>
              <Select value={form.language_preference} onValueChange={v => setForm(f => ({ ...f, language_preference: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="english">English</SelectItem>
                  <SelectItem value="hindi">Hindi</SelectItem>
                  <SelectItem value="hinglish">Hinglish</SelectItem>
                  <SelectItem value="bilingual">Bilingual (EN + HI)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Tagline / Slogan</Label>
            <Input placeholder="Your brand tagline..." value={form.tagline} onChange={e => setForm(f => ({ ...f, tagline: e.target.value }))} />
          </div>
        </CardContent>
      </Card>

      {/* Visual Identity */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><Palette className="w-5 h-5 text-blue-600" /> Visual Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Brand Logo</Label>
            <div className="flex items-center gap-4 mt-1">
              {form.logo_url ? (
                <div className="relative w-20 h-20 border rounded-lg overflow-hidden">
                  <img src={form.logo_url} alt="Logo" className="w-full h-full object-contain" />
                  <button onClick={() => setForm(f => ({ ...f, logo_url: '' }))} className="absolute top-0 right-0 bg-red-500 text-white rounded-full p-0.5"><X className="w-3 h-3" /></button>
                </div>
              ) : (
                <label className="flex items-center gap-2 px-4 py-2 border-2 border-dashed rounded-lg cursor-pointer hover:bg-gray-50">
                  <Upload className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-500">Upload Logo</span>
                  <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                </label>
              )}
            </div>
          </div>
          <div>
            <Label>Brand Colors</Label>
            <Input placeholder="e.g., #2563eb, #f59e0b, #10b981" value={form.brand_colors} onChange={e => setForm(f => ({ ...f, brand_colors: e.target.value }))} />
          </div>
        </CardContent>
      </Card>

      {/* Audience & Strategy */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><Target className="w-5 h-5 text-green-600" /> Audience & Strategy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Target Audience</Label>
            <Textarea placeholder="e.g., Young professionals aged 25-40 in urban India, interested in fitness and wellness..." value={form.target_audience} onChange={e => setForm(f => ({ ...f, target_audience: e.target.value }))} rows={2} />
          </div>
          <div>
            <Label>Content Themes</Label>
            <div className="flex flex-wrap gap-2 mt-1 mb-2">
              {form.content_themes.map(t => (
                <Badge key={t} variant="secondary" className="gap-1">{t} <button onClick={() => removeTheme(t)}><X className="w-3 h-3" /></button></Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input placeholder="Add a theme..." value={newTheme} onChange={e => setNewTheme(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTheme())} />
              <Button size="sm" variant="outline" onClick={addTheme}><Plus className="w-4 h-4" /></Button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Posting Frequency</Label>
              <Select value={form.posting_frequency} onValueChange={v => setForm(f => ({ ...f, posting_frequency: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily (2 posts)</SelectItem>
                  <SelectItem value="twice_daily">Twice Daily (4 posts)</SelectItem>
                  <SelectItem value="thrice_weekly">3x per week</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>CTA Style</Label>
              <Input placeholder="e.g., Visit our website, Call now, DM us" value={form.cta_style} onChange={e => setForm(f => ({ ...f, cta_style: e.target.value }))} />
            </div>
          </div>
          <div>
            <Label>Topics to Avoid</Label>
            <Input placeholder="e.g., Politics, controversial topics, competitor comparisons" value={form.avoid_topics} onChange={e => setForm(f => ({ ...f, avoid_topics: e.target.value }))} />
          </div>
          <div>
            <Label>Competitor Brands</Label>
            <Input placeholder="e.g., Brand X, Brand Y (for differentiation)" value={form.competitor_brands} onChange={e => setForm(f => ({ ...f, competitor_brands: e.target.value }))} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} className="gap-2 px-8">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Brand Settings'}
        </Button>
      </div>
    </div>
  );
}