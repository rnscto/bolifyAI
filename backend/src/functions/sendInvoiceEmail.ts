import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { jsPDF } from 'npm:jspdf@4.0.0';
import { EmailClient } from 'npm:@azure/communication-email@1.0.0';

const connStr = `endpoint=${Deno.env.get('AZURE_COMM_ENDPOINT')};accesskey=${Deno.env.get('AZURE_COMM_KEY')}`;
const emailClient = new EmailClient(connStr);

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
    addr2: cs.address_line2 || 'Ahmedabad, Gujarat, India',
    website: cs.website || 'www.vaaniai.io',
    email: cs.support_email || 'support@vaaniai.in',
    bank: cs.bank_name || 'HDFC Bank',
    bankAccName: cs.bank_account_name || 'Vaani AI Pvt Ltd',
    bankAccNo: cs.bank_account_number || '50200098765432',
    bankIfsc: cs.bank_ifsc || 'HDFC0001234',
    senderName: cs.sender_email_name || 'VaaniAI',
  };
}

function buildInvoicePDF(doc, co, payment, client) {
  const invoiceRef = `INV-${payment.id.slice(-8).toUpperCase()}`;
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const m = 18, re = pw - m, cw = pw - m * 2;

  // Header
  doc.setFillColor(17, 38, 68); doc.rect(0, 0, pw, 52, 'F');
  doc.setFillColor(230, 126, 34); doc.rect(0, 52, pw, 3, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(28); doc.setFont('helvetica', 'bold');
  doc.text(co.name, m, 28);
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(180, 200, 230);
  doc.text(co.tagline, m, 38); doc.text(`${co.website}  |  ${co.email}`, m, 46);
  doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
  doc.text('TAX INVOICE', re, 24, { align: 'right' });
  doc.setFontSize(9); doc.setTextColor(180, 200, 230); doc.setFont('helvetica', 'normal');
  doc.text(`# ${invoiceRef}`, re, 34, { align: 'right' });
  doc.text(`Date: ${fmtDate(payment.created_date)}`, re, 43, { align: 'right' });

  // From/To
  let y = 66;
  doc.setFillColor(245, 247, 250); doc.roundedRect(m, y - 4, cw / 2 - 5, 38, 3, 3, 'F');
  doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130); doc.text('FROM', m + 8, y + 4);
  doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold'); doc.text(co.name, m + 8, y + 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
  doc.text(co.addr2, m + 8, y + 18); doc.text(`CIN: ${co.cin}  |  GSTIN: ${co.gstin}`, m + 8, y + 23);

  const toX = pw / 2 + 5;
  doc.setFillColor(245, 247, 250); doc.roundedRect(toX, y - 4, cw / 2 - 5, 38, 3, 3, 'F');
  doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130); doc.text('BILL TO', toX + 8, y + 4);
  doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold'); doc.text(client.company_name || 'N/A', toX + 8, y + 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
  doc.text(client.email || '', toX + 8, y + 18);
  if (client.phone) doc.text(client.phone, toX + 8, y + 23);

  // Meta
  y = 112;
  doc.setFillColor(245, 247, 250); doc.roundedRect(m, y - 4, cw, 14, 2, 2, 'F');
  doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
  doc.text(`Invoice Date: ${fmtDate(payment.created_date)}`, m + 8, y + 4);
  doc.text(`Payment ID: ${payment.cashfree_payment_id || payment.cashfree_order_id || '-'}`, pw / 2, y + 4);
  const sc = payment.status === 'paid' ? [39, 174, 96] : [243, 156, 18];
  doc.setTextColor(...sc); doc.setFont('helvetica', 'bold');
  doc.text(`${(payment.status || 'pending').toUpperCase()}`, re - 5, y + 4, { align: 'right' });

  // Table
  y = 136;
  doc.setFillColor(17, 38, 68); doc.roundedRect(m, y - 6, cw, 12, 2, 2, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
  doc.text('#', m + 3, y); doc.text('DESCRIPTION', m + 16, y); doc.text('AMOUNT (INR)', re, y, { align: 'right' });

  y += 10;
  let lineItems = [];
  let subtotal = 0;
  let gstAmount = 0;
  let gstPercent = 18;
  let total = payment.amount;
  let cycleLabel = '';
  try {
    const p = JSON.parse(payment.description);
    const months = p.months || 3;
    cycleLabel = p.billing_cycle ? ` (${p.billing_cycle})` : '';
    lineItems.push({ desc: `Voice AI Agent${cycleLabel} — ${p.channels || 1} Ch x ${months} Mo @ INR ${fmtINR(p.rate_per_channel || 9999)}/mo`, amount: (p.channels || 1) * (p.rate_per_channel || 9999) * months });
    if (p.include_crm) lineItems.push({ desc: `CRM Add-on — ${months} Mo @ INR ${fmtINR(p.crm_rate || 1999)}/mo`, amount: (p.crm_rate || 1999) * months });
    subtotal = p.subtotal ?? lineItems.reduce((s, i) => s + i.amount, 0);
    gstPercent = p.gst_percent ?? 18;
    gstAmount = p.gst_amount ?? Math.round(subtotal * gstPercent / 100);
    total = p.total ?? payment.amount;
  } catch {
    lineItems.push({ desc: payment.description || 'VaaniAI Subscription', amount: payment.amount });
    subtotal = payment.amount;
  }

  doc.setFontSize(9);
  lineItems.forEach((item, idx) => {
    if (idx % 2 === 0) { doc.setFillColor(250, 251, 253); doc.rect(m, y - 5, cw, 12, 'F'); }
    doc.setDrawColor(235, 235, 235); doc.line(m, y + 7, re, y + 7);
    doc.setTextColor(100, 100, 100); doc.setFont('helvetica', 'normal'); doc.text(`${idx + 1}`, m + 3, y + 2);
    doc.setTextColor(40, 40, 40); doc.text(item.desc, m + 16, y + 2);
    doc.setFont('helvetica', 'bold'); doc.text(`${fmtINR(item.amount)}`, re, y + 2, { align: 'right' });
    y += 14;
  });

  // Subtotal + GST breakdown + Total
  y += 4;
  const tX = pw - 100, tW = 100 - m;
  doc.setFillColor(245, 247, 250); doc.roundedRect(tX, y, tW, 28, 2, 2, 'F');
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
  doc.text('Subtotal', tX + 5, y + 7); doc.text(`INR ${fmtINR(subtotal)}`, re - 5, y + 7, { align: 'right' });
  if (gstAmount > 0) {
    doc.text(`GST @ ${gstPercent}%`, tX + 5, y + 14); doc.text(`INR ${fmtINR(gstAmount)}`, re - 5, y + 14, { align: 'right' });
  }
  doc.setDrawColor(220, 220, 220); doc.line(tX + 5, y + 18, re - 5, y + 18);
  doc.setFillColor(17, 38, 68); doc.roundedRect(tX, y + 22, tW, 14, 2, 2, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  doc.text('TOTAL', tX + 5, y + 31); doc.text(`INR ${fmtINR(total)}`, re - 5, y + 31, { align: 'right' });
  y += 44;

  // Bank
  doc.setFillColor(250, 251, 253); doc.roundedRect(m, y, cw / 2 - 5, 30, 2, 2, 'F');
  doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130); doc.text('BANK DETAILS', m + 6, y + 7);
  doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50);
  doc.text(`Bank: ${co.bank}  |  A/c: ${co.bankAccName}`, m + 6, y + 14);
  doc.text(`A/c No: ${co.bankAccNo}  |  IFSC: ${co.bankIfsc}`, m + 6, y + 20);

  // Signature
  const sigY = Math.max(y + 10, ph - 55);
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
  doc.text('Computer-generated invoice. Does not require a physical signature.', pw / 2, fY + 7, { align: 'center' });
}

export default async function sendInvoiceEmail(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    // User auth is best-effort: this function is also called server-to-server from verifyPayment
    // after a successful payment, where there is no end-user session.
    try { c.get('jwtPayload'); } catch { /* ignore — service-role/internal call */ }

    const { payment_id } = await c.req.json();
    if (!payment_id) return c.json({ data: { error: 'payment_id required' } }, 400);

    const payments = await base44.asServiceRole.entities.Payment.filter({ id: payment_id });
    if (payments.length === 0) return c.json({ data: { error: 'Payment not found' } }, 404);
    const payment = payments[0];

    const clients = await base44.asServiceRole.entities.Client.filter({ id: payment.client_id });
    const client = clients[0] || {};
    if (!client.email) return c.json({ data: { error: 'Client has no email' } }, 400);

    const cs = await getCompanySettings(base44);
    const co = defaults(cs);
    const invoiceRef = `INV-${payment.id.slice(-8).toUpperCase()}`;

    const doc = new jsPDF();
    buildInvoicePDF(doc, co, payment, client);
    const pdfBase64 = doc.output('datauristring').split(',')[1];

    const emailHtml = `
          <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <div style="background:linear-gradient(135deg,#112644,#1a365d);padding:30px;">
              <h1 style="color:white;margin:0;font-size:26px;">${co.name}</h1>
              <p style="color:#b4c8e6;margin:5px 0 0;font-size:12px;">${co.tagline}</p>
            </div>
            <div style="padding:30px;">
              <p style="color:#333;font-size:15px;">Dear <strong>${client.company_name || 'Customer'}</strong>,</p>
              <p style="color:#555;font-size:14px;">Please find attached your <strong>Tax Invoice</strong>.</p>
              <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
                <tr style="background:#f8f9fa;"><td style="padding:12px 16px;font-weight:600;color:#666;font-size:13px;border-bottom:1px solid #e5e7eb;">Invoice #</td><td style="padding:12px 16px;font-size:13px;border-bottom:1px solid #e5e7eb;">${invoiceRef}</td></tr>
                <tr><td style="padding:12px 16px;font-weight:600;color:#666;font-size:13px;border-bottom:1px solid #e5e7eb;">Amount</td><td style="padding:12px 16px;font-size:20px;font-weight:700;color:#112644;border-bottom:1px solid #e5e7eb;">INR ${fmtINR(payment.amount)}</td></tr>
                <tr style="background:#f8f9fa;"><td style="padding:12px 16px;font-weight:600;color:#666;font-size:13px;">Status</td><td style="padding:12px 16px;font-size:13px;color:${payment.status === 'paid' ? '#27ae60' : '#f39c12'};font-weight:600;">${(payment.status || 'pending').toUpperCase()}</td></tr>
              </table>
              <p style="color:#555;font-size:13px;">Thank you for your business!</p>
              <p style="color:#333;font-size:14px;margin-top:20px;">Best regards,<br/><strong>${co.name}</strong></p>
            </div>
            <div style="background:#f8f9fa;padding:15px 30px;border-top:2px solid #e67e22;">
              <p style="margin:0;font-size:11px;color:#999;">${co.name}  |  CIN: ${co.cin}  |  GSTIN: ${co.gstin}</p>
            </div>
          </div>`;

    const message = {
      senderAddress: 'DoNotReply@vaaniai.io',
      displayName: co.senderName,
      content: {
        subject: `Tax Invoice ${invoiceRef} — INR ${fmtINR(payment.amount)} — ${co.name}`,
        html: emailHtml,
      },
      recipients: { to: [{ address: client.email }] },
      attachments: [{
        name: `VaaniAI-${invoiceRef}.pdf`,
        contentType: 'application/pdf',
        contentInBase64: pdfBase64,
      }],
    };

    const poller = await emailClient.beginSend(message);
    const result = await poller.pollUntilDone();
    if (result.status !== 'Succeeded') {
      return c.json({ data: { error: 'Failed to send email', details: result.error?.message || result.status } }, 500);
    }

    return c.json({ data: { success: true, sent_to: client.email } });
  } catch (error) {
    console.error('Send invoice error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};