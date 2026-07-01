import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Seed the PricingPlan entity from the legacy hardcoded values in
 * lib/pricingConfig.js + lib/internationalPricing.js.
 *
 * Idempotent — uses plan_key as the upsert key. Running it again will only
 * insert plans that don't already exist (admin edits are preserved).
 *
 * Admin-only.
 */

const SEED = [
  // ─── INDIA — national subscriptions (per-channel monthly rate, varies by cycle) ───
  { scope: 'national_subscription', region: 'IN', plan_key: 'in_monthly',     label: 'Monthly',       price: 9999, currency: 'INR', symbol: '₹', billing_cycle: 'monthly',     tax_percent: 18, tax_label: 'GST', sort_order: 10, features: ['1 month commitment', 'Cancel anytime'] },
  { scope: 'national_subscription', region: 'IN', plan_key: 'in_quarterly',   label: 'Quarterly',     price: 7999, currency: 'INR', symbol: '₹', billing_cycle: 'quarterly',   tax_percent: 18, tax_label: 'GST', sort_order: 20, is_popular: true, features: ['20% off monthly', 'Most popular'] },
  { scope: 'national_subscription', region: 'IN', plan_key: 'in_half_yearly', label: 'Half-Yearly',   price: 6499, currency: 'INR', symbol: '₹', billing_cycle: 'half_yearly', tax_percent: 18, tax_label: 'GST', sort_order: 30, features: ['35% off monthly'] },
  { scope: 'national_subscription', region: 'IN', plan_key: 'in_yearly',      label: 'Yearly',        price: 6500, currency: 'INR', symbol: '₹', billing_cycle: 'yearly',      tax_percent: 18, tax_label: 'GST', sort_order: 40, features: ['Best value', '₹78,000/yr + 18% GST = ₹92,040 per channel'] },

  // ─── INDIA — Personal AI Assistant ───
  { scope: 'national_subscription', region: 'IN', plan_key: 'in_personal',    label: 'Personal AI Assistant', price: 2999, currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 5, features: ['Personal use', '1 number', 'AI screening'] },

  // ─── INDIA — CRM addon ───
  { scope: 'addon', region: 'IN', plan_key: 'in_crm_addon',     label: 'CRM Add-on',     price: 1999, currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 10, features: ['Full CRM module', 'Deals, contacts, reports'] },

  // ─── INDIA — Marketplace add-ons (plan_key MUST match lib/addonCatalog.js keys) ───
  { scope: 'addon', region: 'IN', plan_key: 'call_transfer',      label: 'Call Transfer',                  price: 1250, currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 20, description: 'Transfer AI calls to a human agent in real time' },
  { scope: 'addon', region: 'IN', plan_key: 'email_campaigns',    label: 'Bulk Email Campaigns',           price: 500,  currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 30, description: 'Send marketing emails to segmented lead audiences' },
  { scope: 'addon', region: 'IN', plan_key: 'whatsapp_bulk',      label: 'WhatsApp Bulk + Re-engagement',  price: 500,  currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 40, description: 'Automated WhatsApp campaigns with re-engagement flows' },
  { scope: 'addon', region: 'IN', plan_key: 'screening',          label: 'AI Bulk Candidate Screening',    price: 2000, currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 50, description: 'Automated AI phone interviews & scoring' },
  { scope: 'addon', region: 'IN', plan_key: 'google_sheets_sync', label: 'Google Sheets Sync',             price: 500,  currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 60, description: '2-way Google Sheets sync — import leads & push call status' },
  { scope: 'addon', region: 'IN', plan_key: 'social_media',       label: 'Social Media',                   price: 2000, currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 70, description: 'AI-generated content with auto-publishing' },
  { scope: 'addon', region: 'IN', plan_key: 'additional_did',     label: 'Additional DID (Round-Robin)',   price: 200,  currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 80, description: 'Extra DID numbers for round-robin calling — anti-spam protection' },
  { scope: 'addon', region: 'IN', plan_key: 'incoming_calls',     label: 'Incoming Calls',                 price: 2000, currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 90, description: 'Enable inbound AI calling on your DIDs' },
  { scope: 'addon', region: 'IN', plan_key: 'extra_agent',           label: 'Additional AI Agent (Monthly)',   price: 4999,  currency: 'INR', symbol: '₹', billing_cycle: 'monthly',   tax_percent: 18, tax_label: 'GST', sort_order: 100, description: 'One more AI voice agent — billed monthly' },
  { scope: 'addon', region: 'IN', plan_key: 'extra_agent_quarterly', label: 'Additional AI Agent (Quarterly)', price: 13499, currency: 'INR', symbol: '₹', billing_cycle: 'quarterly', tax_percent: 18, tax_label: 'GST', sort_order: 101, description: 'One more AI voice agent — billed every 3 months (10% off)' },
  { scope: 'addon', region: 'IN', plan_key: 'extra_agent_yearly',    label: 'Additional AI Agent (Yearly)',    price: 47999, currency: 'INR', symbol: '₹', billing_cycle: 'yearly',    tax_percent: 18, tax_label: 'GST', sort_order: 102, description: 'One more AI voice agent — billed yearly (20% off)' },

  // ─── INDIA — BFSI Suite tiers (compliance + collections + verification + RCU + mandate bounce) ───
  { scope: 'addon', region: 'IN', plan_key: 'bfsi_suite_starter',    label: 'BFSI Suite — Starter',    price: 14999,  currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 200, description: 'Up to 1,000 loan accounts • 3,000 calls/mo • compliance + collections + verification', features: ['Up to 1,000 accounts', '3,000 AI calls/month', 'RBI/DPDP compliance gates', '3 pre-built BFSI personas', 'PTP/RTP/Paid outcome capture', 'WhatsApp payment links', 'Audit-ready recordings (5yr retention)'] },
  { scope: 'addon', region: 'IN', plan_key: 'bfsi_suite_growth',     label: 'BFSI Suite — Growth',     price: 49999,  currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 210, is_popular: true, description: 'Up to 5,000 accounts • 15,000 calls/mo • full lending lifecycle', features: ['Up to 5,000 accounts', '15,000 AI calls/month', 'All Starter features', 'Skip-tracing + reference checks', 'Mandate bounce automation', 'NACH / e-mandate flows', '8 BFSI personas', 'Priority support'] },
  { scope: 'addon', region: 'IN', plan_key: 'bfsi_suite_scale',      label: 'BFSI Suite — Scale',      price: 149999, currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 220, description: 'Up to 25,000 accounts • 75,000 calls/mo • LMS/LOS sync', features: ['Up to 25,000 accounts', '75,000 AI calls/month', 'All Growth features', 'LMS/LOS bidirectional sync', 'Dedicated CSM', 'Custom personas', 'Quarterly RBI audit export', '4hr SLA'] },
  { scope: 'addon', region: 'IN', plan_key: 'bfsi_suite_enterprise', label: 'BFSI Suite — Enterprise', price: null,   currency: 'INR', symbol: '₹', billing_cycle: 'monthly', tax_percent: 18, tax_label: 'GST', sort_order: 230, description: 'Unlimited accounts • custom volumes • white-glove onboarding', features: ['Unlimited accounts', 'Custom call volume', 'On-prem option', 'White-glove onboarding', '24/7 phone support', 'Custom compliance certification'] },

  // ─── BFSI per-call overage rates (used after included quota is exhausted) ───
  { scope: 'addon', region: 'IN', plan_key: 'bfsi_overage_call', label: 'BFSI — Per-call Overage', price: 4, currency: 'INR', symbol: '₹', billing_cycle: 'per_minute', tax_percent: 18, tax_label: 'GST', sort_order: 250, description: 'Charged per successful AI call once monthly quota is exhausted' },

  // ─── US — minute packs ───
  { scope: 'intl_minute_pack', region: 'US', plan_key: 'us_starter',    label: 'Starter',    price: 149,  currency: 'USD', symbol: '$', billing_cycle: 'monthly', minutes_included: 500,   overage_rate: 0.30, per_minute_cost: 0.10, sort_order: 10, features: ['1 AI Agent', '1 US Local DID included', 'Standard support (24hr SLA)', 'Email + Chat'] },
  { scope: 'intl_minute_pack', region: 'US', plan_key: 'us_growth',     label: 'Growth',     price: 499,  currency: 'USD', symbol: '$', billing_cycle: 'monthly', minutes_included: 2000,  overage_rate: 0.25, per_minute_cost: 0.10, sort_order: 20, is_popular: true, features: ['3 AI Agents', '2 US Local DIDs included', 'Standard support (24hr SLA)', 'Campaign automation', 'Analytics'] },
  { scope: 'intl_minute_pack', region: 'US', plan_key: 'us_scale',      label: 'Scale',      price: 1999, currency: 'USD', symbol: '$', billing_cycle: 'monthly', minutes_included: 10000, overage_rate: 0.20, per_minute_cost: 0.10, sort_order: 30, features: ['Unlimited AI Agents', '5 US Local DIDs included', 'Priority support (4hr SLA)', 'Dedicated Slack', 'API access'] },
  { scope: 'intl_minute_pack', region: 'US', plan_key: 'us_enterprise', label: 'Enterprise', price: null, currency: 'USD', symbol: '$', billing_cycle: 'monthly', minutes_included: null, overage_rate: null, sort_order: 40, features: ['Custom volume', 'Dedicated CSM', 'Custom integrations', '24/7 support', 'SLA guarantee', 'On-prem option'] },

  // ─── UK — minute packs ───
  { scope: 'intl_minute_pack', region: 'UK', plan_key: 'uk_starter',    label: 'Starter',    price: 119,  currency: 'GBP', symbol: '£', billing_cycle: 'monthly', minutes_included: 500,   overage_rate: 0.25, per_minute_cost: 0.11, tax_percent: 20, tax_label: 'VAT', sort_order: 10, features: ['1 AI Agent', '1 UK Local DID included', 'Standard support (24hr SLA)', 'Email + Chat'] },
  { scope: 'intl_minute_pack', region: 'UK', plan_key: 'uk_growth',     label: 'Growth',     price: 399,  currency: 'GBP', symbol: '£', billing_cycle: 'monthly', minutes_included: 2000,  overage_rate: 0.20, per_minute_cost: 0.11, tax_percent: 20, tax_label: 'VAT', sort_order: 20, is_popular: true, features: ['3 AI Agents', '2 UK Local DIDs included', 'Standard support (24hr SLA)', 'Campaign automation', 'Analytics'] },
  { scope: 'intl_minute_pack', region: 'UK', plan_key: 'uk_scale',      label: 'Scale',      price: 1599, currency: 'GBP', symbol: '£', billing_cycle: 'monthly', minutes_included: 10000, overage_rate: 0.16, per_minute_cost: 0.11, tax_percent: 20, tax_label: 'VAT', sort_order: 30, features: ['Unlimited AI Agents', '5 UK Local DIDs included', 'Priority support (4hr SLA)', 'Dedicated Slack', 'API access'] },
  { scope: 'intl_minute_pack', region: 'UK', plan_key: 'uk_enterprise', label: 'Enterprise', price: null, currency: 'GBP', symbol: '£', billing_cycle: 'monthly', minutes_included: null, overage_rate: null, tax_percent: 20, tax_label: 'VAT', sort_order: 40, features: ['Custom volume', 'Dedicated CSM', 'Custom integrations', '24/7 support', 'SLA guarantee', 'On-prem option'] },

  // ─── Setup fees — US ───
  { scope: 'setup_fee', region: 'US', plan_key: 'us_self_serve',       label: 'Self-Serve',       price: 0,    currency: 'USD', symbol: '$', billing_cycle: 'one_time', sort_order: 10, includes: 'Docs + email support' },
  { scope: 'setup_fee', region: 'US', plan_key: 'us_starter_setup',    label: 'Starter Setup',    price: 499,  currency: 'USD', symbol: '$', billing_cycle: 'one_time', sort_order: 20, includes: '1× onboarding call (60 min), 1 agent built for you, KB ingestion' },
  { scope: 'setup_fee', region: 'US', plan_key: 'us_pro_setup',        label: 'Pro Setup',        price: 1499, currency: 'USD', symbol: '$', billing_cycle: 'one_time', sort_order: 30, includes: '3× sessions, up to 3 agents, campaign setup, dashboard training' },
  { scope: 'setup_fee', region: 'US', plan_key: 'us_enterprise_setup', label: 'Enterprise Setup', price: 4999, currency: 'USD', symbol: '$', billing_cycle: 'one_time', sort_order: 40, includes: 'White-glove, CRM integrations (Salesforce/HubSpot), custom workflows' },

  // ─── Setup fees — UK ───
  { scope: 'setup_fee', region: 'UK', plan_key: 'uk_self_serve',       label: 'Self-Serve',       price: 0,    currency: 'GBP', symbol: '£', billing_cycle: 'one_time', sort_order: 10, includes: 'Docs + email support' },
  { scope: 'setup_fee', region: 'UK', plan_key: 'uk_starter_setup',    label: 'Starter Setup',    price: 399,  currency: 'GBP', symbol: '£', billing_cycle: 'one_time', sort_order: 20, includes: '1× onboarding call (60 min), 1 agent built for you, KB ingestion' },
  { scope: 'setup_fee', region: 'UK', plan_key: 'uk_pro_setup',        label: 'Pro Setup',        price: 1199, currency: 'GBP', symbol: '£', billing_cycle: 'one_time', sort_order: 30, includes: '3× sessions, up to 3 agents, campaign setup, dashboard training' },
  { scope: 'setup_fee', region: 'UK', plan_key: 'uk_enterprise_setup', label: 'Enterprise Setup', price: 3999, currency: 'GBP', symbol: '£', billing_cycle: 'one_time', sort_order: 40, includes: 'White-glove, CRM integrations (Salesforce/HubSpot), custom workflows' },

  // ─── DID rentals — US ───
  { scope: 'did_rental', region: 'US', plan_key: 'us_local',     label: 'US Local Number',    price: 5,  currency: 'USD', symbol: '$', billing_cycle: 'monthly', sort_order: 10, metadata: { our_cost: 1.15 } },
  { scope: 'did_rental', region: 'US', plan_key: 'us_toll_free', label: 'US Toll-Free (800)', price: 15, currency: 'USD', symbol: '$', billing_cycle: 'monthly', sort_order: 20, metadata: { our_cost: 2.00 } },
  { scope: 'did_rental', region: 'US', plan_key: 'us_vanity',    label: 'US Vanity / Premium', price: 50, currency: 'USD', symbol: '$', billing_cycle: 'monthly', sort_order: 30, metadata: { our_cost: 30 } },
  { scope: 'did_rental', region: 'US', plan_key: 'us_porting',   label: 'Number Porting (one-time)', price: 25, currency: 'USD', symbol: '$', billing_cycle: 'one_time', sort_order: 40 },

  // ─── DID rentals — UK ───
  { scope: 'did_rental', region: 'UK', plan_key: 'uk_local',     label: 'UK Local Number',    price: 5,  currency: 'GBP', symbol: '£', billing_cycle: 'monthly', sort_order: 10, metadata: { our_cost: 1.00 } },
  { scope: 'did_rental', region: 'UK', plan_key: 'uk_toll_free', label: 'UK 0800 Toll-Free',  price: 15, currency: 'GBP', symbol: '£', billing_cycle: 'monthly', sort_order: 20, metadata: { our_cost: 2.00 } },
  { scope: 'did_rental', region: 'UK', plan_key: 'uk_porting',   label: 'Number Porting (one-time)', price: 25, currency: 'GBP', symbol: '£', billing_cycle: 'one_time', sort_order: 30 },

  // ─── Support tiers — global ───
  { scope: 'support_tier', region: 'global', plan_key: 'community',     label: 'Community',     price: 0,    currency: 'USD', symbol: '$', billing_cycle: 'monthly', sla: '48hr',  sort_order: 10, description: 'Email + docs',                                metadata: { included_with: ['us_starter','us_growth','uk_starter','uk_growth'] } },
  { scope: 'support_tier', region: 'global', plan_key: 'standard',      label: 'Standard',      price: 99,   currency: 'USD', symbol: '$', billing_cycle: 'monthly', sla: '24hr',  sort_order: 20, description: 'Email + chat, business hours',               metadata: { included_with: ['us_starter','us_growth','uk_starter','uk_growth'] } },
  { scope: 'support_tier', region: 'global', plan_key: 'priority',      label: 'Priority',      price: 499,  currency: 'USD', symbol: '$', billing_cycle: 'monthly', sla: '4hr',   sort_order: 30, description: 'Dedicated Slack channel, monthly review call', metadata: { included_with: ['us_scale','uk_scale'] }, is_popular: true },
  { scope: 'support_tier', region: 'global', plan_key: 'dedicated_csm', label: 'Dedicated CSM', price: 1999, currency: 'USD', symbol: '$', billing_cycle: 'monthly', sla: '1hr',   sort_order: 40, description: 'Named account manager, weekly calls, custom training' },
  { scope: 'support_tier', region: 'global', plan_key: 'enterprise_247',label: 'Enterprise 24/7',price: 4999,currency: 'USD', symbol: '$', billing_cycle: 'monthly', sla: '15min', sort_order: 50, description: '24/7 phone support, on-call engineer, custom SLA', metadata: { included_with: ['us_enterprise','uk_enterprise'] } },
];

export default async function seedPricingCatalog(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    const existing = await base44.asServiceRole.entities.PricingPlan.list('-created_date', 1000);
    const existingKeys = new Set(existing.map(p => p.plan_key));

    const toCreate = SEED.filter(p => !existingKeys.has(p.plan_key));
    let created = 0;
    if (toCreate.length > 0) {
      await base44.asServiceRole.entities.PricingPlan.bulkCreate(
        toCreate.map(p => ({ is_active: true, ...p }))
      );
      created = toCreate.length;
    }

    return c.json({ data: {
      success: true,
      created,
      already_existed: SEED.length - toCreate.length,
      total_in_seed: SEED.length,
      total_in_db_after: existing.length + created,
    } });
  } catch (error) {
    console.error('seedPricingCatalog error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};