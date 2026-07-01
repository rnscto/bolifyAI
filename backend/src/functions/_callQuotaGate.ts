import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Shared quota-gate helper used by initiateCall (Smartflo / IN) and
// twilioInitiateCall (US / UK). Decides whether a call should be blocked
// based on the client's region, account_status, and usage counters.
//
// Returns { allowed: true } when the call may proceed, or
// { allowed: false, error, block_reason, http_status } when blocked.
//
// India (region='IN' or unset) — legacy 10-call trial cap + trial_end_date.
// US / UK (region='US' | 'UK') — minute-based:
//   - trial: free for the duration of trial_end_date, no per-call cap
//     (overage on intl plans is billed via chargeIntlOverage, not gated here).
//   - active: blocked once minutes_used_this_period exceeds minutes_included
//     by the OVERAGE_GRACE_MULTIPLIER. Prevents runaway usage; below the
//     multiplier overage is billed automatically.
//   - expired / suspended: hard block.
//
// Note: imported by Deno function files via static import.

const OVERAGE_GRACE_MULTIPLIER = 1.5;

export function checkCallQuota(client) {
  if (!client) {
    return { allowed: false, error: 'Client not found', block_reason: 'no_client', http_status: 404 };
  }

  const region = client.region || 'IN';
  const status = client.account_status;
  const now = new Date();

  // Hard blocks for any region
  if (status === 'suspended') {
    return {
      allowed: false,
      error: 'Account suspended. Contact support to restore access.',
      block_reason: 'account_suspended',
      http_status: 403,
    };
  }

  // ─── India: legacy trial gate ───
  if (region === 'IN') {
    if (status === 'trial' || status === 'expired') {
      const trialEnd = client.trial_end_date ? new Date(client.trial_end_date) : null;
      const unlimitedUntil = client.trial_topup_unlimited_until ? new Date(client.trial_topup_unlimited_until) : null;
      const isUnlimited = unlimitedUntil && unlimitedUntil > now;
      const callsUsed = Number(client.trial_calls_used || 0);
      const callLimit = Number(client.trial_call_limit ?? 10);

      if (status === 'expired' || (trialEnd && trialEnd <= now && !isUnlimited)) {
        return {
          allowed: false,
          error: 'Your free trial has ended. Please top-up or subscribe to continue making calls.',
          block_reason: 'trial_expired',
          http_status: 402,
        };
      }
      if (!isUnlimited && callsUsed >= callLimit) {
        return {
          allowed: false,
          error: `You've used all ${callLimit} trial calls. Top-up for unlimited calling or subscribe to a full plan.`,
          block_reason: 'call_limit_reached',
          http_status: 402,
        };
      }
    }
    return { allowed: true };
  }

  // ─── US / UK: minute-based gating ───
  // Trial: must be within trial_end_date. No per-call cap.
  if (status === 'trial') {
    const trialEnd = client.trial_end_date ? new Date(client.trial_end_date) : null;
    if (trialEnd && trialEnd <= now) {
      return {
        allowed: false,
        error: 'Your free trial has ended. Please subscribe to a minute plan to continue making calls.',
        block_reason: 'trial_expired',
        http_status: 402,
      };
    }
    return { allowed: true };
  }

  // Expired (post-trial, never subscribed)
  if (status === 'expired') {
    return {
      allowed: false,
      error: 'Your subscription has expired. Please choose a plan to resume calling.',
      block_reason: 'subscription_expired',
      http_status: 402,
    };
  }

  // Active subscription: check minute usage. Allow overage up to grace
  // multiplier; beyond that, block to prevent runaway billing.
  if (status === 'active') {
    const included = Number(client.minutes_included || 0);
    const used = Number(client.minutes_used_this_period || 0);
    if (included > 0 && used >= included * OVERAGE_GRACE_MULTIPLIER) {
      return {
        allowed: false,
        error: `You've exceeded your monthly minutes (${used.toLocaleString()} used of ${included.toLocaleString()} included, ${Math.round((OVERAGE_GRACE_MULTIPLIER - 1) * 100)}% grace consumed). Upgrade your plan to continue.`,
        block_reason: 'minutes_exceeded',
        http_status: 402,
      };
    }
    return { allowed: true };
  }

  // Onboarding or any other status — allow (no quota concept yet)
  return { allowed: true };
}