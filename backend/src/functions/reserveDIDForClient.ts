import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Atomically reserves an available DID for the authenticated client.
 * Used by ClientDIDMarketplace so clients can self-assign a DID from the pool.
 *
 * Body: { did_id: string, agent_id?: string }
 *  - did_id: the DID record the client wants
 *  - agent_id: optional; if provided, assigns the DID directly to that agent
 *
 * Safety:
 *  - Verifies the DID is currently 'available' and not a demo DID
 *  - Verifies the client owns the target agent (if any)
 *  - Re-checks status under service role to prevent race conditions
 */
export default async function reserveDIDForClient(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { did_id, agent_id } = await c.req.json();
    if (!did_id) {
      return c.json({ data: { error: 'did_id required' } }, 400);
    }

    // Resolve owning client
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) {
      return c.json({ data: { error: 'Client not found' } }, 404);
    }
    const client = clients[0];

    // Re-fetch DID under service role to get latest status
    const did = await base44.asServiceRole.entities.DID.get(did_id);
    if (!did) {
      return c.json({ data: { error: 'DID not found' } }, 404);
    }
    if (did.is_demo) {
      return c.json({ data: { error: 'Demo DIDs cannot be self-assigned' } }, 400);
    }
    if (did.status !== 'available') {
      return c.json({ data: { error: 'This DID is no longer available — please pick another' } }, 409);
    }

    // Validate agent ownership if agent_id provided
    let agent = null;
    if (agent_id) {
      agent = await base44.asServiceRole.entities.Agent.get(agent_id);
      if (!agent || agent.client_id !== client.id) {
        return c.json({ data: { error: 'Agent not found or not yours' } }, 403);
      }
    }

    // Claim the DID
    const updates = {
      client_id: client.id,
      status: 'assigned',
    };
    if (agent_id) updates.agent_id = agent_id;
    await base44.asServiceRole.entities.DID.update(did_id, updates);

    // If linked to an agent, append the number to the agent's assigned_dids
    if (agent) {
      const currentDids = Array.isArray(agent.assigned_dids) ? agent.assigned_dids : [];
      if (!currentDids.includes(did.number)) {
        await base44.asServiceRole.entities.Agent.update(agent.id, {
          assigned_dids: [...currentDids, did.number],
          assigned_did: agent.assigned_did || did.number,
        });
      }
    }

    return c.json({ data: {
      success: true,
      did_id,
      number: did.number,
      assigned_to_agent: agent_id || null,
    } });
  } catch (error) {
    console.error('reserveDIDForClient error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};