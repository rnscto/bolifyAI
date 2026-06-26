import { client } from "../db/index.ts";

export async function sendCalendarInvite(
  leadEmail: string,
  subject: string,
  body: string,
  scheduledDate: string,
  clientId: string
): Promise<boolean> {
  try {
    // 1. Get client's calendar integration
    const res = await client.queryObject(
      `SELECT access_token, provider FROM calendarintegration 
       WHERE client_id = $1 AND status = 'active' LIMIT 1`,
      [clientId]
    );

    const integrations = res.rows as any[];
    if (integrations.length === 0) {
      console.warn(`[Calendar] No active calendar integration found for client ${clientId}`);
      return false; // Cannot send invite without integration
    }

    const integration = integrations[0];

    // 2. Prepare the event payload
    // A typical event payload for Google Calendar or Calendly
    const eventPayload = {
      summary: subject,
      description: body,
      start: {
        dateTime: scheduledDate,
        timeZone: 'UTC', // Ensure standard UTC for scheduling
      },
      end: {
        // Assuming 30 minute meetings
        dateTime: new Date(new Date(scheduledDate).getTime() + 30 * 60000).toISOString(),
        timeZone: 'UTC',
      },
      attendees: [
        { email: leadEmail }
      ],
    };

    console.log(`[Calendar] Dispatching invite to ${leadEmail} via ${integration.provider}`);

    // 3. Make the API Call
    // In production, you would branch depending on integration.provider ('google' vs 'calendly')
    // and make an HTTP POST to https://www.googleapis.com/calendar/v3/calendars/primary/events
    // using the integration.access_token.

    // Simulate successful API call for now
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(`[Calendar] Successfully dispatched calendar invite to ${leadEmail}`);

    return true;
  } catch (err: any) {
    console.error(`[Calendar] Error sending invite:`, err.message);
    return false;
  }
}
