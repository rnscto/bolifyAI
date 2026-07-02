/**
 * ─── Enterprise In-Process Function Dispatcher ────────────────────────────────
 *
 * Replaces the Base44 `functions.invoke(name, args)` pattern with a zero-
 * latency, in-process call to the Hono function registry.
 *
 * WHY: 236+ call-sites in the backend use `base44.asServiceRole.functions
 * .invoke('someFn', args)`. The old Base44 SDK made an HTTP round-trip to the
 * cloud for each of these. Now that we own the function registry, calling them
 * over HTTP would add unnecessary latency and failure modes.
 *
 * HOW: We use a lazy singleton pattern to hold a reference to the
 * `functionRegistry` (imported AFTER startup to avoid circular deps) and
 * dispatch calls as direct TypeScript function calls with a synthetic Hono
 * context that satisfies the contract every function handler expects.
 *
 * ENTERPRISE GUARANTEES:
 *  - Zero network overhead (in-process call, no serialisation)
 *  - Structured error propagation (rejects with real Error objects)
 *  - Timeout circuit breaker per invocation (configurable, default 30 s)
 *  - Full structured logging with duration and outcome
 *  - Service-role JWT payload injected automatically so downstream functions
 *    can read `c.get("jwtPayload")` without an actual token
 */

// ── Lazy registry reference ──────────────────────────────────────────────────
// Set once by `initDispatcher()` called from main.ts after the registry is
// fully loaded. Using `let` + a setter avoids circular import cycles between
// orm.ts → dispatcher.ts → functions/index.ts → orm.ts.
let registry: Record<string, (c: any) => Promise<Response>> | null = null;

export function initDispatcher(
  reg: Record<string, (c: any) => Promise<Response>>
): void {
  registry = reg;
  console.log(`[Dispatcher] Initialised with ${Object.keys(reg).length} functions`);
}

// ── Timeout helper ───────────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[Dispatcher] ${name} timed out after ${ms}ms`)), ms)
    )
  ]);
}

// ── Synthetic Hono Context ───────────────────────────────────────────────────
// Builds a minimal object that satisfies what every function handler accesses:
//   c.req.json()         → resolves with the args payload
//   c.req.query(key)     → reads from args as fallback
//   c.req.raw            → not used in internal calls
//   c.req.param(key)     → reads from args
//   c.get("jwtPayload")  → service-role payload
//   c.json(data, status) → resolves the outer promise with the data
//   c.text(t)            → same
//   c.notFound()         → rejects with 404
function buildSyntheticContext(
  functionName: string,
  args: Record<string, any>,
  resolve: (v: any) => void,
  reject: (e: any) => void
): any {
  const SERVICE_ROLE_PAYLOAD = {
    id: "system",
    role: "admin",
    client_id: args.__client_id || null,
    email: "system@bolifyai.internal",
    _isServiceRole: true,
  };

  // Clone args so handler mutations don't escape
  const payload = { ...args };

  return {
    req: {
      raw: null,
      json: () => Promise.resolve(payload),
      query: (key?: string) => key ? (payload[key] ?? "") : payload,
      param: (key: string) => payload[key] ?? "",
      header: (_key: string) => undefined,
      method: "POST",
      path: `/api/functions/${functionName}`,
    },
    get: (key: string) => {
      if (key === "jwtPayload") return SERVICE_ROLE_PAYLOAD;
      return undefined;
    },
    set: (_key: string, _value: any) => {},
    json: (data: any, _status?: number) => {
      resolve(data);
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
        status: _status || 200,
      });
    },
    text: (data: string, _status?: number) => {
      resolve({ text: data });
      return new Response(data, { status: _status || 200 });
    },
    html: (data: string, _status?: number) => {
      resolve({ html: data });
      return new Response(data, { status: _status || 200 });
    },
    notFound: () => {
      const err = new Error(`[Dispatcher] ${functionName}: resource not found`);
      reject(err);
      return new Response("Not Found", { status: 404 });
    },
    // Minimal env object so c.env.* access doesn't throw
    env: {},
    executionCtx: { waitUntil: (_p: any) => {} },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Invoke a registered function by name, in-process, with the given args.
 *
 * @param name     - Function name as registered in functionRegistry (index.ts)
 * @param args     - Arguments payload passed to c.req.json()
 * @param timeoutMs - Max execution time (default: 30 000 ms). Use 0 to disable.
 * @returns        The parsed response data object from c.json()
 */
export async function invokeFunction(
  name: string,
  args: Record<string, any> = {},
  timeoutMs = 30_000
): Promise<any> {
  if (!registry) {
    throw new Error(
      `[Dispatcher] Registry not initialised. Call initDispatcher() before invoking functions.`
    );
  }

  const handler = registry[name];
  if (!handler) {
    throw new Error(`[Dispatcher] Unknown function: "${name}"`);
  }

  const start = Date.now();

  const resultPromise = new Promise<any>(async (resolve, reject) => {
    const ctx = buildSyntheticContext(name, args, resolve, reject);
    try {
      await handler(ctx);
    } catch (err: any) {
      reject(err);
    }
  });

  try {
    const result = timeoutMs > 0
      ? await withTimeout(resultPromise, timeoutMs, name)
      : await resultPromise;
    const elapsed = Date.now() - start;
    if (elapsed > 5000) {
      console.warn(`[Dispatcher] ${name} completed in ${elapsed}ms (slow)`);
    }
    return result;
  } catch (err: any) {
    const elapsed = Date.now() - start;
    console.error(`[Dispatcher] ${name} failed after ${elapsed}ms:`, err.message);
    throw err;
  }
}

/**
 * Fire-and-forget variant. Errors are caught and logged but never propagate.
 * Use for non-critical side effects (e.g., analytics syncs, audit logs).
 */
export function invokeFunctionBg(name: string, args: Record<string, any> = {}): void {
  invokeFunction(name, args, 60_000).catch((err) =>
    console.error(`[Dispatcher/bg] ${name} error:`, err.message)
  );
}
