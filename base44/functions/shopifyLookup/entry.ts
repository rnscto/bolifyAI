import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const { client_id, lookup_type, query } = await req.json();

    if (!client_id || !lookup_type || !query) {
      return Response.json({ error: 'Missing client_id, lookup_type, or query' }, { status: 400 });
    }

    // Fetch client's marketplace integration
    const integrations = await base44.asServiceRole.entities.MarketplaceIntegration.filter({
      client_id,
      platform: 'shopify',
      status: 'active'
    });

    if (integrations.length === 0) {
      return Response.json({
        success: false,
        error: 'No active Shopify integration found for this client'
      });
    }

    const shop = integrations[0];
    const storeUrl = shop.store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const apiVersion = shop.api_version || '2024-01';
    const baseUrl = `https://${storeUrl}/admin/api/${apiVersion}`;
    const headers = {
      'X-Shopify-Access-Token': shop.api_access_token,
      'Content-Type': 'application/json'
    };

    let result = null;

    // ─── Order by order number (e.g. #1234) ───
    if (lookup_type === 'order_by_number') {
      const orderName = query.startsWith('#') ? query : `#${query}`;
      const res = await fetch(`${baseUrl}/orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=5`, { headers });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`Shopify API error: ${res.status} ${errText}`);
        return Response.json({ success: false, error: `Shopify API error: ${res.status}` });
      }
      const data = await res.json();
      const orders = (data.orders || []).map(formatOrder);
      result = { orders, count: orders.length };
    }

    // ─── Orders by customer phone ───
    else if (lookup_type === 'order_by_phone') {
      const cleanPhone = query.replace(/[^0-9+]/g, '');
      const res = await fetch(`${baseUrl}/orders.json?status=any&limit=10`, { headers });
      if (!res.ok) {
        return Response.json({ success: false, error: `Shopify API error: ${res.status}` });
      }
      const data = await res.json();
      // Filter by phone (Shopify doesn't support phone filter directly on orders)
      const phoneOrders = (data.orders || []).filter(o => {
        const custPhone = (o.customer?.phone || o.phone || o.billing_address?.phone || '').replace(/[^0-9]/g, '');
        const searchPhone = cleanPhone.replace(/[^0-9]/g, '');
        return custPhone.includes(searchPhone) || searchPhone.includes(custPhone);
      }).map(formatOrder);
      result = { orders: phoneOrders, count: phoneOrders.length };
    }

    // ─── Orders by customer email ───
    else if (lookup_type === 'order_by_email') {
      // First find the customer
      const custRes = await fetch(`${baseUrl}/customers/search.json?query=email:${encodeURIComponent(query)}&limit=1`, { headers });
      if (!custRes.ok) {
        return Response.json({ success: false, error: `Shopify customer search error: ${custRes.status}` });
      }
      const custData = await custRes.json();
      if (custData.customers && custData.customers.length > 0) {
        const customerId = custData.customers[0].id;
        const ordRes = await fetch(`${baseUrl}/customers/${customerId}/orders.json?status=any&limit=10`, { headers });
        const ordData = await ordRes.json();
        const orders = (ordData.orders || []).map(formatOrder);
        result = {
          customer: {
            name: `${custData.customers[0].first_name || ''} ${custData.customers[0].last_name || ''}`.trim(),
            email: custData.customers[0].email,
            orders_count: custData.customers[0].orders_count
          },
          orders,
          count: orders.length
        };
      } else {
        result = { customer: null, orders: [], count: 0 };
      }
    }

    // ─── Product availability ───
    else if (lookup_type === 'product_search') {
      const res = await fetch(`${baseUrl}/products.json?title=${encodeURIComponent(query)}&limit=5`, { headers });
      if (!res.ok) {
        return Response.json({ success: false, error: `Shopify product search error: ${res.status}` });
      }
      const data = await res.json();
      const products = (data.products || []).map(p => ({
        id: p.id,
        title: p.title,
        status: p.status,
        variants: (p.variants || []).map(v => ({
          title: v.title,
          price: v.price,
          inventory_quantity: v.inventory_quantity,
          sku: v.sku,
          available: (v.inventory_quantity || 0) > 0
        })),
        total_inventory: (p.variants || []).reduce((sum, v) => sum + (v.inventory_quantity || 0), 0),
        available: (p.variants || []).some(v => (v.inventory_quantity || 0) > 0)
      }));
      result = { products, count: products.length };
    }

    // ─── Refund status for an order ───
    else if (lookup_type === 'refund_status') {
      // query is the order ID
      const res = await fetch(`${baseUrl}/orders/${query}/refunds.json`, { headers });
      if (!res.ok) {
        return Response.json({ success: false, error: `Shopify refund lookup error: ${res.status}` });
      }
      const data = await res.json();
      const refunds = (data.refunds || []).map(r => ({
        id: r.id,
        created_at: r.created_at,
        note: r.note,
        total_amount: r.transactions?.reduce((s, t) => s + parseFloat(t.amount || 0), 0) || 0,
        currency: r.currency,
        refund_line_items: (r.refund_line_items || []).map(li => ({
          quantity: li.quantity,
          title: li.line_item?.title
        }))
      }));
      result = { refunds, count: refunds.length };
    }

    // ─── Shipping/tracking for an order ───
    else if (lookup_type === 'tracking') {
      const res = await fetch(`${baseUrl}/orders/${query}/fulfillments.json`, { headers });
      if (!res.ok) {
        return Response.json({ success: false, error: `Shopify fulfillment lookup error: ${res.status}` });
      }
      const data = await res.json();
      const fulfillments = (data.fulfillments || []).map(f => ({
        id: f.id,
        status: f.status,
        tracking_number: f.tracking_number,
        tracking_url: f.tracking_url,
        tracking_company: f.tracking_company,
        created_at: f.created_at,
        updated_at: f.updated_at,
        shipment_status: f.shipment_status
      }));
      result = { fulfillments, count: fulfillments.length };
    }

    else {
      return Response.json({ success: false, error: `Unknown lookup_type: ${lookup_type}` });
    }

    return Response.json({ success: true, lookup_type, query, ...result });

  } catch (error) {
    console.error('shopifyLookup error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// ─── Format a Shopify order into a concise readable object ───
function formatOrder(order) {
  const fulfillmentStatus = order.fulfillment_status || 'unfulfilled';
  const financialStatus = order.financial_status || 'pending';

  // Get tracking info from fulfillments
  const trackingInfo = (order.fulfillments || []).map(f => ({
    tracking_number: f.tracking_number,
    tracking_company: f.tracking_company,
    tracking_url: f.tracking_url,
    status: f.status,
    shipment_status: f.shipment_status
  })).filter(t => t.tracking_number);

  return {
    order_id: order.id,
    order_number: order.name || `#${order.order_number}`,
    created_at: order.created_at,
    status: order.cancelled_at ? 'cancelled' : fulfillmentStatus,
    financial_status: financialStatus,
    total_price: order.total_price,
    currency: order.currency,
    items: (order.line_items || []).map(li => ({
      title: li.title,
      quantity: li.quantity,
      price: li.price,
      variant_title: li.variant_title
    })),
    items_count: (order.line_items || []).length,
    shipping_address: order.shipping_address ? {
      city: order.shipping_address.city,
      province: order.shipping_address.province,
      country: order.shipping_address.country
    } : null,
    tracking: trackingInfo,
    customer_name: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : '',
    customer_email: order.customer?.email || order.email || '',
    customer_phone: order.customer?.phone || order.phone || ''
  };
}