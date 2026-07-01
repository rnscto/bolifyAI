import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// UniCommerce order/product lookup for AI voice agents during calls
// Similar to shopifyLookup but for UniCommerce API

export default async function unicommerceLookup(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const { client_id, lookup_type, query, test_mode } = await c.req.json();

    if (!client_id || !lookup_type || !query) {
      return c.json({ data: { error: 'Missing client_id, lookup_type, or query' } }, 400);
    }

    const allIntegrations = await base44.asServiceRole.entities.MarketplaceIntegration.filter({
      client_id, platform: 'unicommerce'
    });
    const integrations = test_mode
      ? allIntegrations
      : allIntegrations.filter(i => i.status === 'active');

    if (integrations.length === 0) {
      return c.json({ data: { success: false, error: test_mode
        ? 'No UniCommerce integration found. Please save your credentials first.'
        : 'No active UniCommerce integration found' } });
    }

    const uc = integrations[0];
    const baseUrl = uc.store_url.replace(/\/+$/, '');
    const headers = {
      'Authorization': `Bearer ${uc.api_access_token}`,
      'Content-Type': 'application/json'
    };
    if (uc.config?.facility_code) headers['Facility'] = uc.config.facility_code;

    let result = null;

    if (lookup_type === 'order_by_number') {
      const res = await fetch(`${baseUrl}/services/rest/v1/oms/saleOrder/get`, {
        method: 'POST', headers,
        body: JSON.stringify({ code: query })
      });
      if (!res.ok) return c.json({ data: { success: false, error: `UC API ${res.status}` } });
      const data = await res.json();
      if (data.saleOrder) {
        result = { order: formatUCOrder(data.saleOrder) };
      } else {
        result = { order: null, message: 'Order not found' };
      }
    }

    else if (lookup_type === 'order_by_phone') {
      const res = await fetch(`${baseUrl}/services/rest/v1/oms/saleOrder/search`, {
        method: 'POST', headers,
        body: JSON.stringify({
          searchParameters: { pageNumber: 1, pageSize: 20 }
        })
      });
      if (!res.ok) return c.json({ data: { success: false, error: `UC API ${res.status}` } });
      const data = await res.json();
      const cleanQ = query.replace(/[^0-9]/g, '');
      const orders = (data.saleOrders || data.elements || []).filter(o => {
        const ph = (o.addresses?.[0]?.phone || '').replace(/[^0-9]/g, '');
        return ph.includes(cleanQ) || cleanQ.includes(ph.slice(-10));
      }).map(formatUCOrder);
      result = { orders, count: orders.length };
    }

    else if (lookup_type === 'tracking') {
      const res = await fetch(`${baseUrl}/services/rest/v1/oms/shippingPackage/getShippingPackagesByCode`, {
        method: 'POST', headers,
        body: JSON.stringify({ saleOrderCode: query })
      });
      if (!res.ok) return c.json({ data: { success: false, error: `UC API ${res.status}` } });
      const data = await res.json();
      const packages = (data.shippingPackages || []).map(sp => ({
        package_code: sp.code,
        tracking_number: sp.trackingNumber || '',
        shipping_provider: sp.shippingProvider || '',
        status: sp.status,
        dispatch_date: sp.dispatchDate || ''
      }));
      result = { tracking: packages, count: packages.length };
    }

    else if (lookup_type === 'product_search') {
      const res = await fetch(`${baseUrl}/services/rest/v1/catalog/itemType/search`, {
        method: 'POST', headers,
        body: JSON.stringify({
          searchParameters: { pageNumber: 1, pageSize: 10 },
          name: query
        })
      });
      if (!res.ok) return c.json({ data: { success: false, error: `UC API ${res.status}` } });
      const data = await res.json();
      const products = (data.itemTypes || data.elements || []).map(p => ({
        sku: p.skuCode || p.itemSku || '',
        name: p.name || p.itemName || '',
        mrp: p.mrp || 0,
        available_quantity: p.inventory || 0
      }));
      result = { products, count: products.length };
    }

    else {
      return c.json({ data: { success: false, error: `Unknown lookup_type: ${lookup_type}` } });
    }

    return c.json({ data: { success: true, lookup_type, query, ...result } });

  } catch (error) {
    console.error('[unicommerceLookup] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};

function formatUCOrder(o) {
  return {
    order_code: o.code || o.saleOrderCode || '',
    display_order_code: o.displayOrderCode || o.code || '',
    status: o.status,
    customer_name: o.addresses?.[0]?.name || '',
    customer_phone: o.addresses?.[0]?.phone || '',
    items: (o.saleOrderItems || []).map(i => ({
      name: i.itemName || '', sku: i.itemSku || '',
      quantity: i.qty || 1, price: i.sellingPrice || 0
    })),
    total: o.totalCashOnDeliveryAmount || o.totalAmount || 0,
    payment_mode: o.cashOnDelivery ? 'COD' : 'Prepaid',
    shipping_address: o.addresses?.[0] ? `${o.addresses[0].addressLine1 || ''}, ${o.addresses[0].city || ''} ${o.addresses[0].pincode || ''}` : ''
  };
}