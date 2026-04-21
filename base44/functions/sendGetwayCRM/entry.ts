import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.23';

const BOLIFY_CRM_URL = 'https://login.getwaycrm.com/api/automations/69cb6ef8707f8/execute';

/**
 * Sends a contact to Bolify AI CRM for WhatsApp/RCS automation.
 * Can be called from frontend (user auth) or from other backend functions (service role via _service_call flag).
 * 
 * Payload:
 *   - lead_id (optional): auto-fetches lead data
 *   - contact_name, contact_phone, contact_email: direct values (used if no lead_id)
 *   - call_summary, call_outcome, call_duration: post-call context
 *   - campaign_name, campaign_id: campaign context
 *   - client_company: client company name
 *   - source: trigger source ("post_call" | "campaign" | "manual")
 *   - _service_call: if true, skip user auth (called from other backend functions)
 */
Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    
    // Support both user-auth (frontend) and service-role (backend-to-backend) calls
    let base44;
    if (payload._service_call) {
      base44 = createClient({ appId: Deno.env.get('BASE44_APP_ID'), asServiceRole: true });
    } else {
      base44 = createClientFromRequest(req);
      const user = await base44.auth.me();
      if (!user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    const apiToken = Deno.env.get('GETWAY_CRM_API_TOKEN');
    if (!apiToken) {
      return Response.json({ error: 'GETWAY_CRM_API_TOKEN not configured' }, { status: 500 });
    }

    let contactName = payload.contact_name || '';
    let contactPhone = payload.contact_phone || '';
    let contactEmail = payload.contact_email || '';

    // Auto-fetch lead data if lead_id provided
    if (payload.lead_id) {
      try {
        const lead = await base44.entities.Lead.get(payload.lead_id);
        if (lead) {
          contactName = contactName || lead.name || '';
          contactPhone = contactPhone || lead.phone || '';
          contactEmail = contactEmail || lead.email || '';
        }
      } catch (_) {}
    }

    if (!contactPhone && !contactEmail) {
      return Response.json({ error: 'At least one of contact_phone or contact_email is required' }, { status: 400 });
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

    const response = await fetch(`${BOLIFY_CRM_URL}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    const result = await response.json();
    console.log(`[sendBolifyCRM] Response for ${contactPhone || contactEmail}:`, JSON.stringify(result));

    if (result.status === 'success') {
      return Response.json({ success: true, data: result.data });
    } else {
      return Response.json({ success: false, error: result.message || 'Unknown error', raw: result });
    }
  } catch (error) {
    console.error('[sendBolifyCRM] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});