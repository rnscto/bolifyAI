import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function shopifyOAuthExchange(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { store_url, client_id, client_secret, code, integration_id } = await c.req.json();

    if (!store_url || !client_id || !client_secret || !code) {
      return c.json({ data: { error: 'Missing required fields: store_url, client_id, client_secret, code' } }, 400);
    }

    const cleanStore = store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Exchange the authorization code for a permanent access token
    const url = `https://${cleanStore}/admin/oauth/access_token`;
    console.log('Posting to:', url);
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      redirect: 'manual',
      body: JSON.stringify({
        client_id,
        client_secret,
        code
      })
    });

    console.log('Shopify OAuth response status:', res.status);
    console.log('Shopify OAuth response headers:', JSON.stringify(Object.fromEntries(res.headers.entries())));
    
    const rawText = await res.text();
    console.log('Shopify OAuth raw response:', rawText.substring(0, 500));
    
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return c.json({ data: { success: false, error: `Shopify returned non-JSON (status ${res.status}). Response: ${rawText.substring(0, 200)}` } });
    }

    if (!res.ok || !data.access_token) {
      return c.json({ data: {
        success: false,
        error: `Shopify returned ${res.status}: ${JSON.stringify(data)}`
      } });
    }

    // If integration_id provided, update the integration with the new access token
    if (integration_id) {
      await base44.asServiceRole.entities.MarketplaceIntegration.update(integration_id, {
        api_access_token: data.access_token,
        api_key: client_id,
        status: 'inactive',
        error_message: '',
        config: {
          scope: data.scope || '',
          oauth_connected: true
        }
      });
    }

    return c.json({ data: {
      success: true,
      access_token: data.access_token,
      scope: data.scope
    } });

  } catch (error) {
    console.error('shopifyOAuthExchange error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};