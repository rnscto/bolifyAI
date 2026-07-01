import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Sends the Google Meet link for a scheduled demo/meeting to the lead via WhatsApp
// using the client's RCS Digital integration. Uses a dedicated template
// "meeting_link_share" — auto-creates & submits the template the first time
// it's needed for a client, and gracefully skips if the template isn't
// approved yet (Meta approval is async, 1-5 min typically).
//
// Payload: { activity_id } OR { lead_id }, optionally { email_activity_id }
// Returns { success, message_id, sent_to, status } or { skipped, reason }



const RCS_BASE = 'https://rcsdigital.in';
const VERSION = 'v23.0';
const TEMPLATE_NAME = 'meeting_link_share';
const TEMPLATE_LANGUAGE = 'en';

function formatISTDateTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric',
      month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    }) + ' IST';
  } catch { return isoStr; }
}

// WhatsApp strips https:// and query params aren't allowed in some template button URLs.
// Google Meet links like https://meet.google.com/xxx-yyyy-zzz are fine as-is.
function cleanMeetUrl(url) {
  return (url || '').trim();
}

// Build the "meeting_link_share" template definition. The Meet URL goes into
// both the body (as a variable) AND the CTA button (as URL variable).
function buildTemplateDefinition() {
  return {
    name: TEMPLATE_NAME,
    category: 'UTILITY',
    language: TEMPLATE_LANGUAGE,
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'Your meeting is ready'
      },
      {
        type: 'BODY',
        text: 'Hi {{1}},\n\nThank you for scheduling {{2}} with {{3}}.\n\n🕒 When: {{4}}\n🎥 Join link: {{5}}\n\nClick the button below to join the meeting at the scheduled time. See you there!',
        example: {
          body_text: [[
            'Rahul',
            'VaaniAI Demo',
            'Tech BrainBucks',
            'Mon, 22 Apr 2026, 11:00 AM IST',
            'https://meet.google.com/abc-defg-hij'
          ]]
        }
      },
      {
        type: 'FOOTER',
        text: 'Need to reschedule? Just reply to this message.'
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Open Google Meet',
            url: 'https://meet.google.com/'
          }
        ]
      }
    ]
  };
}

async function rcsFetch(path, { method = 'GET', headers = {}, body, token }) {
  const res = await fetch(`${RCS_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, ...headers },
    body
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Ensure the meeting_link_share template exists on RCS Digital and in our DB.
// Returns the local MessageTemplate record (may be pending approval).
async function ensureMeetingLinkTemplate(base44, client, config) {
  // 1. Check local DB first
  const existing = await base44.entities.MessageTemplate.filter({
    client_id: client.id, channel: 'whatsapp', name: TEMPLATE_NAME
  });
  if (existing.length > 0) return existing[0];

  // 2. Not found locally — check remote (maybe it exists on RCS Digital but not synced)
  const token = config.whatsapp_api_key;
  const wabaId = config.whatsapp_business_id;
  if (!token || !wabaId) {
    throw new Error('WhatsApp API key or WABA ID not configured');
  }

  const { ok: listOk, data: listData } = await rcsFetch(
    `/${VERSION}/${wabaId}/message_templates?limit=200`,
    { token }
  );
  if (listOk && listData?.data) {
    const remote = listData.data.find(
      t => t.name === TEMPLATE_NAME && t.language === TEMPLATE_LANGUAGE
    );
    if (remote) {
      // Create local record for it
      const created = await base44.entities.MessageTemplate.create({
        client_id: client.id,
        vendor: 'rcs_digital',
        channel: 'whatsapp',
        name: TEMPLATE_NAME,
        language: TEMPLATE_LANGUAGE,
        category: 'UTILITY',
        body: 'Hi {{1}},\n\nThank you for scheduling {{2}} with {{3}}.\n\n🕒 When: {{4}}\n🎥 Join link: {{5}}\n\nClick the button below to join the meeting at the scheduled time. See you there!',
        header_type: 'text',
        header_text: 'Your meeting is ready',
        footer_text: 'Need to reschedule? Just reply to this message.',
        buttons: [{ type: 'URL', text: 'Open Google Meet', url: 'https://meet.google.com/' }],
        variables: ['Lead name', 'Meeting title', 'Company name', 'Date & time (IST)', 'Meet link'],
        sample_values: ['Rahul', 'VaaniAI Demo', 'Tech BrainBucks', 'Mon, 22 Apr 2026, 11:00 AM IST', 'https://meet.google.com/abc-defg-hij'],
        vendor_template_id: remote.id,
        approval_status: (remote.status || 'pending').toLowerCase(),
        approved_at: remote.status === 'APPROVED' ? new Date().toISOString() : null,
        last_synced_at: new Date().toISOString()
      });
      console.log(`[sendMeetingLinkWhatsApp] Imported existing remote template: status=${remote.status}`);
      return created;
    }
  }

  // 3. Not on remote either — submit for approval
  console.log(`[sendMeetingLinkWhatsApp] Creating + submitting new template "${TEMPLATE_NAME}" to RCS Digital for client ${client.id}`);
  const { ok, status, data } = await rcsFetch(
    `/${VERSION}/${wabaId}/message_templates`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTemplateDefinition()),
      token
    }
  );
  if (!ok) {
    const errMsg = data?.error?.message || data?.response?.[0]?.message || `HTTP ${status}`;
    throw new Error(`Template submission failed: ${errMsg}`);
  }

  const localTemplate = await base44.entities.MessageTemplate.create({
    client_id: client.id,
    vendor: 'rcs_digital',
    channel: 'whatsapp',
    name: TEMPLATE_NAME,
    language: TEMPLATE_LANGUAGE,
    category: 'UTILITY',
    body: 'Hi {{1}},\n\nThank you for scheduling {{2}} with {{3}}.\n\n🕒 When: {{4}}\n🎥 Join link: {{5}}\n\nClick the button below to join the meeting at the scheduled time. See you there!',
    header_type: 'text',
    header_text: 'Your meeting is ready',
    footer_text: 'Need to reschedule? Just reply to this message.',
    buttons: [{ type: 'URL', text: 'Open Google Meet', url: 'https://meet.google.com/' }],
    variables: ['Lead name', 'Meeting title', 'Company name', 'Date & time (IST)', 'Meet link'],
    sample_values: ['Rahul', 'VaaniAI Demo', 'Tech BrainBucks', 'Mon, 22 Apr 2026, 11:00 AM IST', 'https://meet.google.com/abc-defg-hij'],
    vendor_template_id: data.id,
    approval_status: (data.status || 'pending').toLowerCase(),
    submitted_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString()
  });
  return localTemplate;
}

export default async function sendMeetingLinkWhatsApp(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json();
    const { activity_id, lead_id, email_activity_id } = body;

    // 1. Resolve the demo activity. meet_link is generated asynchronously by
    // createCalendarEvent, so retry a few times (re-fetching) to dodge the race
    // where the link wasn't saved yet on the first lookup.
    const resolveDemoActivity = async () => {
      if (activity_id) {
        return await base44.entities.Activity.get(activity_id).catch(() => null);
      }
      if (lead_id) {
        const activities = await base44.entities.Activity.filter({ lead_id });
        const candidates = activities
          .filter(a => ['demo', 'meeting', 'appointment'].includes(a.type) && a.meet_link)
          .sort((a, b) => new Date(b.scheduled_date) - new Date(a.scheduled_date));
        return candidates[0] || null;
      }
      return null;
    };

    let demoActivity = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      demoActivity = await resolveDemoActivity();
      if (demoActivity?.meet_link) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!demoActivity) return c.json({ data: { skipped: true, reason: 'no_demo_activity_with_meet_link' } });
    if (!demoActivity.meet_link) return c.json({ data: { skipped: true, reason: 'no_meet_link', activity_id: demoActivity.id } });

    // 2. Load lead + client + config
    const lead = demoActivity.lead_id ? await base44.entities.Lead.get(demoActivity.lead_id).catch(() => null) : null;
    if (!lead?.phone) return c.json({ data: { skipped: true, reason: 'lead_has_no_phone', lead_name: lead?.name } });

    const client = await base44.entities.Client.get(demoActivity.client_id).catch(() => null);
    if (!client) return c.json({ data: { skipped: true, reason: 'client_not_found' } });

    const configs = await base44.entities.ClientMessagingConfig.filter({ client_id: client.id });
    const config = configs[0];
    if (!config || config.whatsapp_provider !== 'rcs_digital' || config.whatsapp_status !== 'connected') {
      return c.json({ data: { skipped: true, reason: 'whatsapp_not_connected', provider: config?.whatsapp_provider, status: config?.whatsapp_status } });
    }
    if (!config.whatsapp_api_key || !config.whatsapp_phone_number_id || !config.whatsapp_business_id) {
      return c.json({ data: { skipped: true, reason: 'whatsapp_config_incomplete' } });
    }

    // 3. Ensure template exists + is approved
    let template;
    try {
      template = await ensureMeetingLinkTemplate(base44, client, config);
    } catch (e) {
      console.error('[sendMeetingLinkWhatsApp] Template setup failed:', e.message);
      return c.json({ data: { skipped: true, reason: 'template_setup_failed', error: e.message } });
    }
    if (template.approval_status !== 'approved') {
      console.log(`[sendMeetingLinkWhatsApp] Template "${TEMPLATE_NAME}" not yet approved (status=${template.approval_status}). Skipping send — will work on next call after approval.`);
      return c.json({ data: {
        skipped: true,
        reason: 'template_pending_approval',
        status: template.approval_status,
        hint: 'Meta template approval typically takes 1–5 minutes. Retry shortly.'
      } });
    }

    // 4. Build body variables. The join link is included in the body text ({{5}}).
    // The CTA button is a STATIC URL (https://meet.google.com/) — Meta rejects
    // dynamic URL variables containing Meet codes ("Invalid parameter"), so the
    // full clickable link lives in the body instead.
    const meetLink = cleanMeetUrl(demoActivity.meet_link);

    const bodyVars = [
      lead.name || 'there',
      demoActivity.title || 'your meeting',
      client.company_name || 'VaaniAI',
      formatISTDateTime(demoActivity.scheduled_date) || 'the scheduled time',
      meetLink
    ];

    // 5. Send via RCS Digital (Meta Cloud API shape)
    // Normalize to E.164 digits WITH country code. Bare 10-digit Indian numbers
    // make RCS/Meta resolve country "001" (unknown) → "No base price defined" error.
    // Default missing country code to India (91).
    let cleanPhone = String(lead.phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;        // bare Indian mobile
    else if (cleanPhone.length === 11 && cleanPhone.startsWith('0')) cleanPhone = `91${cleanPhone.slice(1)}`; // leading-0 Indian
    const sendPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: TEMPLATE_LANGUAGE },
        components: [
          {
            type: 'body',
            parameters: bodyVars.map(v => ({ type: 'text', text: String(v) }))
          }
        ]
      }
    };

    const { ok, status, data } = await rcsFetch(
      `/${VERSION}/${config.whatsapp_phone_number_id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendPayload),
        token: config.whatsapp_api_key
      }
    );

    if (!ok) {
      const errMsg = data?.error?.message || data?.response?.[0]?.message || `HTTP ${status}`;
      console.error(`[sendMeetingLinkWhatsApp] Send failed: ${errMsg}`);
      await base44.entities.OutreachLog.create({
        client_id: client.id,
        lead_id: demoActivity.lead_id,
        call_log_id: demoActivity.call_log_id || null,
        channel: 'whatsapp',
        recipient_phone: cleanPhone,
        subject: `Meeting link (failed): ${demoActivity.title || 'demo'}`,
        body: `Tried to send Meet link ${meetLink}. Error: ${errMsg}`,
        outreach_type: 'meeting_link',
        status: 'failed',
        error_message: errMsg
      }).catch(() => {});
      return c.json({ data: { success: false, error: errMsg, details: data } }, 400);
    }

    const messageId = data?.messages?.[0]?.id || null;

    // 6. Log outreach
    await base44.entities.OutreachLog.create({
      client_id: client.id,
      lead_id: demoActivity.lead_id,
      call_log_id: demoActivity.call_log_id || null,
      channel: 'whatsapp',
      recipient_phone: cleanPhone,
      subject: `Meeting link: ${demoActivity.title || 'demo'}`,
      body: `WhatsApp Meet link sent: ${meetLink} for ${demoActivity.title}`,
      outreach_type: 'meeting_link',
      status: 'sent'
    }).catch(e => console.warn(`[sendMeetingLinkWhatsApp] OutreachLog create failed: ${e.message}`));

    // 7. Bump template usage
    await base44.entities.MessageTemplate.update(template.id, {
      usage_count: (template.usage_count || 0) + 1
    }).catch(() => {});

    // 8. Mark email activity too (if both were requested, the email function already marks it — this is harmless)
    if (email_activity_id) {
      await base44.entities.Activity.update(email_activity_id, {
        outcome: `Meeting link sent (email + WhatsApp) to ${lead.name || cleanPhone}`
      }).catch(() => {});
    }

    console.log(`[sendMeetingLinkWhatsApp] ✅ Sent meet link ${meetLink} to ${cleanPhone} (${lead.name}) — msg_id=${messageId}`);
    return c.json({ data: {
      success: true,
      message_id: messageId,
      sent_to: cleanPhone,
      meet_link: meetLink,
      activity_id: demoActivity.id
    } });
  } catch (error) {
    console.error('[sendMeetingLinkWhatsApp] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};