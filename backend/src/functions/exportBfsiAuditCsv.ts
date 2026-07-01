import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Exports a date-range BFSI audit CSV from BfsiComplianceLog.
 *
 * Body: { client_id, from_date (ISO), to_date (ISO) }
 * Returns: CSV stream with Content-Disposition: attachment
 *
 * One row per BFSI call — borrower phone (last-4 only for privacy), called_at,
 * case_type, called_in_window, dnc_status, attempts_today_at_dial, consent_logged,
 * abusive_flag, overall_status, violations, recording_retention_until.
 *
 * Used by quarterly RBI/IRDAI regulator submissions and internal audit.
 */

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default async function exportBfsiAuditCsv(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const { client_id, from_date, to_date } = body;

    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    // Ownership check
    if (user.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (!clients.map(c => c.id).includes(client_id)) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const svc = base44.asServiceRole;

    // Paginate through compliance logs in the window
    const all = [];
    const PAGE = 200;
    for (let p = 0; p < 250; p++) {
      const batch = await svc.entities.BfsiComplianceLog.filter(
        { client_id }, '-called_at', PAGE, p * PAGE
      );
      if (!batch || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < PAGE) break;
    }

    // Date-range filter (in-memory; the schema doesn't support range queries)
    const fromTs = from_date ? new Date(from_date).getTime() : 0;
    const toTs = to_date ? new Date(to_date).getTime() : Date.now();
    const rows = all.filter(r => {
      const t = r.called_at ? new Date(r.called_at).getTime() : 0;
      return t >= fromTs && t <= toTs;
    });

    // Build CSV
    const header = [
      'called_at', 'case_type', 'loan_account_id', 'phone_last4',
      'called_in_window', 'dnc_status', 'attempts_today_at_dial',
      'max_attempts_breached', 'consent_logged', 'abusive_language_flagged',
      'abusive_flag_reason', 'overall_status', 'violations',
      'recording_url', 'recording_retention_until', 'script_version', 'call_log_id'
    ];

    // Resolve loan account phones (last4 only — never write full phone to audit)
    const loanIds = [...new Set(rows.map(r => r.loan_account_id).filter(Boolean))];
    const phoneByLoan = {};
    for (let i = 0; i < loanIds.length; i += 100) {
      const slice = loanIds.slice(i, i + 100);
      const accts = await Promise.all(slice.map(id =>
        svc.entities.LoanAccount.get(id).catch(() => null)
      ));
      accts.forEach((a, idx) => {
        if (a?.phone) phoneByLoan[slice[idx]] = String(a.phone).replace(/\D/g, '').slice(-4);
      });
    }

    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.called_at || '',
        r.case_type || '',
        r.loan_account_id || '',
        phoneByLoan[r.loan_account_id] || '',
        r.called_in_window === false ? 'NO' : 'YES',
        r.dnc_status || 'clear',
        r.attempts_today_at_dial ?? 0,
        r.max_attempts_breached ? 'YES' : 'NO',
        r.consent_logged ? 'YES' : 'NO',
        r.abusive_language_flagged ? 'YES' : 'NO',
        r.abusive_flag_reason || '',
        r.overall_status || 'compliant',
        (r.violations || []).join(';'),
        r.recording_url || '',
        r.recording_retention_until || '',
        r.script_version || '',
        r.call_log_id || '',
      ].map(csvEscape).join(','));
    }

    const csv = lines.join('\n');
    const filename = `bfsi-audit-${client_id.slice(-6)}-${new Date().toISOString().slice(0,10)}.csv`;

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('[exportBfsiAuditCsv] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};