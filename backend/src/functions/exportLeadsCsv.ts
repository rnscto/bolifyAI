import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Server-side CSV export of leads matching the current filters.
// Runs the full scan + filter on the server and returns a CSV file, so the
// browser never needs to hold all leads in memory.
//
// Payload: { client_id, group_id, tier, status, source, search }
// Returns: text/csv attachment



const SCAN_PAGE = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a single page on rate-limit (429) so a transient throttle doesn't
// abort the whole export.
async function fetchPageWithRetry(svc, query, offset) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await svc.entities.Lead.filter(query, '-created_date', SCAN_PAGE, offset);
    } catch (e) {
      const msg = e?.message || '';
      if (/429|rate limit/i.test(msg) && attempt < 3) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

async function fetchAll(svc, query) {
  const all = [];
  for (let p = 0; p < 200; p++) {
    const batch = await fetchPageWithRetry(svc, query, p * SCAN_PAGE);
    all.push(...batch);
    if (batch.length < SCAN_PAGE) break;
    await sleep(120); // gentle pacing between pages
  }
  return all;
}

const norm = (s) => (s || '').toString().toLowerCase();

const csvEscape = (val) => {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Format timestamps in IST (Asia/Kolkata) so the export matches what the
// dashboard shows. Previously this returned raw UTC via .toISOString(), which
// looked like a "mismatch" (e.g. dashboard "10:24 PM" vs export "16:54Z" — the
// same moment, different timezone). Output: "2026-06-22 10:24 PM IST".
const fmtDate = (d) => {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).replace(',', '') + ' IST';
  } catch { return d; }
};

export default async function exportLeadsCsv(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { client_id, group_id = null, tier = 'all', status = 'all', source = 'all', search = '' } = await c.req.json();
    if (!client_id) return c.json({ data: { error: 'client_id required' } }, 400);

    const svc = base44.asServiceRole;
    const [allLeads, groups] = await Promise.all([
      fetchAll(svc, { client_id }),
      svc.entities.LeadGroup.filter({ client_id }).catch(() => []),
    ]);
    const groupMap = new Map((groups || []).map((g) => [g.id, g.name]));

    const s = norm(search);
    const filtered = allLeads.filter((l) => {
      if (group_id === '_ungrouped') {
        if ((l.group_ids || []).length > 0) return false;
      } else if (group_id) {
        if (!(l.group_ids || []).includes(group_id)) return false;
      }
      if (tier !== 'all' && l.qualification_tier !== tier) return false;
      if (status !== 'all' && l.status !== status) return false;
      if (source !== 'all' && l.source !== source) return false;
      if (s) {
        const hit = norm(l.name).includes(s) || (l.phone || '').includes(search) || norm(l.company).includes(s);
        if (!hit) return false;
      }
      return true;
    });

    const headers = ['Name', 'Phone', 'Email', 'Company', 'Status', 'Qualification Tier', 'AI Score', 'Sentiment', 'Source', 'Groups', 'Tags', 'Last Call Date', 'Next Followup', 'Notes', 'Created Date'];
    const rows = filtered.map((l) => [
      l.name || '', l.phone || '', l.email || '', l.company || '',
      l.status || '', l.qualification_tier || '', l.score ?? '', l.sentiment || '',
      l.source || '',
      (l.group_ids || []).map((gid) => groupMap.get(gid) || gid).join('; '),
      (l.tags || []).join('; '),
      fmtDate(l.last_call_date), fmtDate(l.next_followup_date), l.notes || '', fmtDate(l.created_date),
    ]);

    const csv = '\uFEFF' + [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv;charset=utf-8;',
        'Content-Disposition': `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    console.error('exportLeadsCsv error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};