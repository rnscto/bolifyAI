import { client } from "../db/index.ts";

export default async function getClientAnalyticsStats(c: any) {
  try {
    const payload = await c.req.json().catch(() => ({}));
    const { client_id, period = '30' } = payload;
    const user = c.get("jwtPayload");

    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (!['admin', 'master_admin', 'reseller', 'master_reseller'].includes(user.role) && user.client_id !== client_id) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }
    if (!client_id) return c.json({ data: { error: 'client_id is required' } }, 400);

    // Date cutoff
    let dateFilter = "";
    const args: any[] = [client_id];
    if (period !== 'all') {
      const days = parseInt(period, 10);
      if (!isNaN(days)) {
        dateFilter = `AND created_at >= NOW() - INTERVAL '${days} days'`;
      }
    }

    // 1. Calls Overview
    const callsQuery = await client.queryObject<any>(
      `SELECT 
        COUNT(id) as total_calls,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_calls,
        SUM(CASE WHEN status IN ('failed', 'no_answer') THEN 1 ELSE 0 END) as failed_calls,
        SUM(CASE WHEN status = 'completed' THEN duration ELSE 0 END) as total_duration,
        SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound_calls,
        SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound_calls
       FROM "calllog" WHERE client_id = $1 ${dateFilter}`, 
      args
    );
    const row = callsQuery.rows[0];
    const totalCalls = parseInt(row.total_calls || '0', 10);
    const completedCalls = parseInt(row.completed_calls || '0', 10);
    const failedCalls = parseInt(row.failed_calls || '0', 10);
    const totalDuration = parseInt(row.total_duration || '0', 10);
    const avgDuration = completedCalls > 0 ? Math.round(totalDuration / completedCalls) : 0;
    const connectRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0;

    // Direction Data
    const directionData = [
      { name: 'Outbound', value: parseInt(row.outbound_calls || '0', 10), color: '#22c55e' },
      { name: 'Inbound', value: parseInt(row.inbound_calls || '0', 10), color: '#3b82f6' }
    ].filter(d => d.value > 0);

    // 2. Calls By Day
    const callsByDayRes = await client.queryObject<any>(
      `SELECT DATE(created_at) as date, COUNT(id) as count FROM "calllog" WHERE client_id = $1 ${dateFilter} GROUP BY DATE(created_at) ORDER BY date ASC`,
      args
    );
    const dailyData = callsByDayRes.rows.map(r => ({
      date: new Date(r.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      calls: parseInt(r.count, 10)
    }));

    // 3. Status Breakdown
    const statusRes = await client.queryObject<any>(
      `SELECT status, COUNT(id) as count FROM "calllog" WHERE client_id = $1 ${dateFilter} GROUP BY status`,
      args
    );
    const statusData = statusRes.rows.map(r => ({
      name: r.status,
      value: parseInt(r.count, 10)
    }));

    // 4. Calls by Hour
    const hourRes = await client.queryObject<any>(
      `SELECT EXTRACT(HOUR FROM call_start_time::timestamp) as hour, COUNT(id) as count 
       FROM "calllog" 
       WHERE client_id = $1 AND call_start_time IS NOT NULL ${dateFilter} 
       GROUP BY hour ORDER BY hour ASC`,
      args
    );
    const hourlyData = hourRes.rows.map(r => ({
      hour: `${String(r.hour).padStart(2, '0')}:00`,
      calls: parseInt(r.count, 10)
    }));

    // 5. Lead Funnel (All Time, or filter by date?) Analytics UI usually filters all leads.
    let leadDateFilter = "";
    if (period !== 'all') {
      const days = parseInt(period, 10);
      leadDateFilter = `AND created_at >= NOW() - INTERVAL '${days} days'`;
    }
    const leadFunnelRes = await client.queryObject<any>(
      `SELECT status, COUNT(id) as count FROM "lead" WHERE client_id = $1 ${leadDateFilter} GROUP BY status`,
      args
    );
    const leadStatusCounts: any = {};
    leadFunnelRes.rows.forEach(r => { leadStatusCounts[r.status] = parseInt(r.count, 10); });
    
    const funnelOrder = ['new', 'contacted', 'interested', 'callback', 'converted', 'not_interested', 'do_not_call'];
    const funnelData = funnelOrder
      .filter(s => leadStatusCounts[s])
      .map(s => ({ name: s.replace(/_/g, ' '), value: leadStatusCounts[s] }));

    // 6. Campaign Performance
    const campaignRes = await client.queryObject<any>(
      `SELECT name, calls_completed, calls_failed FROM "campaign" WHERE client_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [client_id]
    );
    const campaignData = campaignRes.rows.map(r => ({
      name: r.name?.substring(0, 15) || 'Unnamed',
      completed: parseInt(r.calls_completed || '0', 10),
      failed: parseInt(r.calls_failed || '0', 10)
    }));

    // 7. Advanced Metrics (Mocked for now, can be extracted from AI tags in CallLog)
    const advancedMetrics = {
      objectionSuccessRate: 68,
      intentBreakdown: [
        { name: 'Booked Demo', value: 42 },
        { name: 'Requested Email', value: 89 },
        { name: 'Pricing Query', value: 156 },
        { name: 'Reschedule', value: 24 }
      ]
    };

    return c.json({
      data: {
        success: true,
        stats: {
          totalCalls,
          completedCalls,
          failedCalls,
          avgDuration,
          connectRate,
          dailyData,
          statusData,
          directionData,
          hourlyData,
          funnelData,
          campaignData,
          advancedMetrics
        }
      }
    });

  } catch (error: any) {
    console.error('[getClientAnalyticsStats] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
