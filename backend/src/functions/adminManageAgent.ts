import { base44ORM as base44 } from "../db/orm.ts";

export default async function adminManageAgent(c: any) {
  try {
    const payload = await c.req.json().catch(() => ({}));
    const { action, agent_id, data } = payload;

    const user = c.get("jwtPayload");
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }
    const adminRoles = ['admin', 'master_admin', 'reseller', 'master_reseller'];
    if (!adminRoles.includes(user.role)) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    if (action === 'create') {
      const newAgent = await base44.entities.Agent.create(data);
      return c.json({ data: { agent: newAgent } });
    }

    if (action === 'update' && agent_id) {
      await base44.entities.Agent.update(agent_id, data);
      return c.json({ data: { success: true } });
    }

    if (action === 'delete' && agent_id) {
      await base44.entities.Agent.delete(agent_id);
      return c.json({ data: { success: true } });
    }

    return c.json({ data: { error: 'Invalid action' } }, 400);
  } catch (error: any) {
    console.error('[adminManageAgent] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
