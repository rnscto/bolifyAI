import { client } from "../db/index.ts";

export default async function getAgentDashboardStats(c: any) {
  try {
    const payload = await c.req.json().catch(() => ({}));
    const { client_id, agent_id } = payload;
    const user = c.get("jwtPayload");

    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    if (!['admin', 'master_admin', 'reseller', 'master_reseller'].includes(user.role) && user.client_id !== client_id) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    if (!client_id || !agent_id) {
      return c.json({ data: { error: 'client_id and agent_id are required' } }, 400);
    }

    // Verify agent belongs to client
    const agentRes = await client.queryObject(`SELECT id FROM "agent" WHERE id = $1 AND client_id = $2`, [agent_id, client_id]);
    if (agentRes.rows.length === 0) {
      return c.json({ data: { error: 'Agent not found' } }, 404);
    }

    const [
      callsRes,
      completedCallsRes,
      campaignsRes,
      leadsRes,
      interestedLeadsRes,
      totalOutcomesRes,
      avgScoreRes
    ] = await Promise.all([
      client.queryObject(
        `SELECT COUNT(id), COALESCE(SUM(duration), 0) as total_duration FROM "calllog" WHERE agent_id = $1`, 
        [agent_id]
      ),
      client.queryObject(
        `SELECT COUNT(id) FROM "calllog" WHERE agent_id = $1 AND status = 'completed'`, 
        [agent_id]
      ),
      client.queryObject(`SELECT COUNT(id) FROM "campaign" WHERE agent_id = $1`, [agent_id]),
      client.queryObject(
        `SELECT COUNT(id) FROM "lead" WHERE assigned_to = $1`, 
        [agent_id]
      ),
      client.queryObject(
        `SELECT COUNT(cl.id) FROM "campaignlead" cl JOIN "campaign" c ON cl.campaign_id = c.id WHERE c.agent_id = $1 AND cl.outcome = 'interested'`, 
        [agent_id]
      ),
      client.queryObject(
        `SELECT COUNT(cl.id) FROM "campaignlead" cl JOIN "campaign" c ON cl.campaign_id = c.id WHERE c.agent_id = $1 AND cl.outcome IS NOT NULL`, 
        [agent_id]
      ),
      client.queryObject(
        `SELECT AVG(score) as avg_score FROM "lead" WHERE assigned_to = $1`, 
        [agent_id]
      )
    ]);

    return c.json({
      data: {
        success: true,
        stats: {
          totalCalls: parseInt((callsRes.rows[0] as any)?.count || '0', 10),
          completedCalls: parseInt((completedCallsRes.rows[0] as any)?.count || '0', 10),
          totalDuration: parseInt((callsRes.rows[0] as any)?.total_duration || '0', 10),
          totalCampaigns: parseInt((campaignsRes.rows[0] as any)?.count || '0', 10),
          totalLeads: parseInt((leadsRes.rows[0] as any)?.count || '0', 10),
          interestedLeads: parseInt((interestedLeadsRes.rows[0] as any)?.count || '0', 10),
          totalOutcomes: parseInt((totalOutcomesRes.rows[0] as any)?.count || '0', 10),
          avgLeadScore: Math.round(parseFloat((avgScoreRes.rows[0] as any)?.avg_score || '0'))
        }
      }
    });
  } catch (error: any) {
    console.error('[getAgentDashboardStats] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
