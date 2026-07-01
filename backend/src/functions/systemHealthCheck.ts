import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Admin-only system health snapshot.
// Returns: configured-secret presence for key services, a live ping to Smartflo auth,
// recent ErrorLog counts, and CallLog-derived voice-call health metrics (last 24h).


function checkSecrets(names) {
  const out = {};
  for (const n of names) {
    const v = Deno.env.get(n);
    out[n] = { set: !!v };
  }
  return out;
}

export default async function systemHealthCheck(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }
    const svc = base44.asServiceRole;
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    // ─── Service / secret presence checks ───
    const services = [
      { key: 'smartflo', label: 'Smartflo (Voice)', secrets: ['SMARTFLO_EMAIL', 'SMARTFLO_PASSWORD'] },
      { key: 'twilio', label: 'Twilio', secrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] },
      { key: 'azure_openai', label: 'Azure OpenAI', secrets: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_DEPLOYMENT'] },
      { key: 'azure_realtime', label: 'Azure Realtime', secrets: ['AZURE_REALTIME_ENDPOINT_GA', 'AZURE_REALTIME_KEY_GA'] },
      { key: 'gemini', label: 'Gemini Live', secrets: ['GEMINI_API_KEY', 'GEMINI_API_KEY_PAID'] },
      { key: 'azure_storage', label: 'Azure Storage', secrets: ['AZURE_STORAGE_CONNECTION_STRING'] },
      { key: 'stripe', label: 'Stripe', secrets: ['STRIPE_SECRET_KEY'] },
      { key: 'cashfree', label: 'Cashfree', secrets: ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY'] },
      { key: 'telegram', label: 'Telegram Bot', secrets: ['TELEGRAM_BOT_TOKEN'] },
      { key: 'email', label: 'Email (ACS SMTP)', secrets: ['ACS_SMTP_HOST', 'ACS_SMTP_USERNAME'] },
    ];
    const serviceStatus = services.map((s) => {
      const sec = checkSecrets(s.secrets);
      const allSet = Object.values(sec).every((x) => x.set);
      const anySet = Object.values(sec).some((x) => x.set);
      return {
        key: s.key,
        label: s.label,
        status: allSet ? 'ok' : anySet ? 'partial' : 'missing',
        secrets: sec,
      };
    });

    // ─── Live Smartflo auth ping ───
    let smartfloPing = { status: 'unknown' };
    try {
      const email = Deno.env.get('SMARTFLO_EMAIL');
      const password = Deno.env.get('SMARTFLO_PASSWORD');
      if (email && password) {
        const t0 = Date.now();
        const r = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const j = await r.json().catch(() => ({}));
        smartfloPing = {
          status: r.ok && j.access_token ? 'ok' : 'failed',
          latency_ms: Date.now() - t0,
          http: r.status,
        };
      } else {
        smartfloPing = { status: 'missing', latency_ms: 0 };
      }
    } catch (e) {
      smartfloPing = { status: 'failed', error: e.message };
    }

    // ─── Error log counts (last 24h) ───
    const recentErrors = await svc.entities.ErrorLog.filter({ created_date: { $gte: dayAgo } }, '-created_date', 200).catch(() => []);
    const errorsBySeverity = { info: 0, warning: 0, error: 0, critical: 0 };
    const errorsByFunction = {};
    for (const e of recentErrors) {
      errorsBySeverity[e.severity || 'error'] = (errorsBySeverity[e.severity || 'error'] || 0) + 1;
      if (!e.resolved) errorsByFunction[e.function_name] = (errorsByFunction[e.function_name] || 0) + 1;
    }
    const topErrorFunctions = Object.entries(errorsByFunction)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([fn, count]) => ({ function_name: fn, count }));

    // ─── Voice-call health (last 24h) ───
    const recentCalls = await svc.entities.CallLog.filter({ created_date: { $gte: dayAgo } }, '-created_date', 500).catch(() => []);
    const callStats = {
      total: recentCalls.length,
      completed: 0,
      failed: 0,
      no_answer: 0,
      in_progress: 0,
      other: 0,
      total_duration: 0,
      duration_count: 0,
    };
    const byEngine = {};
    for (const c of recentCalls) {
      const st = c.status || 'other';
      if (st === 'completed') callStats.completed++;
      else if (st === 'failed') callStats.failed++;
      else if (st === 'no_answer') callStats.no_answer++;
      else if (['ringing', 'initiated', 'answered'].includes(st)) callStats.in_progress++;
      else callStats.other++;
      if (typeof c.duration === 'number' && c.duration > 0) {
        callStats.total_duration += c.duration;
        callStats.duration_count++;
      }
      const eng = c.agent_config_cache?.persona?.voice_engine || c.direction || 'unknown';
      byEngine[eng] = (byEngine[eng] || 0) + 1;
    }
    callStats.avg_duration = callStats.duration_count ? Math.round(callStats.total_duration / callStats.duration_count) : 0;
    callStats.success_rate = callStats.total ? Math.round((callStats.completed / callStats.total) * 100) : 0;

    return c.json({ data: {
      generated_at: new Date().toISOString(),
      services: serviceStatus,
      smartflo_ping: smartfloPing,
      errors: {
        last_24h: recentErrors.length,
        unresolved: recentErrors.filter((e) => !e.resolved).length,
        by_severity: errorsBySeverity,
        top_functions: topErrorFunctions,
      },
      calls: { ...callStats, by_engine: byEngine },
    } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};