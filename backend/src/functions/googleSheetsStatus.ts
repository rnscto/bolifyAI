import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const CONNECTOR_ID = '69e9ee7e358cda2752c9b54e';

// Lightweight probe: returns { connected: true/false } for the current user.
export default async function googleSheetsStatus(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { connected: false, reason: 'unauthorized' } });

    try {
      const conn = await base44.asServiceRole.connectors.getCurrentAppUserConnection(CONNECTOR_ID);
      return c.json({ data: { connected: !!conn?.accessToken } });
    } catch {
      return c.json({ data: { connected: false } });
    }
  } catch (error) {
    return c.json({ data: { connected: false, error: error.message } });
  }

};