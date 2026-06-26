import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Globe, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

export default function AdminResellerBranding() {
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const res = await apiFetch('/reseller/custom-domain');
      if (res && res.custom_domain) {
        setDomain(res.custom_domain);
      }
    } catch (e) {
      console.error('Failed to load custom domain:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!domain.includes('.')) {
      toast.error('Please enter a valid domain (e.g. portal.myagency.com)');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/reseller/custom-domain', {
        method: 'POST',
        body: JSON.stringify({ custom_domain: domain })
      });
      if (res.error) throw new Error(res.error);
      toast.success('Custom domain updated successfully. DNS propagation may take up to 24 hours.');
    } catch (e) {
      toast.error(e.message || 'Failed to bind custom domain');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Custom Domain</h1>
        <p className="text-gray-600 mt-1">Configure your white-labeled reseller platform domain.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-blue-600" />
            Domain Settings
          </CardTitle>
          <CardDescription>
            Point your custom domain (e.g., <strong>portal.youragency.com</strong>) to our servers by creating a CNAME record pointing to <strong>app.bolify.ai</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <Label>Your Custom Domain</Label>
            <div className="flex gap-4 mt-1">
              <Input 
                placeholder="portal.youragency.com" 
                value={domain}
                onChange={(e) => setDomain(e.target.value.toLowerCase())}
                className="max-w-md"
              />
              <Button onClick={handleSave} disabled={saving || !domain}>
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Save Domain
              </Button>
            </div>
          </div>

          <div className="bg-gray-50 border p-4 rounded-lg text-sm text-gray-700">
            <strong>DNS Configuration Instructions:</strong>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Log in to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.)</li>
              <li>Navigate to the DNS Settings / Zone Editor for your domain.</li>
              <li>Create a new <strong>CNAME</strong> record.</li>
              <li>Set the Name/Host to your desired subdomain (e.g., <strong>portal</strong>).</li>
              <li>Set the Value/Target to <strong>app.bolify.ai</strong></li>
              <li>Once saved, come back here and enter the full domain (e.g., portal.youragency.com) to link it to your reseller account.</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
