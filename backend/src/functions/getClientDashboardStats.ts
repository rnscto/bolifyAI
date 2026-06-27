import { client } from "../db/index.ts";

export default async function getClientDashboardStats(c: any) {
  try {
    const payload = await c.req.json().catch(() => ({}));
    const { client_id } = payload;
    const user = c.get("jwtPayload");

    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    if (!['admin', 'master_admin', 'reseller', 'master_reseller'].includes(user.role) && user.client_id !== client_id) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    if (!client_id) {
      return c.json({ data: { error: 'client_id is required' } }, 400);
    }

    const [
      leadsRes,
      callsRes,
      callsTodayRes,
      agentsRes,
      activitiesRes,
      upcomingRes,
      didsRes,
      campaignsRes
    ] = await Promise.all([
      client.queryObject(`SELECT COUNT(id) FROM "lead" WHERE client_id = $1`, [client_id]),
      client.queryObject(
        `SELECT COUNT(id), COALESCE(SUM(duration), 0) as total_duration FROM "calllog" WHERE client_id = $1`, 
        [client_id]
      ),
      client.queryObject(
        `SELECT COUNT(id) FROM "calllog" WHERE client_id = $1 AND created_at >= CURRENT_DATE`, 
        [client_id]
      ),
      client.queryObject(`SELECT COUNT(id) FROM "agent" WHERE client_id = $1`, [client_id]),
      client.queryObject(`SELECT COUNT(id) FROM "activity" WHERE client_id = $1`, [client_id]),
      client.queryObject(
        `SELECT COUNT(id) FROM "activity" WHERE client_id = $1 AND status = 'scheduled' AND scheduled_date > NOW()::text`, 
        [client_id]
      ),
      client.queryObject(`SELECT COUNT(id) FROM "did" WHERE client_id = $1`, [client_id]),
      client.queryObject(`SELECT COUNT(id) FROM "campaign" WHERE client_id = $1`, [client_id])
    ]);

    return c.json({
      data: {
        success: true,
        stats: {
          totalLeads: parseInt((leadsRes.rows[0] as any)?.count || '0', 10),
          totalCalls: parseInt((callsRes.rows[0] as any)?.count || '0', 10),
          callsToday: parseInt((callsTodayRes.rows[0] as any)?.count || '0', 10),
          totalDuration: parseInt((callsRes.rows[0] as any)?.total_duration || '0', 10),
          totalAgents: parseInt((agentsRes.rows[0] as any)?.count || '0', 10),
          activeAgents: parseInt((agentsRes.rows[0] as any)?.count || '0', 10),
          totalActivities: parseInt((activitiesRes.rows[0] as any)?.count || '0', 10),
          upcomingActivities: parseInt((upcomingRes.rows[0] as any)?.count || '0', 10),
          totalDids: parseInt((didsRes.rows[0] as any)?.count || '0', 10),
          totalCampaigns: parseInt((campaignsRes.rows[0] as any)?.count || '0', 10),
        }
      }
    });
  } catch (error: any) {
    console.error('[getClientDashboardStats] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
