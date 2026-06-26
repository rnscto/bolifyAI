import { client } from "../db/index.ts";

const BOLIFY_CRM_URL = 'https://login.getwaycrm.com/api/automations/69cb6ef8707f8/execute';

export default async function sendGetwayCRM(c: any) {
  try {
    const payload = await c.req.json().catch(() => ({}));

    const apiToken = Deno.env.get('GETWAY_CRM_API_TOKEN');
    if (!apiToken) {
      return c.json({ data: { error: 'GETWAY_CRM_API_TOKEN not configured' } }, 500);
    }

    let contactName = payload.contact_name || '';
    let contactPhone = payload.contact_phone || '';
    let contactEmail = payload.contact_email || '';

    // Auto-fetch lead data if lead_id provided
    if (payload.lead_id) {
      try {
        const leadRes = await client.queryObject(`SELECT * FROM lead WHERE id = $1`, [payload.lead_id]);
        const lead = leadRes.rows[0] as any;
        if (lead) {
          contactName = contactName || lead.name || '';
          contactPhone = contactPhone || lead.phone || '';
          contactEmail = contactEmail || lead.email || '';
        }
      } catch (err: any) {
        console.error('[sendGetwayCRM] DB Error:', err.message);
      }
    }

    if (!contactPhone && !contactEmail) {
      return c.json({ data: { error: 'At least one of contact_phone or contact_email is required' } }, 400);
    }

    // Build API params
    const params = new URLSearchParams();
    params.set('api_token', apiToken);
    params.set('contact_name', contactName || 'Unknown');
    if (contactEmail) params.set('contact_email', contactEmail);
    if (contactPhone) params.set('contact_phone', contactPhone);

    // Add custom fields for richer context
    if (payload.call_summary) params.set('call_summary', payload.call_summary.substring(0, 500));
    if (payload.call_outcome) params.set('call_outcome', payload.call_outcome);
    if (payload.call_duration) params.set('call_duration', String(payload.call_duration));
    if (payload.campaign_name) params.set('campaign_name', payload.campaign_name);
    if (payload.campaign_id) params.set('campaign_id', payload.campaign_id);
    if (payload.client_company) params.set('client_company', payload.client_company);
    if (payload.source) params.set('source', payload.source);
    if (payload.lead_status) params.set('lead_status', payload.lead_status);
    if (payload.lead_score) params.set('lead_score', String(payload.lead_score));
    if (payload.qualification_tier) params.set('qualification_tier', payload.qualification_tier);

    const response = await fetch(`\${BOLIFY_CRM_URL}?\${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    const result = await response.json();
    console.log(`[sendBolifyCRM] Response for \${contactPhone || contactEmail}:`, JSON.stringify(result));

    if (result.status === 'success') {
      return c.json({ data: { success: true, data: result.data } });
    } else {
      return c.json({ data: { success: false, error: result.message || 'Unknown error', raw: result } });
    }
  } catch (error: any) {
    console.error('[sendBolifyCRM] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }
}
