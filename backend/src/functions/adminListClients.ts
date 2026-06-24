import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

export default async function adminListClients(c: any) {
  try {
    const payload = await c.req.json().catch(() => ({}));
    const { action, client_id, data } = payload;

    // TODO: Ideally we should enforce admin JWT auth here. 
    // Since we are migrating from Base44 auth to custom JWT, we rely on middleware.

    if (!action || action === 'list') {
      const clients = await base44.entities.Client.filter({}, "-created_date");
      const users = await base44.entities.User.filter({});
      
      // Map each client to its earliest activation (paid) date
      const activationsRes = await client.queryObject(`
        SELECT client_id, MIN(COALESCE(effective_date, created_date)) as min_date 
        FROM "clientlifecycleevent" 
        WHERE event_type = 'activated'
        GROUP BY client_id
      `);
      
      const activationByClient: Record<string, string> = {};
      for (const row of activationsRes.rows as any[]) {
        activationByClient[row.client_id] = row.min_date;
      }
      
      const enriched = clients.map(c => ({ ...c, activation_date: activationByClient[c.id] || null }));
      return c.json({ data: { clients: enriched, users } });
    }

    if (action === 'create') {
      const newClient = await base44.entities.Client.create(data);
      return c.json({ data: { client: newClient } });
    }

    if (action === 'update' && client_id) {
      await base44.entities.Client.update(client_id, data);
      return c.json({ data: { success: true } });
    }

    if (action === 'delete' && client_id) {
      await base44.entities.Client.delete(client_id);
      return c.json({ data: { success: true } });
    }

    return c.json({ data: { error: 'Invalid action' } }, 400);
  } catch (error: any) {
    console.error('[adminListClients] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
