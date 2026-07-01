import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const CONNECTOR_ID = '69e9ee7e358cda2752c9b54e'; // Google Sheets

// Convert column letter (A, B, ..., Z, AA) to 0-indexed number
const colToIdx = (letter) => {
  if (!letter) return -1;
  let idx = 0;
  for (const ch of letter.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1;
};

// Normalize phone to match pushback later
const normalizePhone = (p) => String(p || '').replace(/[^0-9+]/g, '');

async function sheetsFetch(accessToken, path, options = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets API ${res.status}: ${err.slice(0, 300)}`);
  }
  return res.json();
}

async function importOneSync(base44, sync) {
  // Get the client's user for per-user connection
  const client = await base44.asServiceRole.entities.Client.get(sync.client_id);
  if (!client?.user_id) throw new Error('Client has no user_id');

  let conn;
  try {
    conn = await base44.asServiceRole.connectors.getCurrentAppUserConnection(CONNECTOR_ID);
  } catch (e) {
    throw new Error('Google Sheets not connected for this client (manual import from the client dashboard is required)');
  }
  if (!conn?.accessToken) throw new Error('Google Sheets not connected for this client');

  const { spreadsheet_id, tab_name, header_row, column_mapping, imported_flag_column, lead_id_column, assigned_group_id } = sync;
  const range = `${tab_name || 'Sheet1'}!A1:ZZ10000`;

  const data = await sheetsFetch(
    conn.accessToken,
    `${spreadsheet_id}/values/${encodeURIComponent(range)}`
  );

  const rows = data.values || [];
  if (rows.length === 0) return { imported: 0, skipped: 0 };

  const headerIdx = (header_row || 1) - 1;
  const dataStart = headerIdx + 1;

  const nameIdx = colToIdx(column_mapping?.name);
  const phoneIdx = colToIdx(column_mapping?.phone);
  const emailIdx = colToIdx(column_mapping?.email);
  const companyIdx = colToIdx(column_mapping?.company);
  const importedIdx = colToIdx(imported_flag_column);
  const leadIdIdx = colToIdx(lead_id_column);

  if (phoneIdx < 0) throw new Error('phone column mapping is required');

  let imported = 0;
  let skipped = 0;
  const updates = []; // { row, col, value }

  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r];
    const phone = normalizePhone(row[phoneIdx]);
    if (!phone) { skipped++; continue; }

    // Skip if already imported
    if (importedIdx >= 0 && String(row[importedIdx] || '').trim()) { skipped++; continue; }
    if (leadIdIdx >= 0 && String(row[leadIdIdx] || '').trim()) { skipped++; continue; }

    // Skip duplicates in VaaniAI
    const existing = await base44.asServiceRole.entities.Lead.filter({
      client_id: sync.client_id,
      phone
    });
    if (existing.length > 0) {
      if (leadIdIdx >= 0) updates.push({ row: r + 1, col: lead_id_column, value: existing[0].id });
      if (importedIdx >= 0) updates.push({ row: r + 1, col: imported_flag_column, value: '✓' });
      skipped++;
      continue;
    }

    const leadData = {
      client_id: sync.client_id,
      phone,
      name: nameIdx >= 0 ? (row[nameIdx] || '') : '',
      email: emailIdx >= 0 ? (row[emailIdx] || '') : '',
      company: companyIdx >= 0 ? (row[companyIdx] || '') : '',
      source: 'google_sheets',
      status: 'new',
      group_ids: assigned_group_id ? [assigned_group_id] : []
    };

    const lead = await base44.asServiceRole.entities.Lead.create(leadData);
    imported++;

    if (leadIdIdx >= 0) updates.push({ row: r + 1, col: lead_id_column, value: lead.id });
    if (importedIdx >= 0) updates.push({ row: r + 1, col: imported_flag_column, value: '✓' });
  }

  // Batch write flags/ids back
  if (updates.length > 0) {
    const batchData = {
      valueInputOption: 'RAW',
      data: updates.map(u => ({
        range: `${tab_name || 'Sheet1'}!${u.col}${u.row}`,
        values: [[u.value]]
      }))
    };
    await sheetsFetch(
      conn.accessToken,
      `${spreadsheet_id}/values:batchUpdate`,
      { method: 'POST', body: JSON.stringify(batchData) }
    );
  }

  return { imported, skipped };
}

export default async function googleSheetsImport(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));

    // Two modes:
    //  1) Manual: { sync_id } — imports one sync (user-triggered, requires login)
    //  2) Scheduled: no sync_id — imports all enabled syncs (requires CRON_API_KEY)
    let syncs = [];
    if (body?.sync_id) {
      const s = await base44.asServiceRole.entities.GoogleSheetsSync.get(body.sync_id);
      if (s) syncs = [s];
    } else {
      // Cron mode — require CRON_API_KEY via header, query, or body
      const url = new URL(req.url);
      const expectedKey = Deno.env.get('CRON_API_KEY');
      const authHeader = req.headers.get('authorization') || '';
      const bearerKey = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
      const providedKey =
        req.headers.get('x-cron-key') ||
        req.headers.get('x-api-key') ||
        bearerKey ||
        url.searchParams.get('secret') ||
        url.searchParams.get('api_key') ||
        url.searchParams.get('key') ||
        body?.secret ||
        body?.cron_key;
      const isCron = !!(expectedKey && providedKey && providedKey === expectedKey);
      if (!isCron) {
        const user = c.get('jwtPayload').catch(() => null);
        if (!user || user.role !== 'admin') {
          return c.json({ data: { error: 'Forbidden — provide CRON_API_KEY' } }, 403);
        }
      }
      syncs = await base44.asServiceRole.entities.GoogleSheetsSync.filter({ sync_enabled: true });
    }

    const results = [];
    for (const sync of syncs) {
      try {
        const r = await importOneSync(base44, sync);
        await base44.asServiceRole.entities.GoogleSheetsSync.update(sync.id, {
          last_import_at: new Date().toISOString(),
          last_import_count: r.imported,
          total_imported: (sync.total_imported || 0) + r.imported,
          last_error: ''
        });
        results.push({ sync_id: sync.id, ...r });
      } catch (err) {
        await base44.asServiceRole.entities.GoogleSheetsSync.update(sync.id, {
          last_error: err.message,
          last_import_at: new Date().toISOString()
        });
        results.push({ sync_id: sync.id, error: err.message });
      }
    }

    return c.json({ data: { success: true, results } });
  } catch (error) {
    console.error('googleSheetsImport error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};