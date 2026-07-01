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

export default async function generateInvoice(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const { payment_id } = await c.req.json();
    if (!payment_id) return c.json({ data: { error: 'payment_id required' } }, 400);

    const payments = await base44.entities.Payment.filter({ id: payment_id });
    if (payments.length === 0) return c.json({ data: { error: 'Payment not found' } }, 404);
    const payment = payments[0];

    const clients = await base44.entities.Client.filter({ id: payment.client_id });
    const client = clients.length > 0 ? clients[0] : {};

    const cs = await getCompanySettings(base44);
    const co = defaults(cs);
    const invoiceRef = `INV-${payment.id.slice(-8).toUpperCase()}`;

    const doc = new jsPDF();
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m = 18, re = pw - m, cw = pw - m * 2;

    // Header
    doc.setFillColor(17, 38, 68); doc.rect(0, 0, pw, 52, 'F');
    doc.setFillColor(230, 126, 34); doc.rect(0, 52, pw, 3, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(28); doc.setFont('helvetica', 'bold');
    doc.text(co.name, m, 28);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(180, 200, 230);
    doc.text(co.tagline, m, 38);
    doc.text(`${co.website}  |  ${co.email}`, m, 46);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
    doc.text('TAX INVOICE', re, 24, { align: 'right' });
    doc.setFontSize(9); doc.setTextColor(180, 200, 230); doc.setFont('helvetica', 'normal');
    doc.text(`# ${invoiceRef}`, re, 34, { align: 'right' });
    doc.text(`Date: ${fmtDate(payment.created_date)}`, re, 43, { align: 'right' });

    // From / To
    let y = 66;
    doc.setFillColor(245, 247, 250); doc.roundedRect(m, y - 4, cw / 2 - 5, 42, 3, 3, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
    doc.text('FROM', m + 8, y + 4);
    doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold');
    doc.text(co.name, m + 8, y + 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
    doc.text(co.addr2, m + 8, y + 18);
    doc.text(`CIN: ${co.cin}`, m + 8, y + 23);
    doc.text(`GSTIN: ${co.gstin}`, m + 8, y + 28);

    const toX = pw / 2 + 5;
    doc.setFillColor(245, 247, 250); doc.roundedRect(toX, y - 4, cw / 2 - 5, 42, 3, 3, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
    doc.text('BILL TO', toX + 8, y + 4);
    doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold');
    doc.text(client.company_name || 'N/A', toX + 8, y + 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
    let toY = y + 18;
    doc.text(client.email || '', toX + 8, toY); toY += 5;
    if (client.phone) { doc.text(client.phone, toX + 8, toY); toY += 5; }
    if (client.gstin) { doc.text(`GSTIN: ${client.gstin}`, toX + 8, toY); toY += 5; }
    if (client.registered_address) doc.text(client.registered_address.substring(0, 40), toX + 8, toY);

    // Meta
    y = 116;
    doc.setFillColor(245, 247, 250); doc.roundedRect(m, y - 4, cw, 16, 2, 2, 'F');
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
    doc.text(`Invoice Date: ${fmtDate(payment.created_date)}`, m + 8, y + 5);
    doc.text(`Payment ID: ${payment.cashfree_payment_id || payment.cashfree_order_id || '-'}`, pw / 2, y + 5);
    const sc = payment.status === 'paid' ? [39, 174, 96] : payment.status === 'failed' ? [231, 76, 60] : [243, 156, 18];
    doc.setTextColor(...sc); doc.setFont('helvetica', 'bold');
    doc.text(`${(payment.status || 'pending').toUpperCase()}`, re - 5, y + 5, { align: 'right' });
    if (payment.paid_at) { doc.setTextColor(80, 80, 80); doc.setFont('helvetica', 'normal'); doc.text(`Paid: ${fmtDate(payment.paid_at)}`, m + 8, y + 11); }

    // Table
    y = 140;
    doc.setFillColor(17, 38, 68); doc.roundedRect(m, y - 6, cw, 12, 2, 2, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    doc.text('#', m + 3, y); doc.text('DESCRIPTION', m + 16, y); doc.text('AMOUNT (INR)', re, y, { align: 'right' });

    y += 10;
    let lineItems = [];
    let subtotal = 0;
    let gstAmount = 0;
    let gstPercent = 18;
    let total = payment.amount;
    try {
      const p = JSON.parse(payment.description);
      const months = p.months || 3;
      const cycleLabel = p.billing_cycle ? ` (${p.billing_cycle})` : '';
      lineItems.push({ desc: `Voice AI Agent${cycleLabel} — ${p.channels || 1} Ch x ${months} Mo @ INR ${fmtINR(p.rate_per_channel || 9999)}/mo`, amount: (p.channels || 1) * (p.rate_per_channel || 9999) * months });
      if (p.include_crm) lineItems.push({ desc: `CRM Add-on — ${months} Mo @ INR ${fmtINR(p.crm_rate || 1999)}/mo`, amount: (p.crm_rate || 1999) * months });
      subtotal = p.subtotal ?? lineItems.reduce((s, i) => s + i.amount, 0);
      gstPercent = p.gst_percent ?? 18;
      gstAmount = p.gst_amount ?? Math.round(subtotal * gstPercent / 100);
      total = p.total ?? payment.amount;
    } catch {
      lineItems.push({ desc: payment.description || 'VaaniAI Subscription', amount: payment.amount || 0 });
      subtotal = payment.amount || 0;
    }

    doc.setFontSize(9);
    lineItems.forEach((item, idx) => {
      if (idx % 2 === 0) { doc.setFillColor(250, 251, 253); doc.rect(m, y - 5, cw, 12, 'F'); }
      doc.setDrawColor(235, 235, 235); doc.line(m, y + 7, re, y + 7);
      doc.setTextColor(100, 100, 100); doc.setFont('helvetica', 'normal');
      doc.text(`${idx + 1}`, m + 3, y + 2);
      doc.setTextColor(40, 40, 40); doc.text(item.desc, m + 16, y + 2);
      doc.setFont('helvetica', 'bold'); doc.text(`${fmtINR(item.amount)}`, re, y + 2, { align: 'right' });
      y += 14;
    });

    // Totals with GST breakdown
    y += 4;
    const tX = pw - 100, tW = 100 - m;
    doc.setFillColor(245, 247, 250); doc.roundedRect(tX, y - 3, tW, 26, 2, 2, 'F');
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
    doc.text('Subtotal', tX + 5, y + 4); doc.text(`INR ${fmtINR(subtotal)}`, re - 5, y + 4, { align: 'right' });
    if (gstAmount > 0) {
      doc.text(`GST @ ${gstPercent}%`, tX + 5, y + 12); doc.text(`INR ${fmtINR(gstAmount)}`, re - 5, y + 12, { align: 'right' });
    }
    doc.setFillColor(17, 38, 68); doc.roundedRect(tX, y + 25, tW, 14, 0, 0, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('TOTAL', tX + 5, y + 34); doc.text(`INR ${fmtINR(total)}`, re - 5, y + 34, { align: 'right' });
    y += 50;

    // Bank
    doc.setFillColor(250, 251, 253); doc.roundedRect(m, y, cw / 2 - 5, 36, 2, 2, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130);
    doc.text('BANK DETAILS', m + 6, y + 8);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50);
    doc.text(`Bank: ${co.bank}`, m + 6, y + 15);
    doc.text(`A/c Name: ${co.bankAccName}`, m + 6, y + 20);
    doc.text(`A/c No: ${co.bankAccNo}`, m + 6, y + 25);
    doc.text(`IFSC: ${co.bankIfsc}`, m + 6, y + 30);

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
    doc.text('This is a computer-generated invoice and does not require a physical signature.', pw / 2, fY + 7, { align: 'center' });

    const pdfBytes = doc.output('arraybuffer');
    return new Response(pdfBytes, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename=VaaniAI-${invoiceRef}.pdf` } });
  } catch (error) {
    console.error('Invoice error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};