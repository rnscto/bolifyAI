import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

// WooCommerce + Amazon SP-API integration added alongside Shopify + UniCommerce

// Syncs orders from connected e-commerce platforms (Shopify, UniCommerce) into EcomOrder entity
// Can be called manually or via scheduled automation

export default async function ecomSyncOrders(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id, platform, limit: syncLimit } = await c.req.json();
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    // Get active integration for this platform (or all)
    const filter = { client_id, status: 'active' };
    if (platform) filter.platform = platform;
    const integrations = await base44.asServiceRole.entities.MarketplaceIntegration.filter(filter);

    if (integrations.length === 0) {
      return c.json({ data: { success: false, error: 'No active integrations found' } });
    }

    let totalSynced = 0;
    let totalSkipped = 0;
    const errors = [];

    for (const integration of integrations) {
      try {
        let orders = [];

        if (integration.platform === 'shopify') {
          orders = await fetchShopifyOrders(integration, syncLimit || 50);
        } else if (integration.platform === 'unicommerce') {
          orders = await fetchUniCommerceOrders(integration, syncLimit || 50);
        } else if (integration.platform === 'woocommerce') {
          orders = await fetchWooCommerceOrders(integration, syncLimit || 50);
        } else if (integration.platform === 'amazon') {
          orders = await fetchAmazonOrders(integration, syncLimit || 20);
        } else {
          continue;
        }

        // Upsert orders into EcomOrder entity
        for (const order of orders) {
          // Check if order already exists
          const existing = await base44.asServiceRole.entities.EcomOrder.filter({
            client_id,
            platform: integration.platform,
            external_order_id: order.external_order_id
          });

          if (existing.length > 0) {
            // Update existing order
            await base44.asServiceRole.entities.EcomOrder.update(existing[0].id, order);
            totalSkipped++;
          } else {
            // Create new order
            await base44.asServiceRole.entities.EcomOrder.create({
              ...order,
              client_id,
              integration_id: integration.id,
              platform: integration.platform
            });
            totalSynced++;
          }
        }

        // Update last sync date
        await base44.asServiceRole.entities.MarketplaceIntegration.update(integration.id, {
          last_sync_date: new Date().toISOString()
        });

      } catch (e) {
        errors.push({ platform: integration.platform, error: e.message });
        console.error(`[ecomSync] ${integration.platform} error:`, e.message);
      }
    }

    return c.json({ data: {
      success: true,
      synced: totalSynced,
      updated: totalSkipped,
      errors
    } });

  } catch (error) {
    console.error('[ecomSyncOrders] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};

// ─── Shopify Order Fetch ───
async function fetchShopifyOrders(integration, limit) {
  const storeUrl = integration.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const apiVersion = integration.api_version || '2024-01';
  const baseUrl = `https://${storeUrl}/admin/api/${apiVersion}`;
  const headers = { 'X-Shopify-Access-Token': integration.api_access_token, 'Content-Type': 'application/json' };

  const res = await fetch(`${baseUrl}/orders.json?status=any&limit=${limit}&order=created_at+desc`, { headers });
  if (!res.ok) throw new Error(`Shopify API ${res.status}`);
  const data = await res.json();

  return (data.orders || []).map(o => ({
    external_order_id: String(o.id),
    order_number: o.name || `#${o.order_number}`,
    customer_name: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : '',
    customer_phone: o.customer?.phone || o.phone || '',
    customer_email: o.customer?.email || o.email || '',
    items: (o.line_items || []).map(li => ({
      title: li.title, sku: li.sku, quantity: li.quantity,
      price: parseFloat(li.price), variant: li.variant_title
    })),
    total_amount: parseFloat(o.total_price),
    currency: o.currency || 'INR',
    order_status: o.cancelled_at ? 'cancelled' : mapShopifyStatus(o.fulfillment_status),
    fulfillment_status: o.fulfillment_status || 'unfulfilled',
    payment_status: mapShopifyPayment(o.financial_status),
    shipping_address: o.shipping_address ? `${o.shipping_address.address1 || ''}, ${o.shipping_address.city || ''}, ${o.shipping_address.province || ''} ${o.shipping_address.zip || ''}`.trim() : '',
    tracking_number: o.fulfillments?.[0]?.tracking_number || '',
    tracking_company: o.fulfillments?.[0]?.tracking_company || '',
    tracking_url: o.fulfillments?.[0]?.tracking_url || '',
    order_date: o.created_at,
    shipped_date: o.fulfillments?.[0]?.created_at || '',
    delivered_date: ''
  }));
}

function mapShopifyStatus(fs) {
  if (!fs || fs === 'null') return 'confirmed';
  if (fs === 'fulfilled') return 'delivered';
  if (fs === 'partial') return 'processing';
  return 'confirmed';
}

function mapShopifyPayment(ps) {
  if (ps === 'paid') return 'paid';
  if (ps === 'refunded' || ps === 'partially_refunded') return 'refunded';
  if (ps === 'voided') return 'failed';
  return 'pending';
}

// ─── UniCommerce Order Fetch ───
async function fetchUniCommerceOrders(integration, limit) {
  const baseUrl = integration.store_url.replace(/\/+$/, '');
  const token = integration.api_access_token;

  // UniCommerce uses POST for search endpoints
  const res = await fetch(`${baseUrl}/services/rest/v1/oms/saleOrder/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Facility': integration.config?.facility_code || ''
    },
    body: JSON.stringify({
      searchParameters: { pageNumber: 1, pageSize: limit },
      sortBy: 'created_desc'
    })
  });

  if (!res.ok) throw new Error(`UniCommerce API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const saleOrders = data.saleOrders || data.elements || [];

  return saleOrders.map(o => ({
    external_order_id: o.code || o.saleOrderCode || String(o.id),
    order_number: o.displayOrderCode || o.code || '',
    customer_name: o.addresses?.[0]?.name || '',
    customer_phone: o.addresses?.[0]?.phone || '',
    customer_email: o.addresses?.[0]?.email || '',
    items: (o.saleOrderItems || []).map(i => ({
      title: i.itemName || i.channelProductId || '',
      sku: i.itemSku || '',
      quantity: i.qty || 1,
      price: i.sellingPrice || 0,
      variant: i.channelProductId || ''
    })),
    total_amount: o.totalCashOnDeliveryAmount || o.totalAmount || 0,
    currency: o.currencyCode || 'INR',
    order_status: mapUniCommerceStatus(o.status),
    fulfillment_status: o.status === 'DISPATCHED' || o.status === 'DELIVERED' ? 'fulfilled' : 'unfulfilled',
    payment_status: o.cashOnDelivery ? 'cod' : 'paid',
    shipping_address: o.addresses?.[0] ? `${o.addresses[0].addressLine1 || ''}, ${o.addresses[0].city || ''}, ${o.addresses[0].state || ''} ${o.addresses[0].pincode || ''}` : '',
    tracking_number: o.shippingPackages?.[0]?.trackingNumber || '',
    tracking_company: o.shippingPackages?.[0]?.shippingProvider || '',
    tracking_url: '',
    order_date: o.created || o.displayOrderDateTime || '',
    shipped_date: o.dispatchDate || '',
    delivered_date: o.deliveryDate || ''
  }));
}

function mapUniCommerceStatus(s) {
  const map = {
    'CREATED': 'pending', 'CONFIRMED': 'confirmed', 'PROCESSING': 'processing',
    'PACKED': 'processing', 'READY_TO_DISPATCH': 'processing', 'DISPATCHED': 'shipped',
    'DELIVERED': 'delivered', 'CANCELLED': 'cancelled', 'RETURNED': 'returned'
  };
  return map[s] || 'pending';
}

// ─── WooCommerce Order Fetch ───
async function fetchWooCommerceOrders(integration, limit) {
  const baseUrl = integration.store_url.replace(/\/+$/, '');
  const ck = integration.api_key;
  const cs = integration.api_access_token;
  const auth = btoa(`${ck}:${cs}`);
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };

  const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders?per_page=${limit}&orderby=date&order=desc`, { headers });
  if (!res.ok) throw new Error(`WooCommerce API ${res.status}`);
  const orders = await res.json();

  return orders.map(o => ({
    external_order_id: String(o.id),
    order_number: `#${o.number || o.id}`,
    customer_name: `${o.billing?.first_name || ''} ${o.billing?.last_name || ''}`.trim(),
    customer_phone: o.billing?.phone || '',
    customer_email: o.billing?.email || '',
    items: (o.line_items || []).map(li => ({
      title: li.name, sku: li.sku || '', quantity: li.quantity,
      price: parseFloat(li.total || 0), variant: ''
    })),
    total_amount: parseFloat(o.total || 0),
    currency: o.currency || 'INR',
    order_status: mapWooStatus(o.status),
    fulfillment_status: o.status === 'completed' ? 'fulfilled' : 'unfulfilled',
    payment_status: o.date_paid ? 'paid' : (o.payment_method === 'cod' ? 'cod' : 'pending'),
    shipping_address: o.shipping ? `${o.shipping.address_1 || ''}, ${o.shipping.city || ''}, ${o.shipping.state || ''} ${o.shipping.postcode || ''}` : '',
    tracking_number: '',
    tracking_company: '',
    tracking_url: '',
    order_date: o.date_created,
    shipped_date: '',
    delivered_date: ''
  }));
}

function mapWooStatus(s) {
  const map = { 'pending': 'pending', 'processing': 'processing', 'on-hold': 'confirmed',
    'completed': 'delivered', 'cancelled': 'cancelled', 'refunded': 'refunded', 'failed': 'cancelled' };
  return map[s] || 'pending';
}

// ─── Amazon SP-API Order Fetch ───
async function fetchAmazonOrders(integration, limit) {
  const config = integration.config || {};
  const clientIdLWA = integration.api_key;
  const clientSecretLWA = config.client_secret;
  const refreshToken = integration.api_access_token;
  const marketplaceId = config.marketplace_id || 'A21TJRUUN4KGV';

  // Get access token
  const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: clientIdLWA, client_secret: clientSecretLWA,
    })
  });
  if (!tokenRes.ok) throw new Error(`Amazon LWA token error: ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();

  const spEndpoint = marketplaceId === 'ATVPDKIKX0DER' ? 'https://sellingpartnerapi-na.amazon.com'
    : marketplaceId === 'A1F83G8C2ARO7P' ? 'https://sellingpartnerapi-eu.amazon.com'
    : 'https://sellingpartnerapi-fe.amazon.com';

  const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `${spEndpoint}/orders/v0/orders?MarketplaceIds=${marketplaceId}&CreatedAfter=${encodeURIComponent(createdAfter)}&MaxResultsPerPage=${limit}`,
    { headers: { 'x-amz-access-token': access_token, 'Content-Type': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Amazon SP-API ${res.status}`);
  const data = await res.json();

  return (data.payload?.Orders || []).map(o => ({
    external_order_id: o.AmazonOrderId,
    order_number: o.AmazonOrderId,
    customer_name: o.BuyerInfo?.BuyerName || '',
    customer_phone: '',
    customer_email: o.BuyerInfo?.BuyerEmail || '',
    items: [],
    total_amount: parseFloat(o.OrderTotal?.Amount || 0),
    currency: o.OrderTotal?.CurrencyCode || 'INR',
    order_status: mapAmazonStatus(o.OrderStatus),
    fulfillment_status: o.OrderStatus === 'Shipped' ? 'fulfilled' : 'unfulfilled',
    payment_status: 'paid',
    shipping_address: '',
    tracking_number: '',
    tracking_company: '',
    tracking_url: '',
    order_date: o.PurchaseDate,
    shipped_date: '',
    delivered_date: ''
  }));
}

function mapAmazonStatus(s) {
  const map = { 'Pending': 'pending', 'Unshipped': 'confirmed', 'PartiallyShipped': 'processing',
    'Shipped': 'shipped', 'Canceled': 'cancelled', 'Unfulfillable': 'cancelled' };
  return map[s] || 'pending';
}