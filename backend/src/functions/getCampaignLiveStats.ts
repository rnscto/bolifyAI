import { client } from "../db/index.ts";

export default async function getCampaignLiveStats(c: any) {
  try {
    const payload = await c.req.json().catch(() => ({}));
    const { client_id } = payload;
    const user = c.get("jwtPayload");

    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (!['admin', 'master_admin', 'reseller', 'master_reseller'].includes(user.role) && user.client_id !== client_id) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }
    if (!client_id) return c.json({ data: { error: 'client_id is required' } }, 400);

    // 1. Fetch aggregated stats per campaign
    const statsRes = await client.queryObject(
      `SELECT 
        campaign_id,
        COUNT(id) as total_leads,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as calls_completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as calls_failed,
        SUM(CASE WHEN outcome = 'neutral' THEN 1 ELSE 0 END) as o_neutral,
        SUM(CASE WHEN outcome = 'interested' THEN 1 ELSE 0 END) as o_interested,
        SUM(CASE WHEN outcome = 'not_interested' THEN 1 ELSE 0 END) as o_not_interested,
        SUM(CASE WHEN outcome = 'not_answered' THEN 1 ELSE 0 END) as o_not_answered,
        SUM(CASE WHEN outcome = 'callback' THEN 1 ELSE 0 END) as o_callback,
        SUM(CASE WHEN outcome = 'converted' THEN 1 ELSE 0 END) as o_converted,
        SUM(CASE WHEN outcome = 'do_not_call' THEN 1 ELSE 0 END) as o_do_not_call
       FROM "campaignlead" 
       WHERE client_id = $1
       GROUP BY campaign_id`,
      [client_id]
    );

    const statsMap: Record<string, any> = {};
    statsRes.rows.forEach((row: any) => {
      statsMap[row.campaign_id] = {
        total_leads: parseInt(row.total_leads, 10),
        calls_completed: parseInt(row.calls_completed, 10),
        calls_failed: parseInt(row.calls_failed, 10),
        outcomes_summary: {
          neutral: parseInt(row.o_neutral, 10),
          interested: parseInt(row.o_interested, 10),
          not_interested: parseInt(row.o_not_interested, 10),
          not_answered: parseInt(row.o_not_answered, 10),
          callback: parseInt(row.o_callback, 10),
          converted: parseInt(row.o_converted, 10),
          do_not_call: parseInt(row.o_do_not_call, 10)
        }
      };
    });

    return c.json({
      data: {
        success: true,
        stats: statsMap
      }
    });

  } catch (error: any) {
    console.error('[getCampaignLiveStats] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
