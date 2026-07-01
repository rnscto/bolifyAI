import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const CONNECTOR_ID = '69e43d430b4b87486b521374';

export default async function checkGoogleCalendarStatus(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { connected: false, error: 'unauthorized' } }, 401);
    }

    // 1) Check the user's own Google Calendar connection
    try {
      const connection = await base44.asServiceRole.connectors.getCurrentAppUserConnection(
        CONNECTOR_ID,
        { userId: user.id }
      );
      if (connection?.accessToken) {
        return c.json({ data: { connected: true, source: 'user' } });
      }
    } catch { /* fall through to shared check */ }

    // 2) Fall back to the shared admin connector (so UI shows "connected via shared")
    try {
      const shared = await base44.asServiceRole.connectors.getConnection('googlecalendar');
      if (shared?.accessToken) {
        return c.json({ data: { connected: true, source: 'shared' } });
      }
    } catch { /* not connected */ }

    return c.json({ data: { connected: false } });
  } catch (error) {
    return c.json({ data: { connected: false, error: error.message } }, 500);
  }

};