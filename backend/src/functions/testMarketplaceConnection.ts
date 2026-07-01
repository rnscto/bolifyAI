import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Tests marketplace connection by making a simple API call to the platform
// Used by integration setup UI to verify credentials before marking as active

export default async function testMarketplaceConnection(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { integration_id } = await c.req.json();
    if (!integration_id) return c.json({ data: { error: 'integration_id required' } }, 400);

    const integration = await base44.asServiceRole.entities.MarketplaceIntegration.get(integration_id);
    if (!integration) return c.json({ data: { success: false, error: 'Integration not found' } });

    const platform = integration.platform;

    if (platform === 'shopify') {
      const storeUrl = integration.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const apiVersion = integration.api_version || '2024-01';
      const res = await fetch(`https://${storeUrl}/admin/api/${apiVersion}/shop.json`, {
        headers: { 'X-Shopify-Access-Token': integration.api_access_token }
      });
      if (res.ok) {
        const data = await res.json();
        return c.json({ data: { success: true, store_name: data.shop?.name || storeUrl } });
      }
      return c.json({ data: { success: false, error: `Shopify API returned ${res.status}. Check your store URL and access token.` } });
    }

    if (platform === 'unicommerce') {
      const baseUrl = integration.store_url.replace(/\/+$/, '');
      const headers = {
        'Authorization': `Bearer ${integration.api_access_token}`,
        'Content-Type': 'application/json'
      };
      if (integration.config?.facility_code) headers['Facility'] = integration.config.facility_code;
      const res = await fetch(`${baseUrl}/services/rest/v1/catalog/itemType/search`, {
        method: 'POST', headers,
        body: JSON.stringify({ searchParameters: { pageNumber: 1, pageSize: 1 } })
      });
      if (res.ok) {
        return c.json({ data: { success: true } });
      }
      return c.json({ data: { success: false, error: `UniCommerce API returned ${res.status}. Check your URL and token.` } });
    }

    if (platform === 'woocommerce') {
      const baseUrl = integration.store_url.replace(/\/+$/, '');
      const auth = btoa(`${integration.api_key}:${integration.api_access_token}`);
      const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders?per_page=1`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        return c.json({ data: { success: true } });
      }
      const errText = await res.text().catch(() => '');
      return c.json({ data: { success: false, error: `WooCommerce API returned ${res.status}. ${errText.slice(0, 150)}` } });
    }

    if (platform === 'amazon') {
      const config = integration.config || {};
      const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: integration.api_access_token,
          client_id: integration.api_key,
          client_secret: config.client_secret || integration.webhook_secret || '',
        })
      });
      if (tokenRes.ok) {
        return c.json({ data: { success: true } });
      }
      return c.json({ data: { success: false, error: `Amazon LWA token error: ${tokenRes.status}. Check credentials.` } });
    }

    return c.json({ data: { success: false, error: `Unsupported platform: ${platform}` } });

  } catch (error) {
    console.error('[testMarketplaceConnection] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};