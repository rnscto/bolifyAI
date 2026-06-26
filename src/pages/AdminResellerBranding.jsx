import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Globe, Loader2, CheckCircle2, Info, Copy, ExternalLink, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

export default function AdminResellerBranding() {
  const [domain, setDomain] = useState('');
  const [currentDomain, setCurrentDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dnsConfig, setDnsConfig] = useState(null);
  const [dnsConfirmed, setDnsConfirmed] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      // 1. Fetch current domain binding
      const res = await apiFetch('/reseller/custom-domain');
      if (res && res.custom_domain) {
        setDomain(res.custom_domain);
        setCurrentDomain(res.custom_domain);
      }
      
      // 2. Fetch Azure DNS Requirements
      const configRes = await apiFetch('/reseller/custom-domain-config');
      if (configRes && configRes.success) {
        setDnsConfig({
          verificationId: configRes.verificationId,
          fqdn: configRes.fqdn
        });
      }
    } catch (e) {
      console.error('Failed to load custom domain data:', e);
      toast.error('Failed to connect to Azure configuration server');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text, type) => {
    navigator.clipboard.writeText(text);
    toast.success(`${type} copied to clipboard`);
  };

  const handleSave = async () => {
    if (!domain.includes('.')) {
      toast.error('Please enter a valid domain (e.g. portal.myagency.com)');
      return;
    }
    if (!dnsConfirmed) {
      toast.error('Please confirm that you have added the DNS records before verifying.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/reseller/custom-domain', {
        method: 'POST',
        body: JSON.stringify({ custom_domain: domain })
      });
      if (res.error) throw new Error(res.error);
      
      toast.success('Custom domain successfully verified and bound!');
      setCurrentDomain(domain);
    } catch (e) {
      toast.error(e.message || 'Failed to bind custom domain. Ensure DNS is propagated.');
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

  // Determine subdomains for DNS instructions based on user input
  let subdomain = 'portal';
  if (domain && domain.includes('.')) {
    const parts = domain.split('.');
    if (parts.length > 2) {
      // It's likely a subdomain e.g. portal.agency.com -> subdomain is 'portal'
      subdomain = parts[0];
    } else {
      // Root domain e.g. agency.com -> subdomain is '@' or empty
      subdomain = '@';
    }
  }

  const isAzureConfigured = dnsConfig && dnsConfig.verificationId !== 'AZURE_NOT_CONFIGURED';

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Globe className="w-6 h-6 text-cyan-400" />
          Custom Domain
        </h1>
        <p className="text-gray-400 mt-1">Configure your white-labeled reseller platform domain.</p>
      </div>

      {/* Current domain status */}
      {currentDomain && (
        <div className="flex items-center justify-between px-5 py-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 shadow-lg shadow-emerald-500/5">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-emerald-300">Active Domain Bound</p>
              <a 
                href={`https://${currentDomain}`} 
                target="_blank" 
                rel="noreferrer"
                className="text-base text-emerald-50 font-bold hover:text-emerald-200 transition-colors flex items-center gap-1.5 mt-0.5"
              >
                {currentDomain} <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
          <Badge className="bg-emerald-500/20 text-emerald-300 border-none">Verified</Badge>
        </div>
      )}

      {/* Domain Settings Card */}
      <Card className="border border-white/8 bg-white/5 backdrop-blur-xl shadow-xl">
        <CardHeader className="border-b border-white/5 pb-4">
          <CardTitle className="text-lg text-gray-100 font-bold">Connect a new domain</CardTitle>
          <CardDescription className="text-gray-400">
            Securely map your domain to our cloud infrastructure. We automatically provision an SSL certificate for you.
          </CardDescription>
        </CardHeader>
        
        <CardContent className="space-y-8 pt-6">
          {/* Step 1: Enter Domain */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-400 text-xs font-bold border border-cyan-500/30">1</span>
              <Label className="text-gray-200 font-semibold text-base">Enter the domain you want to use</Label>
            </div>
            <div className="pl-8">
              <Input
                placeholder="e.g. portal.youragency.com"
                value={domain}
                onChange={(e) => {
                  setDomain(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ''));
                  setDnsConfirmed(false);
                }}
                className="max-w-md bg-black/20 border-white/10 text-white placeholder:text-gray-600 focus:border-cyan-500/50 h-11"
              />
              <p className="text-xs text-gray-500 mt-2">We recommend using a subdomain like <strong>portal</strong>.yourdomain.com.</p>
            </div>
          </div>

          {!isAzureConfigured && (
            <div className="pl-8">
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-300">Azure Configuration Missing</p>
                  <p className="text-xs text-amber-500 mt-1">
                    The backend is not fully configured with Azure credentials. Custom domain binding via ARM API requires <code className="bg-black/30 px-1 py-0.5 rounded text-amber-200">AZURE_SUBSCRIPTION_ID</code>, Tenant, and Client ID in the server `.env`.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Step 2: DNS Records */}
          {domain && domain.length > 3 && isAzureConfigured && (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-2">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-400 text-xs font-bold border border-cyan-500/30">2</span>
                <Label className="text-gray-200 font-semibold text-base">Add DNS Records</Label>
              </div>
              
              <div className="pl-8 space-y-4">
                <p className="text-sm text-gray-400 leading-relaxed">
                  Log in to your domain provider (GoDaddy, Namecheap, Cloudflare) and add the following <strong>two</strong> records to verify ownership and route traffic.
                </p>

                {/* Verification TXT Record */}
                <div className="bg-black/40 border border-white/10 rounded-xl overflow-hidden">
                  <div className="bg-white/5 px-4 py-2 border-b border-white/5 flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-300 uppercase tracking-wider">Record 1: Verification (TXT)</span>
                    <Badge variant="outline" className="border-purple-500/30 text-purple-400 bg-purple-500/10 text-[10px]">Required for SSL</Badge>
                  </div>
                  <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1">Type</p>
                      <p className="text-sm font-mono text-white">TXT</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1">Name / Host</p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono text-cyan-300">asuid.{subdomain}</p>
                        <button onClick={() => copyToClipboard(`asuid.${subdomain}`, 'Host')} className="text-gray-500 hover:text-cyan-400 transition-colors">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1">Value</p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono text-emerald-300 truncate max-w-[200px]" title={dnsConfig?.verificationId}>
                          {dnsConfig?.verificationId}
                        </p>
                        <button onClick={() => copyToClipboard(dnsConfig?.verificationId, 'Verification ID')} className="text-gray-500 hover:text-emerald-400 transition-colors">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Routing CNAME Record */}
                <div className="bg-black/40 border border-white/10 rounded-xl overflow-hidden">
                  <div className="bg-white/5 px-4 py-2 border-b border-white/5 flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-300 uppercase tracking-wider">Record 2: Routing (CNAME)</span>
                    <Badge variant="outline" className="border-blue-500/30 text-blue-400 bg-blue-500/10 text-[10px]">Required for Traffic</Badge>
                  </div>
                  <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1">Type</p>
                      <p className="text-sm font-mono text-white">CNAME</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1">Name / Host</p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono text-cyan-300">{subdomain}</p>
                        <button onClick={() => copyToClipboard(subdomain, 'Host')} className="text-gray-500 hover:text-cyan-400 transition-colors">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1">Value / Target</p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono text-emerald-300">{dnsConfig?.fqdn}</p>
                        <button onClick={() => copyToClipboard(dnsConfig?.fqdn, 'Target URL')} className="text-gray-500 hover:text-emerald-400 transition-colors">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Validation Checkbox */}
                <div className="pt-4 border-t border-white/5">
                  <div className="flex items-start space-x-3 bg-cyan-500/5 p-4 rounded-xl border border-cyan-500/10">
                    <Checkbox 
                      id="dnsConfirm" 
                      checked={dnsConfirmed}
                      onCheckedChange={setDnsConfirmed}
                      className="mt-1 border-gray-500 data-[state=checked]:bg-cyan-500 data-[state=checked]:border-cyan-500"
                    />
                    <div className="grid gap-1.5 leading-none">
                      <label
                        htmlFor="dnsConfirm"
                        className="text-sm font-semibold leading-none text-gray-200 cursor-pointer"
                      >
                        I have added these records to my DNS provider
                      </label>
                      <p className="text-xs text-gray-400">
                        Do not proceed until you have saved these records. DNS propagation can take 5-15 minutes.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Verify Button */}
                <div className="pt-2">
                  <Button
                    onClick={handleSave}
                    disabled={saving || !domain || !dnsConfirmed}
                    className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-500 text-white h-11 px-8 rounded-xl font-bold shadow-lg shadow-cyan-500/20 transition-all"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                        Verifying DNS & Binding...
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="w-5 h-5 mr-2" />
                        Verify and Bind Domain
                      </>
                    )}
                  </Button>
                </div>

              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info Notice */}
      <div className="flex items-start gap-3 p-4 bg-white/5 border border-white/5 rounded-xl text-xs text-gray-400">
        <Info className="w-5 h-5 text-gray-500 shrink-0" />
        <p>
          BolifyAI uses Azure Container Apps to securely host your reseller portal. When you bind a custom domain, we automatically request and manage a free SSL certificate on your behalf.
        </p>
      </div>
    </div>
  );
}

// Ensure ShieldCheck is available if not already
import { ShieldCheck } from 'lucide-react';
function Badge({ children, className, variant }) {
  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${className}`}>{children}</span>;
}
