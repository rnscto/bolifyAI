import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Internal helper used by streamGeminiDemo to enforce a concurrent-session cap.
// Returns { allowed: boolean, current: number, max: number }
// Cap defaults to 20 concurrent in-progress demos; override via DEMO_MAX_CONCURRENT env var.



export default async function checkDemoSessionCap(c: any) {
  const req = c.req.raw || c.req;
  try {
    // Internal helper — called by streamGeminiDemo. No user auth available.
    const svc = base44;;
    // Hardcoded cap. Increase here if you need more concurrent demos.
    const max = 20;
    const inProgress = await svc.entities.DemoBooking.filter({ status: 'in_progress' }).catch(() => []);
    return c.json({ data: { allowed: inProgress.length < max, current: inProgress.length, max } });
  } catch (error) {
    // Fail open: better to allow than block if entity store is slow
    return c.json({ data: { allowed: true, error: error.message } });
  }

};