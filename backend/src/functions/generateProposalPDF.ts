import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { jsPDF } from 'npm:jspdf@4.0.0';

function fmtINR(n) { return (n || 0).toLocaleString('en-IN'); }
function fmtDate(d) { return new Date(d || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }); }

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

function drawPDF(doc, co, { docType, refNumber, date, toInfo, title, validUntil, items, subtotal, gstPercent, gstAmount, totalAmount, notes, showBank }) {
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const m = 18, re = pw - m, cw = pw - m * 2;

  // Header
  doc.setFillColor(17, 38, 68);
  doc.rect(0, 0, pw, 52, 'F');
  doc.setFillColor(230, 126, 34);
  doc.rect(0, 52, pw, 3, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(28);
  doc.setFont('helvetica', 'bold');
  doc.text(co.name, m, 28);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(180, 200, 230);
  doc.text(co.tagline, m, 38);
  doc.text(`${co.website}  |  ${co.email}`, m, 46);

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(docType.toUpperCase(), re, 24, { align: 'right' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(180, 200, 230);
  doc.text(refNumber, re, 34, { align: 'right' });
  doc.text(`Date: ${date}`, re, 43, { align: 'right' });

  // From / To
  let y = 66;
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(m, y - 4, cw / 2 - 5, 42, 3, 3, 'F');
  doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
  doc.text('FROM', m + 8, y + 4);
  doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold');
  doc.text(co.name, m + 8, y + 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
  const fromLines = [co.addr2, `CIN: ${co.cin}`, `GSTIN: ${co.gstin}`];
  if (co.addr1) fromLines.unshift(co.addr1);
  fromLines.slice(0, 4).forEach((l, i) => doc.text(l, m + 8, y + 18 + i * 5));

  const toX = pw / 2 + 5;
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(toX, y - 4, cw / 2 - 5, 42, 3, 3, 'F');
  doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
  doc.text('TO', toX + 8, y + 4);
  doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold');
  doc.text(toInfo.name, toX + 8, y + 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
  toInfo.lines.slice(0, 4).forEach((l, i) => doc.text(l, toX + 8, y + 18 + i * 5));

  // Title
  y = 116;
  if (title) { doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 38, 68); doc.text(title, m, y); y += 5; }
  if (validUntil) { doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(130, 130, 130); doc.text(`Valid Until: ${validUntil}`, m, y + 5); y += 5; }

  // Table header
  y += 10;
  doc.setFillColor(17, 38, 68);
  doc.roundedRect(m, y - 6, cw, 12, 2, 2, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
  doc.text('#', m + 2, y); doc.text('DESCRIPTION', m + 16, y); doc.text('QTY', 118, y); doc.text('RATE', 142, y); doc.text('AMOUNT', re, y, { align: 'right' });

  y += 10;
  doc.setFontSize(9);
  items.forEach((item, idx) => {
    if (y > ph - 70) { doc.addPage(); y = 30; }
    if (idx % 2 === 0) { doc.setFillColor(250, 251, 253); doc.rect(m, y - 5, cw, 10, 'F'); }
    doc.setDrawColor(230, 230, 230); doc.line(m, y + 5, re, y + 5);
    doc.setTextColor(100, 100, 100); doc.setFont('helvetica', 'normal');
    doc.text(`${idx + 1}`, m + 2, y + 1);
    doc.setTextColor(40, 40, 40);
    doc.text((item.description || '').substring(0, 55), m + 16, y + 1);
    doc.text(`${item.quantity || 1}`, 120, y + 1);
    doc.text(`${fmtINR(item.unit_price)}`, 142, y + 1);
    doc.setFont('helvetica', 'bold');
    doc.text(`${fmtINR(item.amount)}`, re, y + 1, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    y += 12;
  });

  // Totals
  y += 4;
  const tX = pw - 100, tW = 100 - m;
  doc.setFillColor(245, 247, 250); doc.roundedRect(tX, y - 3, tW, 38, 2, 2, 'F');
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
  doc.text('Subtotal', tX + 5, y + 5); doc.text(`INR ${fmtINR(subtotal)}`, re - 5, y + 5, { align: 'right' });
  doc.text(`GST (${gstPercent || 18}%)`, tX + 5, y + 14); doc.text(`INR ${fmtINR(gstAmount)}`, re - 5, y + 14, { align: 'right' });
  doc.setFillColor(17, 38, 68); doc.roundedRect(tX, y + 20, tW, 12, 0, 0, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('TOTAL', tX + 5, y + 28); doc.text(`INR ${fmtINR(totalAmount)}`, re - 5, y + 28, { align: 'right' });
  y += 42;

  // Bank
  if (showBank) {
    if (y > ph - 60) { doc.addPage(); y = 30; }
    doc.setFillColor(250, 251, 253); doc.roundedRect(m, y, cw / 2 - 5, 36, 2, 2, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
    doc.text('BANK DETAILS', m + 6, y + 8);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50);
    doc.text(`Bank: ${co.bank}`, m + 6, y + 15);
    doc.text(`A/c Name: ${co.bankAccName}`, m + 6, y + 20);
    doc.text(`A/c No: ${co.bankAccNo}`, m + 6, y + 25);
    doc.text(`IFSC: ${co.bankIfsc}`, m + 6, y + 30);
    y += 42;
  }

  // Notes / Terms & Conditions — multi-page aware
  if (notes) {
    if (y > ph - 50) { doc.addPage(); y = 30; }
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 38, 68);
    doc.text('Terms & Conditions', m, y); y += 8;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
    const lineHeight = 4;
    const nl = doc.splitTextToSize(notes, cw);
    for (let i = 0; i < nl.length; i++) {
      if (y > ph - 25) { doc.addPage(); y = 25; }
      doc.text(nl[i], m, y);
      y += lineHeight;
    }
    y += 8;
  }

  // Signature
  const sigY = Math.max(y + 5, ph - 55);
  doc.setDrawColor(200, 200, 200); doc.line(re - 70, sigY + 15, re, sigY + 15);
  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 38, 68);
  doc.text(`For ${co.name}`, re - 35, sigY + 8, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 100, 100);
  doc.text('Authorized Signatory', re - 35, sigY + 22, { align: 'center' });

  // Footer
  const fY = ph - 14;
  doc.setFillColor(245, 247, 250); doc.rect(0, fY - 4, pw, 20, 'F');
  doc.setDrawColor(230, 126, 34); doc.setLineWidth(0.5); doc.line(0, fY - 4, pw, fY - 4); doc.setLineWidth(0.2);
  doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
  doc.text(`${co.name}  |  CIN: ${co.cin}  |  GSTIN: ${co.gstin}`, pw / 2, fY + 2, { align: 'center' });
  doc.text('This is a computer-generated document and does not require a physical signature.', pw / 2, fY + 7, { align: 'center' });
}

export default async function generateProposalPDF(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (user?.role !== 'admin') return c.json({ data: { error: 'Forbidden' } }, 403);

    const { proposal_id } = await c.req.json();
    if (!proposal_id) return c.json({ data: { error: 'proposal_id required' } }, 400);

    const proposals = await base44.asServiceRole.entities.Proposal.filter({ id: proposal_id });
    if (proposals.length === 0) return c.json({ data: { error: 'Not found' } }, 404);
    const proposal = proposals[0];

    const clients = await base44.asServiceRole.entities.Client.filter({ id: proposal.client_id });
    const client = clients[0] || {};

    const cs = await getCompanySettings(base44);
    const co = defaults(cs);
    const isPI = proposal.type === 'proforma_invoice';

    const toLines = [client.email || ''];
    if (client.phone) toLines.push(client.phone);
    if (client.gstin) toLines.push(`GSTIN: ${client.gstin}`);
    if (client.registered_address) toLines.push(client.registered_address.substring(0, 50));

    const doc = new jsPDF();
    drawPDF(doc, co, {
      docType: isPI ? 'Proforma Invoice' : 'Proposal',
      refNumber: proposal.reference_number || '-',
      date: fmtDate(proposal.created_date),
      toInfo: { name: client.company_name || 'N/A', lines: toLines },
      title: proposal.title,
      validUntil: proposal.valid_until ? fmtDate(proposal.valid_until) : null,
      items: proposal.line_items || [],
      subtotal: proposal.subtotal || 0,
      gstPercent: proposal.gst_percent || 18,
      gstAmount: proposal.gst_amount || 0,
      totalAmount: proposal.total_amount || 0,
      notes: proposal.notes,
      showBank: isPI,
    });

    const pdfBytes = doc.output('arraybuffer');
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=${proposal.reference_number || 'VaaniAI-Document'}.pdf`,
      },
    });
  } catch (error) {
    console.error('Proposal PDF error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};