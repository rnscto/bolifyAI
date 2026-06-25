import { Hono } from "npm:hono@4.12.27";
import { logger } from "npm:hono@4.12.27/logger";
import { cors } from "npm:hono@4.12.27/cors";

const app = new Hono();
app.use("*", logger());
app.use("*", cors());
app.get("*", (c) => c.text("Hello"));

export default { port: 8000, fetch: app.fetch };
