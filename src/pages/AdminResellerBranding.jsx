import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Globe, Loader2, Save, CheckCircle2, Info } from 'lucide-react';
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
      toast.success('Custom domain saved! DNS propagation may take up to 24 hours.');
    } catch (e) {
      toast.error(e.message || 'Failed to bind custom domain');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Custom Domain</h1>
        <p className="text-gray-400 mt-1">Configure your white-labeled reseller platform domain.</p>
      </div>

      {/* Current domain status */}
      {domain && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-emerald-300">Active Domain</p>
            <p className="text-xs text-emerald-500 font-mono">{domain}</p>
          </div>
        </div>
      )}

      {/* Domain Settings Card */}
      <Card className="border border-white/8 bg-white/5 backdrop-blur-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-gray-200">
            <Globe className="w-5 h-5 text-cyan-400" />
            Domain Settings
          </CardTitle>
          <CardDescription className="text-gray-500">
            Point your custom domain (e.g., <span className="text-gray-300 font-mono">portal.youragency.com</span>) to our
            servers by creating a CNAME record pointing to <span className="text-cyan-400 font-mono">app.bolify.ai</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <Label className="text-gray-300">Your Custom Domain</Label>
            <div className="flex gap-3 mt-2">
              <Input
                placeholder="portal.youragency.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value.toLowerCase())}
                className="max-w-md bg-white/5 border-white/10 text-gray-200 placeholder:text-gray-600 focus:border-cyan-500/50"
              />
              <Button
                onClick={handleSave}
                disabled={saving || !domain}
                className="bg-cyan-600 hover:bg-cyan-500 text-white"
              >
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Save Domain
              </Button>
            </div>
          </div>

          {/* DNS Instructions */}
          <div className="bg-white/5 border border-white/8 rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-cyan-400 shrink-0" />
              <p className="text-sm font-semibold text-gray-300">DNS Configuration Instructions</p>
            </div>
            <ol className="list-decimal pl-5 space-y-1.5 text-sm text-gray-400">
              <li>Log in to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.)</li>
              <li>Navigate to the DNS Settings / Zone Editor for your domain.</li>
              <li>Create a new <span className="text-cyan-400 font-mono font-semibold">CNAME</span> record.</li>
              <li>Set the Name/Host to your desired subdomain (e.g., <span className="text-gray-200 font-mono">portal</span>).</li>
              <li>Set the Value/Target to <span className="text-cyan-400 font-mono">app.bolify.ai</span></li>
              <li>Once saved, come back here and enter the full domain (e.g., portal.youragency.com) to link it.</li>
            </ol>
          </div>

          {/* DNS Record Preview */}
          <div className="bg-[#0f1115] border border-white/8 rounded-xl p-4 font-mono text-xs">
            <p className="text-gray-500 mb-2">Example DNS Record:</p>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <p className="text-gray-600 text-[10px] uppercase tracking-wider mb-1">Type</p>
                <p className="text-cyan-400">CNAME</p>
              </div>
              <div>
                <p className="text-gray-600 text-[10px] uppercase tracking-wider mb-1">Host</p>
                <p className="text-gray-300">portal</p>
              </div>
              <div>
                <p className="text-gray-600 text-[10px] uppercase tracking-wider mb-1">Target</p>
                <p className="text-gray-300">app.bolify.ai</p>
              </div>
              <div>
                <p className="text-gray-600 text-[10px] uppercase tracking-wider mb-1">TTL</p>
                <p className="text-gray-300">3600</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
