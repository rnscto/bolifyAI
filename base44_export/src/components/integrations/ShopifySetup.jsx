import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShoppingBag, CheckCircle2, XCircle, Loader2, Eye, EyeOff, TestTube2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

export default function ShopifySetup({ clientId }) {
  const [integration, setIntegration] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [storeUrl, setStoreUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [apiVersion, setApiVersion] = useState('2024-01');

  useEffect(() => { loadIntegration(); }, [clientId]);

  const loadIntegration = async () => {
    if (!clientId) return;
    const results = await base44.entities.MarketplaceIntegration.filter({
      client_id: clientId,
      platform: 'shopify'
    });
    if (results.length > 0) {
      const i = results[0];
      setIntegration(i);
      setStoreUrl(i.store_url || '');
      setAccessToken(i.api_access_token || '');
      setApiVersion(i.api_version || '2024-01');
    }
    setLoading(false);
  };

  const handleSave = async () => {
    if (!storeUrl || !accessToken) {
      toast.error('Store URL and Access Token are required');
      return;
    }
    setSaving(true);
    const data = {
      client_id: clientId,
      platform: 'shopify',
      store_url: storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      api_access_token: accessToken,
      api_version: apiVersion,
      status: 'inactive',
      capabilities: ['order_lookup', 'product_search', 'customer_lookup', 'refund_status']
    };

    if (integration) {
      await base44.entities.MarketplaceIntegration.update(integration.id, data);
      setIntegration({ ...integration, ...data });
    } else {
      const created = await base44.entities.MarketplaceIntegration.create(data);
      setIntegration(created);
    }
    toast.success('Shopify integration saved');
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true);
    const cleanUrl = storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const testUrl = `https://${cleanUrl}/admin/api/${apiVersion}/shop.json`;

    const res = await base44.functions.invoke('shopifyLookup', {
      client_id: clientId,
      lookup_type: 'product_search',
      query: 'test'
    });

    if (res.data?.success) {
      toast.success('Shopify connection successful!');
      if (integration) {
        await base44.entities.MarketplaceIntegration.update(integration.id, {
          status: 'active',
          last_tested: new Date().toISOString(),
          error_message: ''
        });
        setIntegration({ ...integration, status: 'active', last_tested: new Date().toISOString() });
      }
    } else {
      toast.error(res.data?.error || 'Connection failed. Check your store URL and token.');
      if (integration) {
        await base44.entities.MarketplaceIntegration.update(integration.id, {
          status: 'error',
          error_message: res.data?.error || 'Test failed'
        });
        setIntegration({ ...integration, status: 'error' });
      }
    }
    setTesting(false);
  };

  const handleDelete = async () => {
    if (!integration) return;
    await base44.entities.MarketplaceIntegration.delete(integration.id);
    setIntegration(null);
    setStoreUrl('');
    setAccessToken('');
    toast.success('Shopify integration removed');
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </CardContent>
      </Card>
    );
  }

  const statusBadge = integration?.status === 'active'
    ? <Badge className="bg-green-100 text-green-800"><CheckCircle2 className="w-3 h-3 mr-1" /> Connected</Badge>
    : integration?.status === 'error'
    ? <Badge className="bg-red-100 text-red-800"><XCircle className="w-3 h-3 mr-1" /> Error</Badge>
    : <Badge className="bg-gray-100 text-gray-600">Not Connected</Badge>;

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShoppingBag className="w-5 h-5 text-green-600" /> Shopify Store
          </CardTitle>
          {statusBadge}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Connect your Shopify store so AI agents can look up orders, products, and tracking in real-time during calls.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label>Store URL</Label>
          <Input
            value={storeUrl}
            onChange={e => setStoreUrl(e.target.value)}
            placeholder="mystore.myshopify.com"
          />
          <p className="text-xs text-gray-400 mt-1">Just the domain, no https:// needed</p>
        </div>

        <div>
          <Label>Admin API Access Token</Label>
          <div className="relative">
            <Input
              type={showToken ? 'text' : 'password'}
              value={accessToken}
              onChange={e => setAccessToken(e.target.value)}
              placeholder="shpat_xxxxxxxxxxxxx"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Create a Custom App in Shopify Admin → Settings → Apps → Develop apps. Grant read access to Orders, Customers, and Products.
          </p>
        </div>

        <div>
          <Label>API Version</Label>
          <Input
            value={apiVersion}
            onChange={e => setApiVersion(e.target.value)}
            placeholder="2024-01"
          />
        </div>

        {integration?.error_message && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {integration.error_message}
          </div>
        )}

        {integration?.last_tested && (
          <p className="text-xs text-gray-400">
            Last tested: {new Date(integration.last_tested).toLocaleString()}
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <Button onClick={handleSave} disabled={saving || !storeUrl || !accessToken} className="flex-1 gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {integration ? 'Update' : 'Save'}
          </Button>
          {integration && (
            <>
              <Button variant="outline" onClick={handleTest} disabled={testing} className="gap-2">
                {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube2 className="w-4 h-4" />}
                Test
              </Button>
              <Button variant="ghost" onClick={handleDelete} className="text-red-500 hover:text-red-700 hover:bg-red-50">
                <Trash2 className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}