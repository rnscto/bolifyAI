import { Hono } from "hono";
import { functionRegistry } from "../functions/index.ts";

export const functionsRouter = new Hono();

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

