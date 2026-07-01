import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// createIntlSubscription — Stripe Checkout for international minute plans.
// Creates a Subscription mode session (monthly recurring) for US/UK plans.
// Optionally bundles a one-time setup fee on the same session.
// ═══════════════════════════════════════════════════════════════════════


import Stripe from 'npm:stripe@17.5.0';

// Stripe Price IDs are read from the PricingPlan entity (stripe_price_id field).
// Fallbacks below are used only if the DB has no plan with that key OR no
// stripe_price_id set — handy for first-boot / pre-seed and for keeping the
// current test-mode IDs working. Admin can override per plan in the UI.
const FALLBACK_PLAN_PRICE_IDS = {
  us_starter: 'price_1TbxMpCd5yiOzYSeNqgHn1pB',
  us_growth: 'price_1TbxMpCd5yiOzYSeQFD7DnyP',
  us_scale: 'price_1TbxMpCd5yiOzYSexmP3Yazk',
  uk_starter: 'price_1TbxMpCd5yiOzYSe7b3YxATj',
  uk_growth: 'price_1TbxMpCd5yiOzYSeeWgysjaY',
  uk_scale: 'price_1TbxMpCd5yiOzYSeQUqoW0GD',
};
const FALLBACK_SETUP_PRICE_IDS = {
  starter_setup: 'price_1TbxMpCd5yiOzYSeWD4eZRqB',
  pro_setup: 'price_1TbxMpCd5yiOzYSekLz5N00R',
  enterprise_setup: 'price_1TbxMpCd5yiOzYSe4fFV2tJH',
};
const FALLBACK_SUPPORT_PRICE_IDS = {
  priority: 'price_1TbxMpCd5yiOzYSeE7VAWcFx',
  dedicated_csm: 'price_1TbxMpCd5yiOzYSeeXMRT9nJ',
  enterprise_247: 'price_1TbxMpCd5yiOzYSe10vA07hZ',
};

async function resolveStripePriceId(base44, plan_key, fallbackMap) {
  if (!plan_key) return null;
  try {
    const rows = await base44.asServiceRole.entities.PricingPlan.filter({ plan_key });
    const dbId = rows?.[0]?.stripe_price_id;
    if (dbId) return dbId;
  } catch (e) {
    console.warn('[createIntlSubscription] PricingPlan lookup failed for', plan_key, e.message);
  }
  return fallbackMap[plan_key] || null;
}

// Hardcoded fallback meta — used only if PricingPlan entity has no row for this key.
const FALLBACK_PLAN_META = {
  us_starter: { minutes: 500, overage: 0.30, currency: 'USD' },
  us_growth: { minutes: 2000, overage: 0.25, currency: 'USD' },
  us_scale: { minutes: 10000, overage: 0.20, currency: 'USD' },
  uk_starter: { minutes: 500, overage: 0.25, currency: 'GBP' },
  uk_growth: { minutes: 2000, overage: 0.20, currency: 'GBP' },
  uk_scale: { minutes: 10000, overage: 0.16, currency: 'GBP' },
};

export default async function createIntlSubscription(c: any) {
  const req = c.req.raw || c.req;
  try {
    if (req.method !== 'POST') return c.json({ data: { error: 'POST only' } }, 405);

    const body = await c.req.json();
    const { plan_key, setup_fee_key, support_tier_key, email, company_name, client_id } = body;

    if (!plan_key) {
      return c.json({ data: { error: 'plan_key required' } }, 400);
    }
    if (!email) {
      return c.json({ data: { error: 'email required' } }, 400);
    }

    /* const base44 = ... */;
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY'));

    // Prefer DB PricingPlan, fall back to hardcoded meta if not seeded
    let planMeta;
    try {
      const dbPlans = await base44.asServiceRole.entities.PricingPlan.filter({ plan_key });
      const dbPlan = dbPlans?.[0];
      if (dbPlan) {
        planMeta = {
          minutes: dbPlan.minutes_included ?? 0,
          overage: dbPlan.overage_rate ?? 0,
          currency: dbPlan.currency || 'USD',
        };
      }
    } catch (e) {
      console.warn('[createIntlSubscription] DB lookup failed, using fallback:', e.message);
    }
    if (!planMeta) planMeta = FALLBACK_PLAN_META[plan_key];
    if (!planMeta) {
      return c.json({ data: { error: `Unknown plan_key: ${plan_key}` } }, 400);
    }

    // Resolve Stripe Price IDs (DB first, then fallback)
    const planPriceId = await resolveStripePriceId(base44, plan_key, FALLBACK_PLAN_PRICE_IDS);
    if (!planPriceId) {
      return c.json({ data: { error: `No Stripe price configured for ${plan_key}. Set stripe_price_id in Admin → Pricing Manager.` } }, 400);
    }
    const lineItems = [{ price: planPriceId, quantity: 1 }];

    if (support_tier_key) {
      const supportPriceId = await resolveStripePriceId(base44, support_tier_key, FALLBACK_SUPPORT_PRICE_IDS);
      if (supportPriceId) lineItems.push({ price: supportPriceId, quantity: 1 });
    }
    if (setup_fee_key) {
      const setupPriceId = await resolveStripePriceId(base44, setup_fee_key, FALLBACK_SETUP_PRICE_IDS);
      if (setupPriceId) lineItems.push({ price: setupPriceId, quantity: 1 });
    }

    const origin = req.headers.get('origin') || 'https://app.base44.com';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: lineItems,
      customer_email: email,
      success_url: `${origin}/ClientSubscription?intl_session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${origin}/pricing?status=cancelled`,
      metadata: {
        base44_app_id: Deno.env.get('BASE44_APP_ID'),
        flow: 'intl_subscription',
        plan_key,
        setup_fee_key: setup_fee_key || '',
        support_tier_key: support_tier_key || '',
        client_id: client_id || '',
        company_name: company_name || '',
        minutes_included: String(planMeta.minutes),
        overage_rate: String(planMeta.overage),
        currency: planMeta.currency,
        region: plan_key.startsWith('us_') ? 'US' : 'UK',
      },
    });

    return c.json({ data: {
      checkout_url: session.url,
      session_id: session.id,
    } });
  } catch (error) {
    console.error('[createIntlSubscription] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};