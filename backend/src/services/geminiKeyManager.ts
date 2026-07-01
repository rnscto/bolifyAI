/**
 * GeminiKeyManager — Centralized Gemini API key selection with free → paid fallback.
 *
 * Strategy:
 *  1. Always try the FREE key first.
 *  2. If the free key gets rate-limited (429) or fails to connect, mark it as
 *     "rate-limited" with a cooldown window.
 *  3. During cooldown, all requests use the PAID key.
 *  4. After cooldown expires, try the free key again.
 */

const COOLDOWN_MS = 60_000; // 60 seconds before retrying the free key

interface KeyState {
  free: string;
  paid: string;
  freeRateLimitedUntil: number; // timestamp (ms) when free key cooldown expires
  switchCount: number;          // how many times we've switched to paid
}

const state: KeyState = {
  free: Deno.env.get("GEMINI_API_KEY_FREE") || Deno.env.get("GEMINI_API_KEY") || "",
  paid: Deno.env.get("GEMINI_API_KEY_PAID") || "",
  freeRateLimitedUntil: 0,
  switchCount: 0,
};

/**
 * Returns true if the free key is currently in cooldown (rate-limited).
 */
function isFreeKeyRateLimited(): boolean {
  return Date.now() < state.freeRateLimitedUntil;
}

/**
 * Get the best available API key.
 * Returns { key, tier } where tier is "free" or "paid".
 */
export function getKey(): { key: string; tier: "free" | "paid" } {
  // If no paid key is configured, always use whatever we have
  if (!state.paid) {
    return { key: state.free, tier: "free" };
  }

  // If free key is rate-limited, use paid
  if (isFreeKeyRateLimited()) {
    return { key: state.paid, tier: "paid" };
  }

  // Default: use free
  return { key: state.free, tier: "free" };
}

/**
 * Mark a key as rate-limited. Sets a cooldown window.
 * Only the free key can be rate-limited (paid key is our fallback of last resort).
 */
export function markRateLimited(key: string, reason: string = "unknown"): void {
  if (key === state.free) {
    state.freeRateLimitedUntil = Date.now() + COOLDOWN_MS;
    state.switchCount++;
    console.log(
      `[GeminiKeyManager] FREE key rate-limited (reason: ${reason}). ` +
      `Switching to PAID key for ${COOLDOWN_MS / 1000}s. ` +
      `Total switches: ${state.switchCount}`
    );
  } else {
    // Paid key also failed — log but nothing to fall back to
    console.error(
      `[GeminiKeyManager] PAID key also failed (reason: ${reason}). No fallback available.`
    );
  }
}

/**
 * Build the full Gemini Live WebSocket URL with the current best key.
 */
export function getWebSocketUrl(): { url: string; key: string; tier: "free" | "paid" } {
  const { key, tier } = getKey();
  const HOST = "generativelanguage.googleapis.com";
  // v1beta is required for gemini-3.1-flash-live-preview and newer Live API models.
  // v1alpha was the old endpoint and does NOT recognise the 3.1 model family,
  // causing a 1007 "Request contains an invalid argument." disconnect at setup.
  const url = `wss://${HOST}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
  return { url, key, tier };
}

/**
 * Get the REST API key for post-call analysis, etc.
 */
export function getRestApiKey(): { key: string; tier: "free" | "paid" } {
  return getKey();
}

/**
 * Check if a WebSocket close code or HTTP status indicates a rate limit.
 */
export function isRateLimitError(codeOrStatus: number): boolean {
  // HTTP 429 = Too Many Requests
  // WebSocket 1008 = Policy Violation (often used for rate limits)
  // WebSocket 1013 = Try Again Later
  return codeOrStatus === 429 || codeOrStatus === 1008 || codeOrStatus === 1013;
}

/**
 * Get current status for diagnostics.
 */
export function getStatus() {
  const { tier } = getKey();
  return {
    activeTier: tier,
    freeKeyConfigured: !!state.free,
    paidKeyConfigured: !!state.paid,
    freeRateLimited: isFreeKeyRateLimited(),
    freeRateLimitedUntil: state.freeRateLimitedUntil > 0
      ? new Date(state.freeRateLimitedUntil).toISOString()
      : null,
    totalSwitches: state.switchCount,
  };
}
