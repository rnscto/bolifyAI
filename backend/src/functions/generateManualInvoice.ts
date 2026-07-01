import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { jsPDF } from 'npm:jspdf@4.0.0';

function fmtINR(n) { return (Number(n) || 0).toLocaleString('en-IN'); }
function fmtDate(d) { return new Date(d || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }); }

// jsPDF's built-in Helvetica is Latin-1 only — unicode chars render as "ï¿½".
// Convert common unicode punctuation/symbols to ASCII equivalents.
function asc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/[\u2013\u2014]/g, '-')   // – —  → -
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'") // ‘ ’ ‚ ′ → '
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"') // “ ” „ ″ → "
    .replace(/\u2026/g, '...')         // …  → ...
    .replace(/\u00A0/g, ' ')            // nbsp → space
    .replace(/[\u00D7\u2715\u2716]/g, 'x') // × ✕ ✖ → x
    .replace(/\u20B9/g, 'INR ')         // ₹  → INR
    .replace(/\u20AC/g, 'EUR ')         // €  → EUR
    .replace(/\u00A3/g, 'GBP ')         // £  → GBP
    .replace(/\u00A9/g, '(c)')
    .replace(/\u00AE/g, '(R)')
    .replace(/\u2122/g, '(TM)')
    .replace(/\u2022/g, '*')            // •  → *
    .replace(/[\u2192\u2794]/g, '->')   // →  → ->
    .replace(/[\u2190]/g, '<-')
    // Drop anything else outside printable ASCII to avoid the "ï¿½" replacement char
    .replace(/[^\x20-\x7E\n\r\t]/g, '');
}

async function getCompanySettings(base44) {
  const records = await base44.asServiceRole.entities.CompanySettings.list('-created_date', 1);
  return records[0] || {};
}

function defaults(cs) {
  return {
    name: cs.company_name || 'Vaani AI Pvt Ltd',
    tagline: cs.tagline || 'AI-Powered Voice & Sales Platform',
    cin: cs.cin || 'U62099GJ2025PTC161822',
    gstin: cs.gstin || '24AAJCV8927D1ZP',
    addr1: cs.address_line1 || '',
    addr2: cs.address_line2 || 'Ahmedabad, Gujarat, India',
    website: cs.website || 'www.vaaniai.io',
    email: cs.support_email || 'support@vaaniai.in',
    bank: cs.bank_name || 'HDFC Bank',
    bankAccName: cs.bank_account_name || 'Vaani AI Pvt Ltd',
    bankAccNo: cs.bank_account_number || '50200098765432',
    bankIfsc: cs.bank_ifsc || 'HDFC0001234',
  };
}

export default async function generateManualInvoice(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (user.role !== 'admin') return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);

    const body = await c.req.json();

    // If invoice_id is provided, load the saved ManualInvoice.
    // - When `save` is also true → this is an EDIT: use the edited body fields
    //   and persist them back onto the saved record.
    // - Otherwise → plain re-download: use the saved record's stored fields.
    let saved = null;
    if (body.invoice_id) {
      saved = await base44.asServiceRole.entities.ManualInvoice.get(body.invoice_id);
      if (!saved) return c.json({ data: { error: 'Invoice not found' } }, 404);
    }

    const isEdit = !!(body.invoice_id && body.save === true);
    // For edits, prefer the body (edited values); for re-download use the saved record.
    const src = isEdit ? body : (saved || body);
    const {
      client_id = '',
      client_name,
      client_email = '',
      client_phone = '',
      client_gstin = '',
      client_pan = '',
      client_cin = '',
      client_contact_person = '',
      client_address = '',
      invoice_number,
      invoice_date,
      billing_period = '',
      line_items = [],
      gst_percent = 18,
      apply_gst = true,
      status = 'paid',
      paid_at,
      payment_reference = '',
      notes = '',
      terms = [],
    } = src;
    const default_sac = body.default_sac || '998314';
    const save = body.save === true && !saved;

    if (!client_name) return c.json({ data: { error: 'client_name required' } }, 400);
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return c.json({ data: { error: 'At least one line item required' } }, 400);
    }

    const items = line_items
      .filter(i => i && i.description && Number(i.amount) > 0)
      .map(i => {
        const qty = Number(i.quantity) > 0 ? Number(i.quantity) : 1;
        const unit = Number(i.amount);
        return {
          desc: String(i.description),
          code: i.code ? String(i.code) : '',
          sac: i.sac ? String(i.sac) : default_sac,
          qty,
          unit,
          amount: unit * qty,
        };
      });
    if (items.length === 0) return c.json({ data: { error: 'No valid line items' } }, 400);

    const subtotal = items.reduce((s, i) => s + i.amount, 0);
    const periodLabel = ({
      monthly: 'Monthly',
      quarterly: 'Quarterly',
      half_yearly: 'Half-Yearly',
      yearly: 'Yearly',
      one_time: 'One-Time',
    })[billing_period] || '';
    const gstPct = apply_gst ? Number(gst_percent || 18) : 0;
    const gstAmount = apply_gst ? Math.round(subtotal * gstPct / 100) : 0;
    const total = subtotal + gstAmount;

    const cs = await getCompanySettings(base44);
    const co = defaults(cs);
    const invoiceRef = invoice_number || `INV-M-${Date.now().toString().slice(-8)}`;
    const invDate = invoice_date || new Date().toISOString();

    // Persist new invoice if requested (and not loaded from a saved one)
    let savedId = saved?.id || null;
    if (save && !saved) {
      const created = await base44.asServiceRole.entities.ManualInvoice.create({
        invoice_number: invoiceRef,
        client_id: client_id || '',
        client_name, client_email, client_phone, client_gstin, client_pan, client_cin, client_contact_person, client_address,
        invoice_date: invDate,
        billing_period: billing_period || '',
        line_items: line_items.map(i => ({
          code: i.code || '',
          sac: i.sac || default_sac,
          description: String(i.description || ''),
          amount: Number(i.amount) || 0,
          quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
        })),
        apply_gst: !!apply_gst,
        gst_percent: Number(gst_percent || 0),
        subtotal,
        gst_amount: gstAmount,
        total_amount: total,
        status: status || 'pending',
        paid_at: paid_at || null,
        payment_reference: payment_reference || '',
        notes: notes || '',
        terms: Array.isArray(terms) ? terms : [],
        last_pdf_generated_at: new Date().toISOString(),
      });
      savedId = created?.id || null;
    } else if (saved && isEdit) {
      // EDIT: persist the edited fields back onto the existing invoice
      await base44.asServiceRole.entities.ManualInvoice.update(saved.id, {
        client_id: client_id || '',
        client_name, client_email, client_phone, client_gstin, client_pan, client_cin, client_contact_person, client_address,
        invoice_date: invDate,
        billing_period: billing_period || '',
        line_items: line_items.map(i => ({
          code: i.code || '',
          sac: i.sac || default_sac,
          description: String(i.description || ''),
          amount: Number(i.amount) || 0,
          quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
        })),
        apply_gst: !!apply_gst,
        gst_percent: Number(gst_percent || 0),
        subtotal,
        gst_amount: gstAmount,
        total_amount: total,
        notes: notes || '',
        terms: Array.isArray(terms) ? terms : [],
        last_pdf_generated_at: new Date().toISOString(),
      });
    } else if (saved) {
      // Mark re-generation time on existing invoice (plain re-download)
      await base44.asServiceRole.entities.ManualInvoice.update(saved.id, {
        last_pdf_generated_at: new Date().toISOString(),
      });
    }

    const doc = new jsPDF();
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m = 18, re = pw - m, cw = pw - m * 2;

    // Header — auto-fit company name to avoid overlap with TAX INVOICE block
    doc.setFillColor(17, 38, 68); doc.rect(0, 0, pw, 56, 'F');
    doc.setFillColor(230, 126, 34); doc.rect(0, 56, pw, 3, 'F');

    // Reserve right side for "TAX INVOICE" block (~70mm wide)
    const rightBlockW = 70;
    const nameMaxW = pw - m * 2 - rightBlockW - 4;
    let nameSize = 24;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(nameSize);
    while (nameSize > 13 && doc.getTextWidth(asc(co.name)) > nameMaxW) {
      nameSize -= 1; doc.setFontSize(nameSize);
    }
    doc.setTextColor(255, 255, 255);
    doc.text(asc(co.name), m, 24);

    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(180, 200, 230);
    doc.text(asc(co.tagline), m, 36);
    doc.text(asc(`${co.website}  |  ${co.email}`), m, 44);

    // Right-aligned TAX INVOICE block — pushed lower so it never overlaps the name
    doc.setFontSize(15); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
    doc.text('TAX INVOICE', re, 28, { align: 'right' });
    doc.setFontSize(9); doc.setTextColor(180, 200, 230); doc.setFont('helvetica', 'normal');
    doc.text(asc(`# ${invoiceRef}`), re, 38, { align: 'right' });
    doc.text(asc(`Date: ${fmtDate(invDate)}`), re, 47, { align: 'right' });

    // From / To — boxes auto-grow to fit content (esp. long addresses)
    const boxY = 70;
    const boxW = cw / 2 - 5;
    const innerW = boxW - 16; // padding 8 each side
    const toX = pw / 2 + 5;

    // Pre-compute address line counts so both boxes share the same height
    const fromAddrLines = doc.splitTextToSize(asc(co.addr2 || ''), innerW);
    const billAddrLines = client_address
      ? doc.splitTextToSize(asc(String(client_address)), innerW)
      : [];

    // FROM section content height
    let fromContentH = 18 /* top to first line */
      + fromAddrLines.length * 4
      + 5  /* CIN */
      + 5  /* GSTIN */
      + 4; /* bottom padding */

    // BILL TO section content height
    let billContentH = 18;
    if (client_contact_person) billContentH += 5;
    if (client_email) billContentH += 5;
    if (client_phone) billContentH += 5;
    if (client_gstin) billContentH += 5;
    if (client_pan) billContentH += 5;
    if (client_cin) billContentH += 5;
    if (billAddrLines.length) billContentH += billAddrLines.length * 4;
    billContentH += 4;

    const boxH = Math.max(42, fromContentH, billContentH);

    // FROM
    doc.setFillColor(245, 247, 250); doc.roundedRect(m, boxY - 4, boxW, boxH, 3, 3, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
    doc.text('FROM', m + 8, boxY + 4);
    doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold');
    doc.text(asc(co.name), m + 8, boxY + 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
    let fy = boxY + 18;
    if (fromAddrLines.length) { doc.text(fromAddrLines, m + 8, fy); fy += fromAddrLines.length * 4; }
    doc.text(asc(`CIN: ${co.cin}`), m + 8, fy); fy += 5;
    doc.text(asc(`GSTIN: ${co.gstin}`), m + 8, fy);

    // BILL TO
    doc.setFillColor(245, 247, 250); doc.roundedRect(toX, boxY - 4, boxW, boxH, 3, 3, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
    doc.text('BILL TO', toX + 8, boxY + 4);
    doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold');
    doc.text(asc(client_name), toX + 8, boxY + 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
    let toY = boxY + 18;
    if (client_contact_person) { doc.text(asc(`Attn: ${client_contact_person}`), toX + 8, toY); toY += 5; }
    if (client_email) { doc.text(asc(client_email), toX + 8, toY); toY += 5; }
    if (client_phone) { doc.text(asc(client_phone), toX + 8, toY); toY += 5; }
    if (client_gstin) { doc.text(asc(`GSTIN: ${client_gstin}`), toX + 8, toY); toY += 5; }
    if (client_pan) { doc.text(asc(`PAN: ${client_pan}`), toX + 8, toY); toY += 5; }
    if (client_cin) { doc.text(asc(`CIN: ${client_cin}`), toX + 8, toY); toY += 5; }
    if (billAddrLines.length) { doc.text(billAddrLines, toX + 8, toY); toY += billAddrLines.length * 4; }

    // Meta — positioned below the (now dynamic) From/To boxes
    let y = boxY - 4 + boxH + 6;
    doc.setFillColor(245, 247, 250); doc.roundedRect(m, y - 4, cw, 16, 2, 2, 'F');
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
    doc.text(asc(`Invoice Date: ${fmtDate(invDate)}`), m + 8, y + 5);
    if (periodLabel) doc.text(asc(`Billing: ${periodLabel}`), m + 8 + 70, y + 5);
    if (payment_reference) doc.text(asc(`Payment Ref: ${payment_reference}`), pw / 2, y + 5);
    const sc = status === 'paid' ? [39, 174, 96] : status === 'failed' ? [231, 76, 60] : [243, 156, 18];
    doc.setTextColor(...sc); doc.setFont('helvetica', 'bold');
    doc.text(asc(`${(status || 'pending').toUpperCase()}`), re - 5, y + 5, { align: 'right' });
    if (paid_at) { doc.setTextColor(80, 80, 80); doc.setFont('helvetica', 'normal'); doc.text(asc(`Paid: ${fmtDate(paid_at)}`), m + 8, y + 11); }

    // Table — with SAC, Qty, Unit Price, Amount columns
    y += 24;
    const colNo = m + 3;
    const colDesc = m + 11;
    const colSac = re - 86;
    const colQty = re - 60;
    const colUnit = re - 32;
    const colAmt = re;
    doc.setFillColor(17, 38, 68); doc.roundedRect(m, y - 6, cw, 12, 2, 2, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    doc.text('#', colNo, y);
    doc.text('DESCRIPTION', colDesc, y);
    doc.text('SAC', colSac, y, { align: 'right' });
    doc.text('QTY', colQty, y, { align: 'right' });
    doc.text('UNIT (INR)', colUnit, y, { align: 'right' });
    doc.text('AMOUNT (INR)', colAmt, y, { align: 'right' });

    y += 10;
    doc.setFontSize(9);
    items.forEach((item, idx) => {
      const descAvailW = colSac - colDesc - 6;
      const descMain = asc(item.code ? `[${item.code}] ${item.desc}` : item.desc);
      const descLines = doc.splitTextToSize(descMain, descAvailW);
      const rowH = Math.max(12, 6 + descLines.length * 4);
      if (idx % 2 === 0) { doc.setFillColor(250, 251, 253); doc.rect(m, y - 5, cw, rowH, 'F'); }
      doc.setDrawColor(235, 235, 235); doc.line(m, y + rowH - 5, re, y + rowH - 5);
      doc.setTextColor(100, 100, 100); doc.setFont('helvetica', 'normal');
      doc.text(`${idx + 1}`, colNo, y + 2);
      doc.setTextColor(40, 40, 40);
      doc.text(descLines, colDesc, y + 2);
      doc.setTextColor(100, 100, 100);
      doc.text(asc(item.sac || '-'), colSac, y + 2, { align: 'right' });
      doc.setTextColor(40, 40, 40);
      doc.text(`${item.qty}`, colQty, y + 2, { align: 'right' });
      doc.text(fmtINR(item.unit), colUnit, y + 2, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.text(fmtINR(item.amount), colAmt, y + 2, { align: 'right' });
      y += rowH + 2;
    });

    // Totals
    y += 4;
    const tX = pw - 100, tW = 100 - m;
    const totalsBoxH = apply_gst ? 26 : 18;
    doc.setFillColor(245, 247, 250); doc.roundedRect(tX, y - 3, tW, totalsBoxH, 2, 2, 'F');
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
    doc.text('Subtotal', tX + 5, y + 4); doc.text(`INR ${fmtINR(subtotal)}`, re - 5, y + 4, { align: 'right' });
    if (apply_gst && gstAmount > 0) {
      doc.text(`GST @ ${gstPct}%`, tX + 5, y + 12); doc.text(`INR ${fmtINR(gstAmount)}`, re - 5, y + 12, { align: 'right' });
    }
    const totalY = y + totalsBoxH - 1;
    doc.setFillColor(17, 38, 68); doc.roundedRect(tX, totalY, tW, 14, 0, 0, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('TOTAL', tX + 5, totalY + 9); doc.text(`INR ${fmtINR(total)}`, re - 5, totalY + 9, { align: 'right' });
    y = totalY + 25;

    // Bank
    doc.setFillColor(250, 251, 253); doc.roundedRect(m, y, cw / 2 - 5, 36, 2, 2, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
    doc.text('BANK DETAILS', m + 6, y + 8);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50);
    doc.text(asc(`Bank: ${co.bank}`), m + 6, y + 15);
    doc.text(asc(`A/c Name: ${co.bankAccName}`), m + 6, y + 20);
    doc.text(asc(`A/c No: ${co.bankAccNo}`), m + 6, y + 25);
    doc.text(asc(`IFSC: ${co.bankIfsc}`), m + 6, y + 30);

    // Notes
    if (notes) {
      const nx = pw / 2 + 5;
      doc.setFillColor(255, 248, 230); doc.roundedRect(nx, y, cw / 2 - 5, 36, 2, 2, 'F');
      doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 100, 30);
      doc.text('NOTES', nx + 6, y + 8);
      doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 70, 40);
      const nLines = doc.splitTextToSize(asc(String(notes)), cw / 2 - 18);
      doc.text(nLines.slice(0, 4), nx + 6, y + 15);
    }

    y += 42;

    // Terms & Conditions
    const termsList = (Array.isArray(terms) ? terms : [])
      .map(t => String(t || '').trim())
      .filter(Boolean);
    if (termsList.length > 0) {
      // Page-break safety — leave room for signature + footer
      if (y > ph - 80) { doc.addPage(); y = 20; }
      doc.setFillColor(248, 250, 252); doc.setDrawColor(220, 225, 235);
      const startY = y;
      doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 38, 68);
      doc.text('TERMS & CONDITIONS', m + 4, y + 6);
      doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(70, 70, 70);
      let ty = y + 12;
      termsList.forEach((t, i) => {
        const lines = doc.splitTextToSize(asc(`${i + 1}. ${t}`), cw - 10);
        if (ty + lines.length * 3.4 > ph - 35) return; // skip overflow safely
        doc.text(lines, m + 4, ty);
        ty += lines.length * 3.4 + 1;
      });
      const boxH = Math.max(14, ty - startY + 2);
      doc.roundedRect(m, startY, cw, boxH, 2, 2, 'S');
      y = startY + boxH + 4;
    }

    // Signature
    const sigY = Math.max(y + 2, ph - 45);
    doc.setDrawColor(200, 200, 200); doc.line(re - 70, sigY + 10, re, sigY + 10);
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 38, 68);
    doc.text(asc(`For ${co.name}`), re - 35, sigY + 4, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 100, 100);
    doc.text('Authorized Signatory', re - 35, sigY + 17, { align: 'center' });

    // Footer
    const fY = ph - 14;
    doc.setFillColor(245, 247, 250); doc.rect(0, fY - 4, pw, 20, 'F');
    doc.setDrawColor(230, 126, 34); doc.setLineWidth(0.5); doc.line(0, fY - 4, pw, fY - 4); doc.setLineWidth(0.2);
    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
    doc.text(asc(`${co.name}  |  CIN: ${co.cin}  |  GSTIN: ${co.gstin}`), pw / 2, fY + 2, { align: 'center' });
    doc.text('This is a computer-generated invoice and does not require a physical signature.', pw / 2, fY + 7, { align: 'center' });

    const pdfBytes = doc.output('arraybuffer');
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=VaaniAI-${invoiceRef}.pdf`,
        'X-Invoice-Id': savedId || '',
        'X-Invoice-Number': invoiceRef,
      }
    });
  } catch (error) {
    console.error('Manual invoice error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};