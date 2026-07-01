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

function buildPDF(doc, co, proposal, client) {
  const isPI = proposal.type === 'proforma_invoice';
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
  doc.text(isPI ? 'PROFORMA INVOICE' : 'PROPOSAL', re, 24, { align: 'right' });
  doc.setFontSize(9); doc.setTextColor(180, 200, 230); doc.setFont('helvetica', 'normal');
  doc.text(proposal.reference_number || '-', re, 34, { align: 'right' });
  doc.text(`Date: ${fmtDate(proposal.created_date)}`, re, 43, { align: 'right' });

  // From / To
  let y = 66;
  doc.setFillColor(245, 247, 250); doc.roundedRect(m, y - 4, cw / 2 - 5, 38, 3, 3, 'F');
  doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130); doc.text('FROM', m + 8, y + 4);
  doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold'); doc.text(co.name, m + 8, y + 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
  doc.text(co.addr2, m + 8, y + 18); doc.text(`GSTIN: ${co.gstin}`, m + 8, y + 23);

  const toX = pw / 2 + 5;
  doc.setFillColor(245, 247, 250); doc.roundedRect(toX, y - 4, cw / 2 - 5, 38, 3, 3, 'F');
  doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130); doc.text('TO', toX + 8, y + 4);
  doc.setFontSize(10); doc.setTextColor(17, 38, 68); doc.setFont('helvetica', 'bold'); doc.text(client.company_name || 'N/A', toX + 8, y + 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
  doc.text(client.email || '', toX + 8, y + 18);
  if (client.phone) doc.text(client.phone, toX + 8, y + 23);

  // Title
  y = 112;
  doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 38, 68);
  doc.text(proposal.title || '', m, y);
  if (proposal.valid_until) { doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(130, 130, 130); doc.text(`Valid Until: ${fmtDate(proposal.valid_until)}`, m, y + 7); }

  // Table
  y += 16;
  doc.setFillColor(17, 38, 68); doc.roundedRect(m, y - 6, cw, 12, 2, 2, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
  doc.text('#', m + 3, y); doc.text('DESCRIPTION', m + 16, y); doc.text('QTY', 118, y); doc.text('RATE', 138, y); doc.text('AMOUNT', re, y, { align: 'right' });

  y += 10;
  (proposal.line_items || []).forEach((item, idx) => {
    if (y > ph - 70) { doc.addPage(); y = 30; }
    if (idx % 2 === 0) { doc.setFillColor(250, 251, 253); doc.rect(m, y - 5, cw, 11, 'F'); }
    doc.setDrawColor(235, 235, 235); doc.line(m, y + 6, re, y + 6);
    doc.setFontSize(9); doc.setTextColor(100, 100, 100); doc.setFont('helvetica', 'normal');
    doc.text(`${idx + 1}`, m + 3, y + 1); doc.setTextColor(40, 40, 40);
    doc.text((item.description || '').substring(0, 50), m + 16, y + 1);
    doc.text(`${item.quantity || 1}`, 120, y + 1); doc.text(`${fmtINR(item.unit_price)}`, 138, y + 1);
    doc.setFont('helvetica', 'bold'); doc.text(`${fmtINR(item.amount)}`, re, y + 1, { align: 'right' });
    y += 12;
  });

  // Totals
  y += 4;
  const tX = pw - 100, tW = 100 - m;
  doc.setFillColor(245, 247, 250); doc.roundedRect(tX, y - 3, tW, 28, 2, 2, 'F');
  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
  doc.text('Subtotal', tX + 5, y + 5); doc.text(`INR ${fmtINR(proposal.subtotal)}`, re - 5, y + 5, { align: 'right' });
  doc.text(`GST (${proposal.gst_percent || 18}%)`, tX + 5, y + 13); doc.text(`INR ${fmtINR(proposal.gst_amount)}`, re - 5, y + 13, { align: 'right' });
  doc.setFillColor(17, 38, 68); doc.roundedRect(tX, y + 28, tW, 14, 0, 0, 'F');
  doc.setTextColor(255, 255, 255); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  doc.text('TOTAL', tX + 5, y + 37); doc.text(`INR ${fmtINR(proposal.total_amount)}`, re - 5, y + 37, { align: 'right' });
  y += 50;

  if (isPI) {
    doc.setFillColor(250, 251, 253); doc.roundedRect(m, y, cw / 2 - 5, 32, 2, 2, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(130, 130, 130); doc.text('BANK DETAILS', m + 6, y + 7);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50);
    doc.text(`Bank: ${co.bank}  |  A/c: ${co.bankAccName}`, m + 6, y + 14);
    doc.text(`A/c No: ${co.bankAccNo}  |  IFSC: ${co.bankIfsc}`, m + 6, y + 20);
    y += 38;
  }

  if (proposal.notes) {
    if (y > ph - 50) { doc.addPage(); y = 30; }
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 38, 68); doc.text('Terms & Conditions', m, y); y += 6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
    const nl = doc.splitTextToSize(proposal.notes, cw); doc.text(nl, m, y);
  }

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
  doc.text('Computer-generated document. Does not require a physical signature.', pw / 2, fY + 7, { align: 'center' });
}

export default async function sendProposalEmail(c: any) {
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
    if (!client.email) return c.json({ data: { error: 'Client has no email' } }, 400);

    const cs = await getCompanySettings(base44);
    const co = defaults(cs);
    const isPI = proposal.type === 'proforma_invoice';
    const docLabel = isPI ? 'Proforma Invoice' : 'Proposal';

    const doc = new jsPDF();
    buildPDF(doc, co, proposal, client);
    const pdfBase64 = doc.output('datauristring').split(',')[1];

    const emailHtml = `
          <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <div style="background:linear-gradient(135deg,#112644,#1a365d);padding:30px;">
              <h1 style="color:white;margin:0;font-size:26px;">${co.name}</h1>
              <p style="color:#b4c8e6;margin:5px 0 0;font-size:12px;">${co.tagline}</p>
            </div>
            <div style="padding:30px;">
              <p style="color:#333;font-size:15px;">Dear <strong>${client.company_name || 'Customer'}</strong>,</p>
              <p style="color:#555;font-size:14px;">Please find attached your <strong>${docLabel}</strong>.</p>
              <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
                <tr style="background:#f8f9fa;"><td style="padding:12px 16px;font-weight:600;color:#666;font-size:13px;border-bottom:1px solid #e5e7eb;">Reference</td><td style="padding:12px 16px;font-size:13px;border-bottom:1px solid #e5e7eb;">${proposal.reference_number}</td></tr>
                <tr><td style="padding:12px 16px;font-weight:600;color:#666;font-size:13px;border-bottom:1px solid #e5e7eb;">Title</td><td style="padding:12px 16px;font-size:13px;border-bottom:1px solid #e5e7eb;">${proposal.title}</td></tr>
                <tr style="background:#f8f9fa;"><td style="padding:12px 16px;font-weight:600;color:#666;font-size:13px;">Amount</td><td style="padding:12px 16px;font-size:20px;font-weight:700;color:#112644;">INR ${fmtINR(proposal.total_amount)}</td></tr>
              </table>
              <p style="color:#555;font-size:13px;">Contact <a href="mailto:${co.email}" style="color:#e67e22;">${co.email}</a> for queries.</p>
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
        subject: `${docLabel}: ${proposal.title} — ${proposal.reference_number}`,
        html: emailHtml,
      },
      recipients: { to: [{ address: client.email }] },
      attachments: [{
        name: `${proposal.reference_number}.pdf`,
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
    console.error('Send proposal error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};