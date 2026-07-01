import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Post-call BFSI Compliance Log writer.
 *
 * Invoked after every BFSI call to persist the audit trail:
 *  - whether the call was in the legal window
 *  - DNC status at dial time
 *  - attempts-today counter
 *  - whether consent was captured
 *  - any abusive-language flags from the transcript
 *  - recording URL + retention-until date (5 years for RBI)
 *
 * Idempotent on call_log_id — won't create duplicate rows.
 */

const PROHIBITED = [
  /\b(threat|threatening|legal action will|arrest|police|jail|criminal)\b/i,
  /\b(stupid|idiot|fool|liar|cheat)\b/i,
  /\b(suicide|kill|harm)\b/i,
];

function scanForViolations(transcript) {
  if (!transcript) return [];
  const hits = [];
  for (const rx of PROHIBITED) {
    const m = transcript.match(rx);
    if (m) hits.push(m[0].toLowerCase());
  }
  return [...new Set(hits)];
}

function computeRetentionDate(years = 5) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().substring(0, 10);
}

export default async function logBfsiCompliance(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json();
    const {
      client_id,
      call_log_id,
      loan_account_id,
      case_type,                  // 'collection' | 'verification' | 'rcu' | 'mandate_bounce' | 'legal'
      gate_result = {},           // output from bfsiComplianceGate
      consent_log_id = null,
      script_version = null,
      transcript = '',
      recording_url = '',
    } = body;

    if (!client_id || !call_log_id) {
      return c.json({ data: { error: 'client_id and call_log_id required' } }, 400);
    }

    // Idempotent: skip if already logged
    const existing = await base44.asServiceRole.entities.BfsiComplianceLog.filter({ call_log_id });
    if (existing.length > 0) {
      return c.json({ data: { success: true, id: existing[0].id, already_logged: true } });
    }

    const violations = [];
    if (gate_result.violations) violations.push(...gate_result.violations);

    // Scan transcript for abusive language
    const abusiveHits = scanForViolations(transcript);
    const abusiveFlagged = abusiveHits.length > 0;
    if (abusiveFlagged) violations.push('abusive_language');
    if (!consent_log_id) violations.push('no_consent_logged');

    const overall = violations.length === 0 ? 'compliant'
      : violations.includes('abusive_language') || violations.includes('outside_calling_window') ? 'violation'
      : 'warning';

    const record = await base44.asServiceRole.entities.BfsiComplianceLog.create({
      client_id,
      call_log_id,
      loan_account_id,
      case_type,
      called_at: new Date().toISOString(),
      called_in_window: gate_result.calling_window_open !== false,
      dnc_checked: true,
      dnc_status: gate_result.dnc_status || 'clear',
      attempts_today_at_dial: gate_result.attempts_today || 0,
      max_attempts_breached: !!gate_result.max_attempts_breached,
      consent_logged: !!consent_log_id,
      consent_log_id: consent_log_id || '',
      abusive_language_flagged: abusiveFlagged,
      abusive_flag_reason: abusiveHits.join(', '),
      recording_url,
      recording_retention_until: computeRetentionDate(5),
      script_version: script_version || '2026-06-01-v1',
      overall_status: overall,
      violations,
    });

    console.log(`[logBfsiCompliance] call=${call_log_id} status=${overall} violations=${violations.join(',')}`);
    return c.json({ data: { success: true, id: record.id, overall_status: overall, violations } });
  } catch (error) {
    console.error('[logBfsiCompliance] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};