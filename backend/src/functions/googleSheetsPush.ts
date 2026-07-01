import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const CONNECTOR_ID = '69e9ee7e358cda2752c9b54e';

const colToIdx = (letter) => {
  if (!letter) return -1;
  let idx = 0;
  for (const ch of letter.toUpperCase()) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
};

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

// Find the sheet row for a lead — prefer lead_id column, fall back to phone match
async function findRow(accessToken, sync, lead) {
  const range = `${sync.tab_name || 'Sheet1'}!A1:ZZ10000`;
  const data = await sheetsFetch(accessToken, `${sync.spreadsheet_id}/values/${encodeURIComponent(range)}`);
  const rows = data.values || [];
  const phoneIdx = colToIdx(sync.column_mapping?.phone);
  const leadIdIdx = colToIdx(sync.lead_id_column);
  const targetPhone = normalizePhone(lead.phone);

  for (let r = 0; r < rows.length; r++) {
    if (leadIdIdx >= 0 && rows[r][leadIdIdx] === lead.id) return r + 1;
    if (phoneIdx >= 0 && normalizePhone(rows[r][phoneIdx]) === targetPhone) return r + 1;
  }
  return -1;
}

export default async function googleSheetsPush(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));

    // Triggered from entity automation on Lead update OR CallLog complete
    // Payload: { event, data, old_data } OR manual { lead_id }
    let lead = null;
    let callSummary = '';

    if (body?.lead_id) {
      lead = await base44.asServiceRole.entities.Lead.get(body.lead_id);
    } else if (body?.event?.entity_name === 'Lead') {
      lead = body.data;
      if (!lead && body.event.entity_id) {
        lead = await base44.asServiceRole.entities.Lead.get(body.event.entity_id);
      }
    } else if (body?.event?.entity_name === 'CallLog') {
      const callLog = body.data;
      if (callLog?.lead_id) {
        lead = await base44.asServiceRole.entities.Lead.get(callLog.lead_id);
        callSummary = callLog.conversation_summary || '';
      }
    }

    if (!lead?.client_id) return c.json({ data: { skipped: true, reason: 'no_lead' } });

    // Find an active sync for this client
    const syncs = await base44.asServiceRole.entities.GoogleSheetsSync.filter({
      client_id: lead.client_id,
      push_enabled: true
    });
    if (syncs.length === 0) return c.json({ data: { skipped: true, reason: 'no_sync' } });

    const sync = syncs[0];
    const client = await base44.asServiceRole.entities.Client.get(sync.client_id);
    if (!client?.user_id) return c.json({ data: { skipped: true, reason: 'no_user' } });

    let conn;
    try {
      conn = await base44.asServiceRole.connectors.getCurrentAppUserConnection(CONNECTOR_ID);
    } catch {
      return c.json({ data: { skipped: true, reason: 'not_connected' } });
    }
    if (!conn?.accessToken) return c.json({ data: { skipped: true, reason: 'not_connected' } });

    const rowNum = await findRow(conn.accessToken, sync, lead);
    if (rowNum < 0) return c.json({ data: { skipped: true, reason: 'row_not_found' } });

    // Build updates
    const updates = [];
    const tab = sync.tab_name || 'Sheet1';
    if (sync.status_column) updates.push({ range: `${tab}!${sync.status_column}${rowNum}`, values: [[lead.status || '']] });
    if (sync.score_column) updates.push({ range: `${tab}!${sync.score_column}${rowNum}`, values: [[lead.score ?? '']] });
    if (sync.last_call_column && lead.last_call_date) {
      updates.push({ range: `${tab}!${sync.last_call_column}${rowNum}`, values: [[lead.last_call_date]] });
    }
    if (sync.summary_column && callSummary) {
      updates.push({ range: `${tab}!${sync.summary_column}${rowNum}`, values: [[callSummary]] });
    }

    if (updates.length === 0) return c.json({ data: { skipped: true, reason: 'no_push_columns' } });

    await sheetsFetch(
      conn.accessToken,
      `${sync.spreadsheet_id}/values:batchUpdate`,
      { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) }
    );

    return c.json({ data: { success: true, row: rowNum, updates: updates.length } });
  } catch (error) {
    console.error('googleSheetsPush error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};