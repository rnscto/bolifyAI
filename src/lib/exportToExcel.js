// Lightweight Excel-compatible export — generates a .xls file (HTML table format)
// that opens cleanly in Excel/Google Sheets without requiring an extra npm dependency.

function escapeHtml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Export an array of rows to an Excel-compatible file.
 * @param {string} filename - file name (without extension)
 * @param {string[]} headers - array of column header labels
 * @param {Array<Array<any>>} rows - array of row arrays (each inner array matches headers length)
 */
export function exportToExcel(filename, headers, rows) {
  const headerHtml = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const bodyHtml = rows.map(r =>
    `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`
  ).join('');

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8"></head>
<body><table border="1"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></body></html>`;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}_${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function formatDateTime(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); }
  catch { return String(d); }
}