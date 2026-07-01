import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * BFSI Pre-Call Compliance Gate
 *
 * Runs all RBI/DPDP checks BEFORE a BFSI call is placed.
 * Returns { allowed, violations, calling_window_open, attempts_today,
 *           dnc_status, max_attempts_breached }.
 *
 * Called by initiateCall when payload contains bfsi_case_type, and directly
 * by the BFSI campaign engine and verification kick-off flow.
 *
 * NOTE: NEVER reads borrower PII into logs — only phone last-4.
 */

// ─── Inline compliance rules (lib not importable in Deno deploy) ───
const DEFAULT_WINDOW = { start_hour: 8, end_hour: 19, timezone: 'Asia/Kolkata', days: [1,2,3,4,5,6] };
const DEFAULT_MAX_ATTEMPTS = 3;

function getWindow(client) {
  const cfg = client?.module_configs?.bfsi_suite?.calling_window;
  if (!cfg) return DEFAULT_WINDOW;
  return {
    start_hour: cfg.start_hour ?? DEFAULT_WINDOW.start_hour,
    end_hour: cfg.end_hour ?? DEFAULT_WINDOW.end_hour,
    timezone: cfg.timezone || DEFAULT_WINDOW.timezone,
    days: cfg.days || DEFAULT_WINDOW.days,
  };
}
function getMaxAttempts(client) {
  return client?.module_configs?.bfsi_suite?.max_attempts_per_day ?? DEFAULT_MAX_ATTEMPTS;
}
function currentHourIn(tz) {
  try { return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()), 10); }
  catch { return new Date().getHours(); }
}
function currentDayIn(tz) {
  try {
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date());
    return map[w] ?? new Date().getDay();
  } catch { return new Date().getDay(); }
}
function normalizePhone(phone) {
  let n = String(phone || '').replace(/\D/g, '');
  if (/^0\d{10}$/.test(n)) n = n.substring(1);
  if (/^91\d{10}$/.test(n)) n = n.substring(2);
  return n;
}

export default async function bfsiComplianceGate(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json();
    const {
      client_id,
      phone,
      loan_account_id,
      override_window, // admin-allowed override (flagged but allowed)
    } = body;

    if (!client_id || !phone) {
      return c.json({ data: { error: 'client_id and phone required' } }, 400);
    }

    const violations = [];
    const warnings = [];

    // 1) Load client to read calling-window overrides
    const client = await base44.asServiceRole.entities.Client.get(client_id).catch(() => null);
    if (!client) {
      return c.json({ data: { allowed: false, violations: ['client_not_found'] } }, 404);
    }

    // 2) Calling-window check
    const win = getWindow(client);
    const hour = currentHourIn(win.timezone);
    const day = currentDayIn(win.timezone);
    const dayOk = win.days.includes(day);
    const hourOk = hour >= win.start_hour && hour < win.end_hour;
    const windowOpen = dayOk && hourOk;
    if (!windowOpen) {
      if (override_window) warnings.push('calling_window_overridden');
      else violations.push('outside_calling_window');
    }

    // 3) Client DNC check (BfsiDncList)
    const phoneNorm = normalizePhone(phone);
    let dncStatus = 'clear';
    try {
      const dncMatches = await base44.asServiceRole.entities.BfsiDncList.filter({
        client_id, phone_normalized: phoneNorm, is_active: true,
      });
      const active = dncMatches.filter(d => !d.expires_at || new Date(d.expires_at) > new Date());
      if (active.length > 0) {
        dncStatus = `blocked_${active[0].source}`;
        violations.push('on_client_dnc');
      }
    } catch (e) {
      console.error('[bfsiComplianceGate] DNC lookup failed:', e.message);
    }

    // 4) Max-attempts-per-day check (uses LoanAccount counter)
    const maxAttempts = getMaxAttempts(client);
    let attemptsToday = 0;
    let maxBreached = false;
    if (loan_account_id) {
      try {
        const acct = await base44.asServiceRole.entities.LoanAccount.get(loan_account_id);
        const today = new Date().toISOString().substring(0, 10);
        if (acct?.attempts_today_date === today) {
          attemptsToday = acct.attempts_today || 0;
        }
        if (attemptsToday >= maxAttempts) {
          maxBreached = true;
          violations.push('max_attempts_breached');
        }
      } catch (e) {
        console.error('[bfsiComplianceGate] attempt counter lookup failed:', e.message);
      }
    }

    const allowed = violations.length === 0;
    console.log(`[bfsiComplianceGate] client=${client_id} phone_last4=${phoneNorm.slice(-4)} allowed=${allowed} window=${windowOpen} attempts=${attemptsToday}/${maxAttempts} dnc=${dncStatus} violations=${violations.join(',')}`);

    return c.json({ data: {
      allowed,
      violations,
      warnings,
      calling_window_open: windowOpen,
      window: { start_hour: win.start_hour, end_hour: win.end_hour, current_hour: hour, day, timezone: win.timezone },
      attempts_today: attemptsToday,
      max_attempts_per_day: maxAttempts,
      max_attempts_breached: maxBreached,
      dnc_status: dncStatus,
      script_version: '2026-06-01-v1',
    } });
  } catch (error) {
    console.error('[bfsiComplianceGate] error:', error);
    return c.json({ data: { error: error.message, allowed: false } }, 500);
  }

};