import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { client } from "../db/index.ts";

export const analyticsRouter = new Hono();

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "super_secret_bolifyai_key";

analyticsRouter.use("*", jwt({ secret: JWT_SECRET, alg: "HS256" }));

analyticsRouter.get("/overview", async (c) => {
  try {
    const user = c.get("jwtPayload") as any;
    const clientId = user.client_id;
    if (!clientId) return c.json({ error: "Missing client_id" }, 400);

    // Get total calls and minutes
    const callsRes = await client.queryObject(`
      SELECT COUNT(id) as total_calls, COALESCE(SUM(duration_seconds), 0) as total_seconds
      FROM calllog WHERE client_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
    `, [clientId]);
    const totalCalls = Number((callsRes.rows[0] as any).total_calls);
    const totalMinutes = Math.round(Number((callsRes.rows[0] as any).total_seconds) / 60);

    // Get objection handling success rate
    const objectionsRes = await client.queryObject(`
      SELECT 
        COUNT(id) as total_handled,
        SUM(CASE WHEN objection_resolved = true THEN 1 ELSE 0 END) as successful_resolutions
      FROM objectionlog WHERE client_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
    `, [clientId]);
    const totalHandled = Number((objectionsRes.rows[0] as any).total_handled);
    const successfulResolutions = Number((objectionsRes.rows[0] as any).successful_resolutions);
    const objectionSuccessRate = totalHandled > 0 ? Math.round((successfulResolutions / totalHandled) * 100) : 0;

    // Get intent breakdown (from activity table)
    const activitiesRes = await client.queryObject(`
      SELECT type, COUNT(id) as count
      FROM activity WHERE client_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY type
    `, [clientId]);

    const intentBreakdown = activitiesRes.rows.map((r: any) => ({
      name: r.type,
      value: Number(r.count)
    }));

    return c.json({
      success: true,
      overview: {
        totalCalls,
        totalMinutes,
        objectionSuccessRate,
        intentBreakdown
      }
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
