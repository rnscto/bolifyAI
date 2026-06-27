import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

export default async function adminListClients(c: any) {
  try {
    const payload = await c.req.json().catch(() => ({}));
    const { action, client_id, data } = payload;

    const user = c.get("jwtPayload");
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }
    
    // Determine filter conditions based on role
    const isReseller = user.role === 'reseller' || user.role === 'master_reseller';

    if (!action || action === 'list') {
      let clients;
      if (isReseller) {
        const res = await client.queryObject(`SELECT * FROM "client" WHERE id::text = $1 OR upline_id = $1 ORDER BY created_at DESC`, [user.client_id]);
        clients = res.rows;
      } else {
        clients = await base44.entities.Client.filter({}, "-created_at", 1000);
      }
      const users = await base44.entities.User.filter({}, "-created_at", 2000);
      
      // Map each client to its earliest activation (paid) date
      const activationsRes = await client.queryObject(`
        SELECT client_id, MIN(COALESCE(effective_date::timestamptz, created_at)) as min_date 
        FROM "clientlifecycleevent" 
        WHERE event_type = 'activated'
        GROUP BY client_id
      `);
      
      const activationByClient: Record<string, string> = {};
      for (const row of activationsRes.rows as any[]) {
        activationByClient[row.client_id] = row.min_date;
      }
      
      const enriched = clients.map((c: any) => ({ ...c, activation_date: activationByClient[c.id] || null }));
      return c.json({ data: { clients: enriched, users } });
    }

    if (action === 'create') {
      if (isReseller) {
        data.upline_id = user.client_id;
      }
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

    if (action === 'promote_user' && payload.user_id && payload.role) {
      // Only master_admin can promote users
      if (user.role !== 'master_admin') {
         return c.json({ data: { error: 'Forbidden. Only Master Admin can change roles.' } }, 403);
      }
      const allowedRoles = ['reseller', 'master_reseller', 'admin', 'user'];
      if (!allowedRoles.includes(payload.role)) {
         return c.json({ data: { error: 'Invalid role' } }, 400);
      }
      await base44.entities.User.update(payload.user_id, { role: payload.role });
      return c.json({ data: { success: true } });
    }

    return c.json({ data: { error: 'Invalid action' } }, 400);
  } catch (error: any) {
    console.error('[adminListClients] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
