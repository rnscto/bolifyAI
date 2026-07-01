import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Reports a successful sale to the Brainbucks Affiliate App webhook.
// Service-role callable from verifyPayment (and any other payment flow).
//
// Payload: { ref_code, product_id?, product_name?, amount, buyer_name?, buyer_email?, payment_ref?, sale_type? }
// Returns: { success, sale_id?, affiliate_id?, direct_income?, bv_generated?, message? } or { error }

const AFFILIATE_WEBHOOK_URL =
  'https://api.base44.com/api/apps/69f232ebf46881f3db6ccb72/functions/receiveSaleWebhook';

const DEFAULT_PRODUCT_ID = 'vaaniai';
const DEFAULT_PRODUCT_NAME = 'TBB-VaaniAI';

export default async function reportAffiliateSale(c: any) {
  const req = c.req.raw || c.req;
  try {
    const apiKey = Deno.env.get('AFFILIATE_WEBHOOK_API_KEY');
    if (!apiKey) {
      return c.json({ data: { error: 'AFFILIATE_WEBHOOK_API_KEY not configured' } }, 500);
    }

    const body = await c.req.json();
    const {
      ref_code,
      product_id,
      product_name,
      amount,
      buyer_name,
      buyer_email,
      payment_ref,
      sale_type,
    } = body;

    if (!ref_code) {
      return c.json({ data: { error: 'ref_code is required' } }, 400);
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return c.json({ data: { error: 'amount must be a positive number' } }, 400);
    }

    const payload = {
      ref_code: String(ref_code).trim(),
      product_id: product_id || DEFAULT_PRODUCT_ID,
      product_name: product_name || DEFAULT_PRODUCT_NAME,
      amount,
      sale_type: sale_type || 'fresh',
      ...(buyer_name && { buyer_name }),
      ...(buyer_email && { buyer_email }),
      ...(payment_ref && { payment_ref }),
    };

    const res = await fetch(AFFILIATE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('[reportAffiliateSale] Webhook failed:', res.status, data);
      return c.json({ data: { error: data?.message || data?.error || `HTTP ${res.status}`, details: data } }, 400);
    }

    return c.json({ data: { success: true, ...data } });
  } catch (error) {
    console.error('[reportAffiliateSale] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};