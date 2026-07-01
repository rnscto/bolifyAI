import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Bulk-import VerificationCase rows (and optional ReferenceCheck rows linked
 * to them) from a mapped row payload.
 *
 * Body: { client_id, case_type, rows: [ { application_id, applicant_name, phone, declared_fields {...}, references? } ] }
 *
 * Output: { success, created_cases, created_refs, skipped }
 *
 * Idempotent on application_id — re-uploading the same row updates declared
 * fields without duplicating.
 */

const VALID_CASE_TYPES = new Set([
  'tvr_loan', 'pivc_insurance', 'kyc_reverification',
  'address_verification', 'employment_verification', 'income_verification'
]);

function sanitizeCase(r, defaultCaseType) {
  const out = {};
  const caseType = r.case_type && VALID_CASE_TYPES.has(r.case_type) ? r.case_type : defaultCaseType;
  out.case_type = caseType || 'tvr_loan';

  if (r.application_id) out.application_id = String(r.application_id).trim();
  if (r.applicant_name) out.applicant_name = String(r.applicant_name).trim();
  if (r.phone) out.phone = String(r.phone).trim();
  if (r.email) out.email = String(r.email).trim().toLowerCase();

  // Declared fields: anything that starts with "declared_" or is in known list
  const declared = {};
  const KNOWN = ['name', 'dob', 'address', 'employer', 'designation',
    'monthly_income', 'work_email', 'alternate_phone', 'pan', 'aadhaar_last4',
    'sum_assured', 'premium_amount', 'policy_term'];
  for (const k of KNOWN) {
    if (r[`declared_${k}`]) declared[k] = String(r[`declared_${k}`]).trim();
    else if (r[k] !== undefined && r[k] !== '') declared[k] = String(r[k]).trim();
  }
  if (Object.keys(declared).length) out.declared_fields = declared;

  if (r.external_ref) out.external_ref = String(r.external_ref).trim();
  if (r.assigned_agent_id) out.assigned_agent_id = String(r.assigned_agent_id).trim();

  return out;
}

export default async function importVerificationCases(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const { client_id, case_type = 'tvr_loan', rows = [] } = body;

    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);
    if (!Array.isArray(rows) || rows.length === 0) {
      return c.json({ data: { error: 'rows array required' } }, 400);
    }

    if (user.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (!clients.map(c => c.id).includes(client_id)) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const svc = base44.asServiceRole;

    // Dedupe by application_id within client scope
    const existing = await svc.entities.VerificationCase.filter({ client_id }, '-created_date', 500);
    const byAppId = new Map(existing.filter(c => c.application_id).map(c => [c.application_id, c]));

    let createdCases = 0;
    let updatedCases = 0;
    let createdRefs = 0;
    let skipped = 0;

    const newCases = [];
    for (const raw of rows) {
      const cleaned = sanitizeCase(raw, case_type);
      if (!cleaned.phone) { skipped++; continue; }

      if (cleaned.application_id && byAppId.has(cleaned.application_id)) {
        // Update existing
        const existingCase = byAppId.get(cleaned.application_id);
        await svc.entities.VerificationCase.update(existingCase.id, cleaned).catch(() => {});
        updatedCases++;
        // Skip refs on update — references are append-only
        continue;
      }

      newCases.push({ client_id, verification_status: 'pending', ...cleaned, _raw: raw });
    }

    // Bulk-create new cases
    const CHUNK = 100;
    const createdRecords = [];
    for (let i = 0; i < newCases.length; i += CHUNK) {
      const batch = newCases.slice(i, i + CHUNK).map(({ _raw, ...rest }) => rest);
      const res = await svc.entities.VerificationCase.bulkCreate(batch);
      createdRecords.push(...(res || batch));
      createdCases += batch.length;
    }

    // Insert any references found in the source rows
    // Source-row format: references = "Name|Phone|Relationship;Name|Phone|Relationship"
    const refs = [];
    newCases.forEach((src, idx) => {
      const raw = src._raw || {};
      const refStr = raw.references || raw.reference_list || '';
      if (!refStr) return;
      const createdCase = createdRecords[idx] || null;
      String(refStr).split(/[;]/).forEach(part => {
        const tokens = part.split(/[|,]/).map(s => s.trim());
        if (tokens.length >= 2 && tokens[1]) {
          refs.push({
            client_id,
            verification_case_id: createdCase?.id || null,
            application_id: src.application_id || null,
            applicant_name: src.applicant_name || null,
            reference_name: tokens[0] || null,
            reference_phone: tokens[1] || null,
            relationship_declared: tokens[2] || null,
            status: 'pending',
          });
        }
      });
    });
    for (let i = 0; i < refs.length; i += CHUNK) {
      await svc.entities.ReferenceCheck.bulkCreate(refs.slice(i, i + CHUNK));
      createdRefs += Math.min(CHUNK, refs.length - i);
    }

    console.log(`[importVerificationCases] client=${client_id} cases_created=${createdCases} cases_updated=${updatedCases} refs=${createdRefs} skipped=${skipped}`);
    return c.json({ data: {
      success: true,
      created_cases: createdCases,
      updated_cases: updatedCases,
      created_refs: createdRefs,
      skipped,
      total: rows.length,
    } });
  } catch (error) {
    console.error('[importVerificationCases] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};