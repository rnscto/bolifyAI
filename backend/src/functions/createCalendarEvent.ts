import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Activity types that should auto-create a calendar event
const SYNCABLE_TYPES = ['demo', 'meeting', 'visit', 'callback', 'appointment'];

// Activity types that should include a Google Meet link (virtual meetings)
const MEET_TYPES = ['demo', 'meeting'];

const buildEventDescription = (activity, lead) => {
  const lines = [];
  if (activity.description) lines.push(activity.description);
  if (lead) {
    lines.push('');
    lines.push('— Lead Details —');
    if (lead.name) lines.push(`Name: ${lead.name}`);
    if (lead.phone) lines.push(`Phone: ${lead.phone}`);
    if (lead.email) lines.push(`Email: ${lead.email}`);
    if (lead.company) lines.push(`Company: ${lead.company}`);
    if (lead.notes) lines.push(`Notes: ${lead.notes}`);
  }
  if (activity.notes) {
    lines.push('');
    lines.push('— Notes —');
    lines.push(activity.notes);
  }
  lines.push('');
  lines.push('Scheduled via VaaniAI CRM');
  return lines.join('\n');
};

export default async function createCalendarEvent(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;

    // This function is called from an entity automation — read the trigger payload.
    // When invoked manually it can also accept { activity_id } directly.
    const body = await c.req.json().catch(() => ({}));
    const activityId = body?.event?.entity_id || body?.data?.id || body?.activity_id;
    const eventActivity = body?.data || null;

    if (!activityId) {
      return c.json({ data: { error: 'Missing activity_id' } }, 400);
    }

    // Fetch activity (fallback if payload was too large)
    const activity = eventActivity?.id
      ? eventActivity
      : await base44.asServiceRole.entities.Activity.get(activityId);

    if (!activity) {
      return c.json({ data: { error: 'Activity not found' } }, 404);
    }

    // Skip if not a syncable type
    if (!SYNCABLE_TYPES.includes(activity.type)) {
      console.log(`Skipping activity ${activityId}: type "${activity.type}" not syncable`);
      return c.json({ data: { skipped: true, reason: 'type_not_syncable' } });
    }

    // Skip if already synced
    if (activity.calendar_synced && activity.google_event_id) {
      console.log(`Activity ${activityId} already synced to calendar`);
      return c.json({ data: { skipped: true, reason: 'already_synced', event_id: activity.google_event_id } });
    }

    // Skip if no scheduled_date
    if (!activity.scheduled_date) {
      return c.json({ data: { skipped: true, reason: 'no_scheduled_date' } });
    }

    // Resolve an access token: prefer the client owner's per-user connection
    // (each client connects their own Google Calendar), fall back to the
    // shared admin connector if the client hasn't connected.
    const CONNECTOR_ID = '69e43d430b4b87486b521374'; // app user connector id (Google Calendar)
    let accessToken = null;
    let tokenSource = '';

    // 1) Try the client owner's app-user connection
    if (activity.client_id) {
      try {
        const ownerClient = await base44.asServiceRole.entities.Client.get(activity.client_id);
        const ownerUserId = ownerClient?.user_id;
        if (ownerUserId) {
          try {
            const conn = await base44.asServiceRole.connectors.getCurrentAppUserConnection(
              CONNECTOR_ID,
              { userId: ownerUserId }
            );
            if (conn?.accessToken) {
              accessToken = conn.accessToken;
              tokenSource = 'client_user';
            }
          } catch (innerErr) {
            console.log(`[createCalendarEvent] per-user connection not found for user ${ownerUserId}: ${innerErr.message}`);
          }
        }
      } catch (err) {
        console.log('[createCalendarEvent] Client lookup failed:', err.message);
      }
    }

    // 2) Fall back to the shared admin connector
    if (!accessToken) {
      try {
        const connection = await base44.asServiceRole.connectors.getConnection('googlecalendar');
        if (connection?.accessToken) {
          accessToken = connection.accessToken;
          tokenSource = 'shared_admin';
        }
      } catch (err) {
        console.log('Google Calendar shared connector not authorized:', err.message);
      }
    }

    if (!accessToken) {
      await base44.asServiceRole.entities.Activity.update(activityId, {
        calendar_sync_error: 'Google Calendar not connected. Connect your Google account in Settings → Integrations, or ask the admin to authorize the shared Google Calendar connector.'
      });
      return c.json({ data: { skipped: true, reason: 'not_connected' } });
    }

    console.log(`[createCalendarEvent] Using ${tokenSource} Google token for activity ${activityId}`);

    // Fetch the lead for attendee + description
    let lead = null;
    if (activity.lead_id) {
      try {
        lead = await base44.asServiceRole.entities.Lead.get(activity.lead_id);
      } catch { /* lead missing — continue without it */ }
    }

    // Fetch the client admin for attendee list
    let client = null;
    if (activity.client_id) {
      try {
        client = await base44.asServiceRole.entities.Client.get(activity.client_id);
      } catch { /* client missing — continue without it */ }
    }

    // Compute start/end times
    const startTime = new Date(activity.scheduled_date);
    const durationMinutes = activity.duration_minutes || 30;
    const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

    // Build attendees list — invite the lead, the client admin, AND the connector owner
    // (the Google account that authorized the shared connector). The connector owner is
    // the calendar owner and therefore the Meet HOST — they MUST be on the attendee list
    // so they see the event on their calendar and can start the Meet. Without them,
    // both lead and client are guests and Google Meet blocks the meeting from starting.
    const attendees = [];
    if (lead?.email) {
      attendees.push({ email: lead.email, displayName: lead.name || undefined });
    }
    if (client?.email && client.email !== lead?.email) {
      attendees.push({ email: client.email, displayName: client.company_name || undefined });
    }

    // Fetch the connector owner email (Meet host) from Google UserInfo
    let connectorOwnerEmail = '';
    try {
      const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (uiRes.ok) {
        const ui = await uiRes.json();
        connectorOwnerEmail = (ui.email || '').toLowerCase();
      }
    } catch (e) { console.log('UserInfo fetch failed:', e.message); }

    if (connectorOwnerEmail
        && connectorOwnerEmail !== (lead?.email || '').toLowerCase()
        && connectorOwnerEmail !== (client?.email || '').toLowerCase()) {
      attendees.push({ email: connectorOwnerEmail, displayName: 'Host (VaaniAI)', responseStatus: 'accepted' });
    }

    // Compose event title
    const leadName = lead?.name || lead?.phone || 'Lead';
    const typeLabel = activity.type.charAt(0).toUpperCase() + activity.type.slice(1);
    const title = activity.title || `${typeLabel} with ${leadName}`;

    // Build the Google Calendar event body
    const eventBody = {
      summary: title,
      description: buildEventDescription(activity, lead),
      start: { dateTime: startTime.toISOString() },
      end: { dateTime: endTime.toISOString() },
      attendees,
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 10 }
        ]
      }
    };

    // Add Google Meet conferencing for virtual types
    const includeMeet = MEET_TYPES.includes(activity.type);
    if (includeMeet) {
      eventBody.conferenceData = {
        createRequest: {
          requestId: `vaaniai-${activityId}-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      };
    }

    // Create the event on the sales rep's primary calendar
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('sendUpdates', 'all'); // send invite emails to attendees
    if (includeMeet) url.searchParams.set('conferenceDataVersion', '1');

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventBody)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Google Calendar API error:', res.status, errText);
      await base44.asServiceRole.entities.Activity.update(activityId, {
        calendar_sync_error: `API error ${res.status}: ${errText.slice(0, 300)}`
      });
      return c.json({ data: { error: 'google_api_error', status: res.status, details: errText } }, 500);
    }

    const event = await res.json();

    // Extract Meet link if present
    const meetLink = event.conferenceData?.entryPoints?.find(
      (ep) => ep.entryPointType === 'video'
    )?.uri || '';

    // Update the activity with sync results
    await base44.asServiceRole.entities.Activity.update(activityId, {
      google_event_id: event.id,
      google_calendar_link: event.htmlLink || '',
      meet_link: meetLink,
      calendar_synced: true,
      calendar_sync_error: ''
    });

    return c.json({ data: {
      success: true,
      event_id: event.id,
      html_link: event.htmlLink,
      meet_link: meetLink,
      attendees_invited: attendees.length
    } });
  } catch (error) {
    console.error('createCalendarEvent error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};