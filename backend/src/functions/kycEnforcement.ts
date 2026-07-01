import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// KYC enforcement cron.
//
// Runs daily via EXTERNAL cron (cron-job.org etc.) — uses ONLY entity reads/updates,
// so it does NOT consume Base44 integration credits and does NOT depend on the
// internal automation engine.
//
// Invoke: GET https://<app>/functions/kycEnforcement?api_key=<CRON_API_KEY>
//   (also accepts ?cron_secret=<SMARTFLO_WEBHOOK_SECRET> for parity with other pollers)
//
// Logic:
//   1. SUSPEND — any business client past their KYC deadline whose kyc_status is
//      NOT 'approved' (and not 'not_required') gets account_status = 'suspended'.
//      We stamp kyc_suspended=true so we know WE suspended them (vs. billing/manual).
//   2. RESTORE — any client we previously KYC-suspended whose kyc_status became
//      'approved' is restored to account_status = 'active'.
//
// Enforcement is driven entirely by each client's own kyc_deadline field.
// Clients without a kyc_deadline set are never auto-suspended.

export default async function kycEnforcement(c: any) {
  const req = c.req.raw || c.req;
  try {
    // ── Auth: external cron only ──
    const url = new URL(req.url);
    const cronApiKey = url.searchParams.get('api_key');
    const cronSecret = url.searchParams.get('cron_secret');
    const expectedCronKey = Deno.env.get('CRON_API_KEY');
    const expectedSecret = Deno.env.get('SMARTFLO_WEBHOOK_SECRET');
    const isValid =
      (expectedCronKey && cronApiKey === expectedCronKey) ||
      (expectedSecret && cronSecret === expectedSecret);
    if (!isValid) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    /* const base44 = ... */;
    const svc = base44.asServiceRole;
    const results = { suspended: 0, restored: 0, errors: [] };

    // Current IST date at midnight for deadline comparison
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    istNow.setHours(0, 0, 0, 0);

    const deadlinePassed = (client) => {
      if (!client.kyc_deadline) return false; // no deadline set → never enforce
      const d = new Date(client.kyc_deadline);
      if (isNaN(d.getTime())) return false;
      d.setHours(0, 0, 0, 0);
      return d < istNow; // strictly before today → deadline has passed
    };

    const needsKyc = (status) =>
      status && status !== 'approved' && status !== 'not_required';

    // ── 1. RESTORE: clients we KYC-suspended who are now approved ──
    // Catch BOTH the cleanly-flagged ones (kyc_suspended=true) AND any suspended
    // client whose KYC is now approved but whose suspension flag was never stamped
    // (older/other suspension paths). An approved KYC must never stay suspended,
    // unless the suspension is a genuine billing overdue (next_billing_date passed).
    const seenRestore = new Set();
    const flagged = await svc.entities.Client.filter({ kyc_suspended: true });
    const suspendedApproved = await svc.entities.Client.filter({ account_status: 'suspended', kyc_status: 'approved' });
    const restoreCandidates = [...flagged, ...suspendedApproved];

    const billingOverdue = (c) => {
      if (!c.next_billing_date) return false;
      const d = new Date(c.next_billing_date);
      if (isNaN(d.getTime())) return false;
      d.setHours(0, 0, 0, 0);
      return d < istNow; // past due → keep suspended for billing, not KYC
    };

    for (const c of restoreCandidates) {
      if (seenRestore.has(c.id)) continue;
      seenRestore.add(c.id);
      if (c.kyc_status !== 'approved') continue;
      // Don't override a genuine billing suspension.
      if (c.account_status === 'suspended' && billingOverdue(c)) {
        // Still clear the stale KYC flag so it's not mistaken for a KYC hold.
        if (c.kyc_suspended) {
          try { await svc.entities.Client.update(c.id, { kyc_suspended: false }); } catch (_) {}
        }
        continue;
      }
      try {
        await svc.entities.Client.update(c.id, {
          kyc_suspended: false,
          account_status: 'active',
        });
        results.restored++;
        console.log(`[kycEnforcement] ✅ Restored ${c.company_name} (KYC approved)`);
      } catch (e) {
        results.errors.push({ client: c.id, error: e.message });
      }
    }

    // ── 2. SUSPEND: past deadline + KYC not approved + currently active ──
    // Scan business clients in the statuses that can still be suspended.
    const candidateStatuses = ['active', 'trial', 'onboarding'];
    for (const acctStatus of candidateStatuses) {
      const clients = await svc.entities.Client.filter({ account_status: acctStatus });
      for (const c of clients) {
        if (c.account_type === 'personal') continue;
        if (c.kyc_grace_active) continue; // admin granted temporary access
        if (!needsKyc(c.kyc_status)) continue;
        if (!deadlinePassed(c)) continue;

        try {
          await svc.entities.Client.update(c.id, {
            account_status: 'suspended',
            kyc_suspended: true,
          });
          results.suspended++;
          console.log(`[kycEnforcement] ⛔ Suspended ${c.company_name} (kyc_status=${c.kyc_status}, deadline=${c.kyc_deadline})`);
        } catch (e) {
          results.errors.push({ client: c.id, error: e.message });
        }
        await new Promise((r) => setTimeout(r, 100)); // gentle pacing
      }
    }

    console.log(`[kycEnforcement] Done — suspended=${results.suspended}, restored=${results.restored}`);
    return c.json({ data: { success: true, ...results } });
  } catch (error) {
    console.error('[kycEnforcement] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};