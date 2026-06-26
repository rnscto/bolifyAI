import { Hono } from "hono";
import { functionRegistry } from "../functions/index.ts";
import { client } from "../db/index.ts";
import { universalAuth } from "../middleware/auth.ts";

export const functionsRouter = new Hono();

// Apply auth to all functions except debug
functionsRouter.use("/:functionName", universalAuth);

functionsRouter.get('/debug_calllog/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const res = await client.queryObject(`SELECT * FROM "calllog" WHERE id = $1`, [id]);
    return c.json({ data: res.rows[0] || null });
  } catch (err: any) {
    return c.json({ error: err.message });
  }
});

functionsRouter.post("/:functionName", async (c) => {
  const functionName = c.req.param("functionName");
  
  const handler = functionRegistry[functionName];
  if (handler) {
    try {
      return await handler(c);
    } catch (err: any) {
      console.error(`[Function Error] ${functionName}:`, err);
      return c.json({ data: { success: false, error: err.message } });
    }
  }

  return c.json({ data: { success: false, error: "Function not implemented" } });
});

