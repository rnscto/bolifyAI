import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


const CONNECTOR_ID = '69e9ee7e358cda2752c9b54e';

// Fetch spreadsheet metadata (title, tabs, header row) — used by the UI
// to help the client map columns after connecting.
export default async function googleSheetsMeta(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { spreadsheet_id, tab_name, header_row } = await c.req.json();
    if (!spreadsheet_id) return c.json({ data: { error: 'spreadsheet_id required' } }, 400);

    let conn;
    try {
      conn = await base44.asServiceRole.connectors.getCurrentAppUserConnection(CONNECTOR_ID);
    } catch {
      return c.json({ data: { error: 'Google Sheets not connected. Please click Connect Google Sheets first.' } }, 400);
    }
    if (!conn?.accessToken) return c.json({ data: { error: 'Google Sheets not connected' } }, 400);

    // 1) Get spreadsheet metadata (title + sheet tabs)
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet_id}?fields=properties.title,sheets.properties.title`,
      { headers: { Authorization: `Bearer ${conn.accessToken}` } }
    );
    if (!metaRes.ok) {
      const errText = await metaRes.text();
      console.error(`[googleSheetsMeta] Sheets API ${metaRes.status} for spreadsheet=${spreadsheet_id}: ${errText}`);
      let friendly = `Sheets API error ${metaRes.status}`;
      if (metaRes.status === 404) friendly = 'Spreadsheet not found. Check the URL/ID and make sure the connected Google account has access to this sheet.';
      else if (metaRes.status === 403) friendly = 'Permission denied. Reconnect Google Sheets and approve the spreadsheet read/write permission.';
      else if (metaRes.status === 401) friendly = 'Google Sheets connection expired. Please disconnect and reconnect.';
      else friendly = `Sheets API ${metaRes.status}: ${errText.slice(0, 200)}`;
      return c.json({ data: { error: friendly } }, 200);
    }
    const meta = await metaRes.json();
    const title = meta?.properties?.title || '';
    const tabs = (meta?.sheets || []).map(s => s.properties.title);

    // 2) Fetch header row of the selected tab
    const tab = tab_name || tabs[0] || 'Sheet1';
    const hrow = header_row || 1;
    const range = `${tab}!${hrow}:${hrow}`;
    const hRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheet_id}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${conn.accessToken}` } }
    );
    if (!hRes.ok) {
      const errText = await hRes.text();
      console.error(`[googleSheetsMeta] Header fetch ${hRes.status} for tab="${tab}" range="${range}": ${errText}`);
    }
    const hData = hRes.ok ? await hRes.json() : { values: [] };
    const headers = hData.values?.[0] || [];

    // Build A, B, C... labels for the dropdown
    const colLetter = (i) => {
      let n = i, s = '';
      do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
      return s;
    };
    const columns = headers.map((h, i) => ({
      letter: colLetter(i),
      index: i,
      name: h || `Column ${i + 1}`
    }));

    // Auto-detect common lead fields by header name (case-insensitive, fuzzy)
    const detect = (patterns) => {
      const found = columns.find(c => {
        const n = (c.name || '').toLowerCase().trim();
        return patterns.some(p => n === p || n.includes(p));
      });
      return found?.letter || '';
    };
    const suggested_mapping = {
      phone: detect(['phone', 'mobile', 'contact', 'number', 'whatsapp']),
      name: detect(['name', 'full name', 'first name', 'customer', 'lead name']),
      email: detect(['email', 'e-mail', 'mail']),
      company: detect(['company', 'organization', 'business', 'firm']),
    };
    // Suggest the next empty columns after data for push-back (e.g. column right after last header)
    const nextEmptyLetter = colLetter(columns.length);
    const suggested_push = {
      status_column: nextEmptyLetter,
      score_column: colLetter(columns.length + 1),
      last_call_column: colLetter(columns.length + 2),
      summary_column: colLetter(columns.length + 3),
      imported_flag_column: colLetter(columns.length + 4),
      lead_id_column: colLetter(columns.length + 5),
    };

    return c.json({ data: { title, tabs, columns, suggested_mapping, suggested_push } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};