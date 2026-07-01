import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Bulk-import LoanAccount records from a mapped row payload.
 *
 * Body: { client_id, rows: [ { loan_id, customer_name, phone, ... } ], dedupe_by: 'loan_id' | 'phone' }
 * Output: { success, created, updated, skipped }
 *
 * Idempotent: existing rows with matching dedupe key are UPDATED (so banks can
 * push the same nightly LMS dump and get fresh DPD / outstanding values).
 */

const VALID_BUCKETS = new Set(['current','bucket_0','bucket_1','bucket_2','bucket_3','npa','written_off','closed']);
const VALID_STATUSES = new Set(['active','under_collection','ptp','rtp','settled','legal','closed','written_off']);

function normPhone(p) {
  let n = String(p || '').replace(/\D/g, '');
  if (/^0\d{10}$/.test(n)) n = n.slice(1);
  if (/^91\d{10}$/.test(n)) n = n.slice(2);
  return n;
}

function computeBucket(dpd) {
  const d = parseInt(dpd) || 0;
  if (d <= 0) return 'current';
  if (d <= 30) return 'bucket_0';
  if (d <= 60) return 'bucket_1';
  if (d <= 90) return 'bucket_2';
  if (d <= 180) return 'bucket_3';
  return 'npa';
}

function sanitizeRow(r) {
  const out = {};
  // Identity
  if (r.loan_id) out.loan_id = String(r.loan_id).trim();
  if (r.customer_name) out.customer_name = String(r.customer_name).trim();
  if (r.phone) out.phone = String(r.phone).trim();
  if (r.email) out.email = String(r.email).trim().toLowerCase();
  if (r.pan) out.pan = String(r.pan).trim().toUpperCase();
  if (r.address) out.address = String(r.address).trim();
  if (r.city) out.city = String(r.city).trim();
  if (r.state) out.state = String(r.state).trim();
  if (r.pincode) out.pincode = String(r.pincode).trim();

  // Loan terms
  if (r.product_type) out.product_type = String(r.product_type).trim().toLowerCase();
  if (r.lender_name) out.lender_name = String(r.lender_name).trim();
  if (r.disbursal_date) out.disbursal_date = String(r.disbursal_date).slice(0,10);
  if (r.loan_amount) out.loan_amount = parseFloat(r.loan_amount) || 0;
  if (r.outstanding_amount) out.outstanding_amount = parseFloat(r.outstanding_amount) || 0;
  if (r.emi_amount) out.emi_amount = parseFloat(r.emi_amount) || 0;
  if (r.emi_due_date) out.emi_due_date = parseInt(r.emi_due_date) || null;
  if (r.last_payment_date) out.last_payment_date = String(r.last_payment_date).slice(0,10);
  if (r.last_payment_amount) out.last_payment_amount = parseFloat(r.last_payment_amount) || 0;

  // DPD + bucket
  if (r.dpd_days !== undefined) {
    out.dpd_days = parseInt(r.dpd_days) || 0;
    out.bucket = r.bucket && VALID_BUCKETS.has(r.bucket) ? r.bucket : computeBucket(out.dpd_days);
  } else if (r.bucket && VALID_BUCKETS.has(r.bucket)) {
    out.bucket = r.bucket;
  }
  if (r.status && VALID_STATUSES.has(r.status)) out.status = r.status;

  // Alt phones
  if (r.alternate_phones) {
    out.alternate_phones = String(r.alternate_phones)
      .split(/[;,|]/).map(s => s.trim()).filter(Boolean);
  }

  if (r.external_ref) out.external_ref = String(r.external_ref).trim();
  if (r.assigned_to) out.assigned_to = String(r.assigned_to).trim();

  return out;
}

export default async function importLoanAccounts(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const { client_id, rows = [], dedupe_by = 'loan_id' } = body;

    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);
    if (!Array.isArray(rows) || rows.length === 0) {
      return c.json({ data: { error: 'rows array required' } }, 400);
    }

    // Ownership check
    if (user.role !== 'admin') {
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      if (!clients.map(c => c.id).includes(client_id)) {
        return c.json({ data: { error: 'Forbidden' } }, 403);
      }
    }

    const svc = base44.asServiceRole;

    // Load existing accounts for dedupe (paginated)
    const existing = [];
    const PAGE = 500;
    for (let p = 0; p < 100; p++) {
      const batch = await svc.entities.LoanAccount.filter(
        { client_id }, '-created_date', PAGE, p * PAGE
      );
      if (!batch || batch.length === 0) break;
      existing.push(...batch);
      if (batch.length < PAGE) break;
    }

    const byLoanId = new Map(existing.filter(a => a.loan_id).map(a => [a.loan_id, a]));
    const byPhone = new Map(existing.filter(a => a.phone).map(a => [normPhone(a.phone), a]));

    const toCreate = [];
    const toUpdate = [];
    let skipped = 0;

    for (const raw of rows) {
      const cleaned = sanitizeRow(raw);
      // Required: phone (and loan_id if deduping by loan_id)
      if (!cleaned.phone) { skipped++; continue; }
      if (dedupe_by === 'loan_id' && !cleaned.loan_id) { skipped++; continue; }

      let match = null;
      if (dedupe_by === 'loan_id' && cleaned.loan_id) {
        match = byLoanId.get(cleaned.loan_id);
      } else if (dedupe_by === 'phone') {
        match = byPhone.get(normPhone(cleaned.phone));
      }

      if (match) {
        toUpdate.push({ id: match.id, data: cleaned });
      } else {
        toCreate.push({ client_id, ...cleaned });
      }
    }

    // Insert in chunks
    let created = 0;
    const CHUNK = 100;
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const batch = toCreate.slice(i, i + CHUNK);
      await svc.entities.LoanAccount.bulkCreate(batch);
      created += batch.length;
    }

    // Updates one-at-a-time (no bulkUpdate in SDK)
    let updated = 0;
    for (const u of toUpdate) {
      await svc.entities.LoanAccount.update(u.id, u.data).catch(() => { skipped++; });
      updated++;
    }

    console.log(`[importLoanAccounts] client=${client_id} created=${created} updated=${updated} skipped=${skipped}`);
    return c.json({ data: { success: true, created, updated, skipped, total: rows.length } });
  } catch (error) {
    console.error('[importLoanAccounts] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};