import React from 'react';
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageSquare, Palette, Upload, X, Plus } from 'lucide-react';

export default function BrandVoiceTab({ form, setForm, newTheme, setNewTheme }) {
  const handleLogoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const { apiClient } = await import('@/api/apiClient');
    const { file_url } = await apiClient.integrations.Core.UploadFile({ file });
    setForm(f => ({ ...f, logo_url: file_url }));
  };

  const addTheme = () => {
    if (newTheme.trim() && !form.content_themes.includes(newTheme.trim())) {
      setForm(f => ({ ...f, content_themes: [...f.content_themes, newTheme.trim()] }));
      setNewTheme('');
    }
  };

  return (
    <div className="space-y-6">
      {/* About Brand */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">About Your Brand</CardTitle>
          <CardDescription>Tell the AI about your brand story, mission and vision</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea placeholder="e.g., We are XYZ Corp, founded in 2018 with a mission to make quality healthcare accessible to every Indian household. Our vision is to be India's most trusted wellness brand..." value={form.about_brand} onChange={e => setForm(f => ({ ...f, about_brand: e.target.value }))} rows={4} />
        </CardContent>
      </Card>

      {/* Voice & Tone */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><MessageSquare className="w-5 h-5 text-purple-600" /> Voice & Tone</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Brand Voice</Label>
            <Textarea placeholder="e.g., Conversational yet authoritative. We speak like a knowledgeable friend..." value={form.brand_voice} onChange={e => setForm(f => ({ ...f, brand_voice: e.target.value }))} rows={2} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Tone</Label>
              <Select value={form.tone} onValueChange={v => setForm(f => ({ ...f, tone: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['professional','casual','witty','inspirational','bold','friendly','formal'].map(t => (
                    <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
                  ))}
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

      {/* Visual */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><Palette className="w-5 h-5 text-blue-600" /> Visual Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Brand Logo</Label>
            <div className="flex items-center gap-4 mt-1">
              {form.logo_url ? (
                <div className="relative w-20 h-20 border rounded-lg overflow-hidden bg-gray-100">
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
            <Input placeholder="#2563eb, #f59e0b, #10b981" value={form.brand_colors} onChange={e => setForm(f => ({ ...f, brand_colors: e.target.value }))} />
          </div>
        </CardContent>
      </Card>

      {/* Content Strategy */}
      <Card>
        <CardHeader><CardTitle className="text-lg">Content Strategy</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Target Audience</Label>
            <Textarea placeholder="e.g., Young professionals aged 25-40 in urban India..." value={form.target_audience} onChange={e => setForm(f => ({ ...f, target_audience: e.target.value }))} rows={2} />
          </div>
          <div>
            <Label>Content Themes</Label>
            <div className="flex flex-wrap gap-2 mt-1 mb-2">
              {form.content_themes.map(t => (
                <Badge key={t} variant="secondary" className="gap-1">{t} <button onClick={() => setForm(f => ({ ...f, content_themes: f.content_themes.filter(x => x !== t) }))}><X className="w-3 h-3" /></button></Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input placeholder="Add theme..." value={newTheme} onChange={e => setNewTheme(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTheme())} />
              <Button size="sm" variant="outline" onClick={addTheme}><Plus className="w-4 h-4" /></Button>
            </div>
          </div>
          <div>
            <Label>CTA Style</Label>
            <Input placeholder="Visit our website, Call now, DM us" value={form.cta_style} onChange={e => setForm(f => ({ ...f, cta_style: e.target.value }))} />
          </div>
          <div>
            <Label>Topics to Avoid</Label>
            <Input placeholder="Politics, controversial topics..." value={form.avoid_topics} onChange={e => setForm(f => ({ ...f, avoid_topics: e.target.value }))} />
          </div>
          <div>
            <Label>Competitor Brands</Label>
            <Input placeholder="Brand X, Brand Y" value={form.competitor_brands} onChange={e => setForm(f => ({ ...f, competitor_brands: e.target.value }))} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}