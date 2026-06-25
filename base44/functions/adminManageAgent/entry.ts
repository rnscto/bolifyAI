import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

export default async function adminManageAgent(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { action, agent_id, data } = body;

    // Create agent
    if (action === 'create') {
      const agent = await base44.asServiceRole.entities.Agent.create(data);
      return Response.json({ agent });
    }

    // Update agent
    if (action === 'update' && agent_id) {
      await base44.asServiceRole.entities.Agent.update(agent_id, data);
      return Response.json({ success: true });
    }

    // Delete agent
    if (action === 'delete' && agent_id) {
      await base44.asServiceRole.entities.Agent.delete(agent_id);
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('[adminManageAgent] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
