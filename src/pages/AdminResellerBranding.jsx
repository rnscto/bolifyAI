import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Globe, Loader2, CheckCircle2, Info, Copy, ExternalLink, AlertTriangle, ShieldCheck, Clock } from 'lucide-react';
import { toast } from 'sonner';

function Badge({ children, className }) {
  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${className}`}>{children}</span>;
}

export default function AdminResellerBranding() {
  const [domain, setDomain] = useState('');
  const [currentDomain, setCurrentDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [dnsConfig, setDnsConfig] = useState(null);
  const [dnsConfirmed, setDnsConfirmed] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      try {
        const res = await apiFetch('/reseller/custom-domain');
        if (res && res.custom_domain) {
          setDomain(res.custom_domain);
          setCurrentDomain(res.custom_domain);
          if (res.ssl_status === 'provisioning') setProvisioning(true);
        }
      } catch (e) {
        console.warn('Failed to load current domain binding:', e);
      }

      const configRes = await apiFetch('/reseller/custom-domain-config');
      if (configRes) {
        setDnsConfig({
          success: configRes.success,
          verificationId: configRes.verificationId,
          fqdn: configRes.fqdn,
          error: configRes.error
        });
      }
    } catch (e) {
      console.error('Failed to load custom domain data:', e);
      setDnsConfig({
        success: false,
        verificationId: 'AZURE_NOT_CONFIGURED',
        error: e.message || 'Failed to connect to server'
      });
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text, type) => {
    navigator.clipboard.writeText(text);
    toast.success(`${type} copied!`);
  };

  const handleSave = async () => {
    if (!domain.includes('.')) {
      toast.error('Please enter a valid domain (e.g. portal.myagency.com)');
      return;
    }
    if (!dnsConfirmed) {
      toast.error('Please confirm you have added the DNS records before verifying.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/reseller/custom-domain', {
        method: 'POST',
        body: JSON.stringify({ custom_domain: domain })
      });
      if (res.error) throw new Error(res.error);
      setCurrentDomain(domain);
      setProvisioning(true);
      toast.success('Domain saved! SSL is provisioning in the background (5–15 min).');
    } catch (e) {
      toast.error(e.message || 'Failed to bind custom domain.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm('Are you sure you want to remove this domain? The platform will no longer load at this URL.')) return;
    try {
      const res = await apiFetch('/reseller/custom-domain', {
        method: 'DELETE'
      });
      if (res.error) throw new Error(res.error);
      setCurrentDomain('');
      setDomain('');
      setProvisioning(false);
      toast.success('Domain removed successfully');
    } catch (e) {
      toast.error(e.message || 'Failed to remove domain');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-700" />
      </div>
    );
  }

  // Detect if root domain (e.g. cuberootcoin.com) vs subdomain (e.g. portal.cuberootcoin.com)
  const domainParts = domain ? domain.replace(/^https?:\/\//, '').split('.').filter(Boolean) : [];
  const isRootDomain = domainParts.length === 2;
  const isSubdomain = domainParts.length >= 3;
  const subdomain = isSubdomain ? domainParts[0] : '@';

  // Azure requires: TXT asuid.<subdomain> for subdomains, TXT asuid for root
  const txtHost = isSubdomain ? `asuid.${subdomain}` : 'asuid';
  // CNAME host: subdomain label only (not @). Root domains cannot use CNAME at @.
  const cnameHost = isSubdomain ? subdomain : '@';

  const isAzureConfigured = dnsConfig && dnsConfig.verificationId !== 'AZURE_NOT_CONFIGURED';
  const showDns = domain && domain.length > 3 && isAzureConfigured;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Globe className="w-6 h-6 text-blue-700" />
          Custom Domain
        </h1>
        <p className="text-gray-500 mt-1">Configure your white-labeled reseller platform domain.</p>
      </div>

      {/* Current domain status */}
      {currentDomain && (
        <div className={`flex items-center justify-between px-5 py-4 rounded-xl border shadow-lg ${
          provisioning ? 'bg-amber-50 border-amber-100' : 'bg-green-50 border-green-100'
        }`}>
          <div className="flex items-center gap-3">
            {provisioning
              ? <Clock className="w-6 h-6 text-amber-600 shrink-0" />
              : <CheckCircle2 className="w-6 h-6 text-green-700 shrink-0" />
            }
            <div>
              <p className={`text-sm font-semibold ${provisioning ? 'text-amber-600' : 'text-green-700'}`}>
                {provisioning ? 'SSL Provisioning in Background…' : 'Active Domain Bound'}
              </p>
              <a
                href={`https://${currentDomain}`}
                target="_blank" rel="noreferrer"
                className="text-base font-bold hover:underline flex items-center gap-1.5 mt-0.5 text-gray-800"
              >
                {currentDomain} <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge className={provisioning ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}>
              {provisioning ? 'Provisioning' : 'Verified'}
            </Badge>
            <button
              onClick={handleRemove}
              className="px-3 py-1.5 text-sm font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors border border-red-200"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      <Card className="border border-slate-200 bg-white shadow-xl">
        <CardHeader className="border-b border-slate-100 pb-4">
          <CardTitle className="text-lg text-gray-800 font-bold">Connect a custom domain</CardTitle>
          <CardDescription className="text-gray-500">
            Securely map your domain to our cloud infrastructure. We automatically provision a free SSL certificate.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-8 pt-6">
          {/* Step 1: Enter domain */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold border border-cyan-500/30">1</span>
              <Label className="text-gray-900 font-semibold text-base">Enter the domain you want to use</Label>
            </div>
            <div className="pl-8 space-y-2">
              <Input
                placeholder="e.g. portal.youragency.com"
                value={domain}
                onChange={(e) => {
                  setDomain(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ''));
                  setDnsConfirmed(false);
                }}
                className="max-w-md border-slate-200 text-gray-900 placeholder:text-gray-400 focus:border-cyan-500 h-11"
              />

              {/* Root domain warning — GoDaddy can't CNAME at @ */}
              {isRootDomain && (
                <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-lg p-3 max-w-md">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-bold text-amber-700">Root domain detected — CNAME not supported at @</p>
                    <p className="text-xs text-amber-600 mt-1">
                      GoDaddy and most registrars <strong>do not allow a CNAME record on the root (@)</strong> by DNS standard.
                      We strongly recommend using a subdomain. Click below to auto-fill:
                    </p>
                    <button
                      className="mt-1.5 text-xs font-bold text-blue-600 hover:underline font-mono"
                      onClick={() => { setDomain(`portal.${domain}`); setDnsConfirmed(false); }}
                    >
                      → Use portal.{domain} instead
                    </button>
                  </div>
                </div>
              )}

              {!isRootDomain && (
                <p className="text-xs text-gray-400">Use a subdomain like <strong>portal</strong>.yourdomain.com for best compatibility.</p>
              )}
            </div>
          </div>

          {!isAzureConfigured && (
            <div className="pl-8">
              <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-600">Azure Configuration Error</p>
                  <p className="text-xs text-amber-500 mt-1">{dnsConfig?.error || 'The backend is not configured with Azure credentials.'}</p>
                </div>
              </div>
            </div>
          )}

          {/* Step 2: DNS Records */}
          {showDns && (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-2">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold border border-cyan-500/30">2</span>
                <Label className="text-gray-900 font-semibold text-base">Add DNS Records at your registrar</Label>
              </div>

              <div className="pl-8 space-y-4">
                <p className="text-sm text-gray-500">
                  Log in to GoDaddy / Namecheap / Cloudflare and add <strong>both</strong> of these records.
                </p>

                {/* TXT Verification Record */}
                <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-white px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-600 uppercase tracking-wider">Record 1 — Ownership Verification (TXT)</span>
                    <Badge className="bg-purple-50 text-purple-700 text-[10px]">Required for SSL</Badge>
                  </div>
                  <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Type</p>
                      <p className="text-sm font-mono font-bold text-gray-900">TXT</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Name / Host</p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono text-blue-600 font-bold">{txtHost}</p>
                        <button onClick={() => copyToClipboard(txtHost, 'TXT Host')} className="text-gray-400 hover:text-blue-600 transition-colors">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-[10px] text-gray-400 mt-1">
                        {isRootDomain
                          ? 'GoDaddy: type "asuid" exactly (not @ not blank)'
                          : `Type exactly: ${txtHost}`}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Value</p>
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-mono text-emerald-600 truncate max-w-[200px]" title={dnsConfig?.verificationId}>
                          {dnsConfig?.verificationId}
                        </p>
                        <button onClick={() => copyToClipboard(dnsConfig?.verificationId, 'Verification ID')} className="text-gray-400 hover:text-green-600 transition-colors shrink-0">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* CNAME or A Record */}
                <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-white px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-600 uppercase tracking-wider">
                      Record 2 — Traffic Routing ({isRootDomain ? 'A Record' : 'CNAME'})
                    </span>
                    <Badge className="bg-blue-50 text-blue-700 text-[10px]">Required for Traffic</Badge>
                  </div>
                  <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Type</p>
                      <p className="text-sm font-mono font-bold text-gray-900">{isRootDomain ? 'A' : 'CNAME'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Name / Host</p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono text-blue-600 font-bold">{cnameHost}</p>
                        <button onClick={() => copyToClipboard(cnameHost, 'Host')} className="text-gray-400 hover:text-blue-600 transition-colors">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 uppercase font-semibold mb-1">Value / Target</p>
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-mono text-emerald-600 truncate max-w-[200px]" title={isRootDomain ? '52.140.84.241' : dnsConfig?.fqdn}>
                          {isRootDomain ? '52.140.84.241' : dnsConfig?.fqdn}
                        </p>
                        <button onClick={() => copyToClipboard(isRootDomain ? '52.140.84.241' : dnsConfig?.fqdn, 'Target')} className="text-gray-400 hover:text-green-600 transition-colors shrink-0">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* GoDaddy step-by-step for root domains */}
                {isRootDomain && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                    <p className="text-xs font-bold text-blue-800 flex items-center gap-1.5 mb-2">
                      <Info className="w-4 h-4" /> GoDaddy Setup for Root Domain ({domain})
                    </p>
                    <ol className="text-xs text-blue-700 space-y-1.5 list-decimal pl-4">
                      <li>
                        Go to <strong>GoDaddy DNS Management</strong> → Add TXT record:
                        host = <code className="bg-blue-100 px-1 py-0.5 rounded font-mono">asuid</code>, value = the verification ID above.
                      </li>
                      <li>
                        Add an <strong>A Record</strong> (not CNAME):
                        host = <code className="bg-blue-100 px-1 rounded font-mono">@</code>, 
                        value = <code className="bg-blue-100 px-1 rounded font-mono break-all">52.140.84.241</code>.
                      </li>
                      <li>
                        Or{' '}
                        <button
                          className="font-bold underline text-blue-800"
                          onClick={() => { setDomain(`portal.${domain}`); setDnsConfirmed(false); }}
                        >
                          switch to portal.{domain}
                        </button>
                        {' '}— subdomains support standard CNAME and work perfectly with Azure.
                      </li>
                    </ol>
                  </div>
                )}

                {/* Confirmation checkbox */}
                <div className="pt-4 border-t border-slate-100">
                  <div className="flex items-start space-x-3 bg-cyan-50 p-4 rounded-xl border border-cyan-100">
                    <Checkbox
                      id="dnsConfirm"
                      checked={dnsConfirmed}
                      onCheckedChange={setDnsConfirmed}
                      className="mt-1 border-gray-400 data-[state=checked]:bg-cyan-500 data-[state=checked]:border-cyan-500"
                    />
                    <div className="grid gap-1.5 leading-none">
                      <label htmlFor="dnsConfirm" className="text-sm font-semibold leading-none text-gray-900 cursor-pointer">
                        I have added these records to my DNS provider
                      </label>
                      <p className="text-xs text-gray-500">
                        DNS propagation takes 5–15 minutes. SSL certificate provisioning runs automatically in the background after you submit.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Submit button */}
                <div className="pt-2">
                  <Button
                    onClick={handleSave}
                    disabled={saving || !domain || !dnsConfirmed}
                    className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-500 text-white h-11 px-8 rounded-xl font-bold shadow-lg shadow-cyan-500/20 transition-all"
                  >
                    {saving ? (
                      <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Saving Domain…</>
                    ) : (
                      <><ShieldCheck className="w-5 h-5 mr-2" />Save &amp; Verify Domain</>
                    )}
                  </Button>
                  <p className="text-xs text-gray-400 mt-2">
                    Domain is saved instantly. DNS verification and SSL run in the background — no page timeout.
                  </p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-3 p-4 bg-white border border-slate-100 rounded-xl text-xs text-gray-500">
        <Info className="w-5 h-5 text-gray-400 shrink-0" />
        <p>
          BolifyAI uses Azure Container Apps to securely host your reseller portal.
          When you bind a custom domain, we automatically request and manage a free SSL certificate.
        </p>
      </div>
    </div>
  );
}
