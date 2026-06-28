import React from 'react';
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Sparkles, Upload, X, Image as ImageIcon } from 'lucide-react';
import AdminResellerBranding from '../../pages/AdminResellerBranding';

export default function WhiteLabelTab({ form, setForm }) {
  const handleUpload = async (field, e) => {
    const file = e.target.files[0];
    if (!file) return;
    const { apiClient } = await import('@/api/apiClient');
    const { file_url } = await apiClient.integrations.Core.UploadFile({ file });
    setForm(f => ({ ...f, [field]: file_url }));
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="w-5 h-5 text-cyan-600" />
            Dashboard White-Label
          </CardTitle>
          <CardDescription>
            Customize how the dashboard looks for your team. Your logo, app name, and color will replace the default branding everywhere inside this dashboard. Changes apply after you save and refresh.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Dashboard Logo */}
          <div>
            <Label>Dashboard Logo</Label>
            <p className="text-xs text-gray-500 mb-2">Shown in the top-left of the sidebar. Recommended: square or horizontal PNG, transparent background.</p>
            <div className="flex items-center gap-4">
              {form.dashboard_logo_url ? (
                <div className="relative w-24 h-24 border rounded-lg overflow-hidden bg-gray-50">
                  <img src={form.dashboard_logo_url} alt="Dashboard Logo" className="w-full h-full object-contain" />
                  <button onClick={() => setForm(f => ({ ...f, dashboard_logo_url: '' }))} className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-0.5"><X className="w-3 h-3" /></button>
                </div>
              ) : (
                <label className="flex items-center gap-2 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:bg-gray-50">
                  <Upload className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-500">Upload Logo</span>
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => handleUpload('dashboard_logo_url', e)} />
                </label>
              )}
            </div>
          </div>

          {/* App Name */}
          <div>
            <Label>App Name</Label>
            <p className="text-xs text-gray-500 mb-2">Shown next to the logo and in the browser tab title.</p>
            <Input
              placeholder="e.g., Acme AI"
              value={form.dashboard_app_name || ''}
              onChange={e => setForm(f => ({ ...f, dashboard_app_name: e.target.value }))}
            />
          </div>

          {/* Primary Color */}
          <div>
            <Label>Primary Color</Label>
            <p className="text-xs text-gray-500 mb-2">Used for active menu items, primary buttons, and accents. Enter a hex code.</p>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={form.dashboard_primary_color || '#00bcd4'}
                onChange={e => setForm(f => ({ ...f, dashboard_primary_color: e.target.value }))}
                className="w-12 h-10 rounded border cursor-pointer"
              />
              <Input
                placeholder="#00bcd4"
                value={form.dashboard_primary_color || ''}
                onChange={e => setForm(f => ({ ...f, dashboard_primary_color: e.target.value }))}
                className="max-w-xs font-mono"
              />
            </div>
          </div>

          {/* Favicon */}
          <div>
            <Label>Browser Tab Icon (Favicon)</Label>
            <p className="text-xs text-gray-500 mb-2">A small square icon (32×32 or 64×64 PNG) shown in the browser tab.</p>
            <div className="flex items-center gap-4">
              {form.dashboard_favicon_url ? (
                <div className="relative w-12 h-12 border rounded overflow-hidden bg-gray-50">
                  <img src={form.dashboard_favicon_url} alt="Favicon" className="w-full h-full object-contain" />
                  <button onClick={() => setForm(f => ({ ...f, dashboard_favicon_url: '' }))} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5"><X className="w-2.5 h-2.5" /></button>
                </div>
              ) : (
                <label className="flex items-center gap-2 px-4 py-2 border-2 border-dashed rounded-lg cursor-pointer hover:bg-gray-50">
                  <ImageIcon className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-500">Upload Favicon</span>
                  <input type="file" accept="image/png,image/x-icon,image/svg+xml" className="hidden" onChange={(e) => handleUpload('dashboard_favicon_url', e)} />
                </label>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      
      <div className="mt-8">
        <AdminResellerBranding />
      </div>
    </div>
  );
}