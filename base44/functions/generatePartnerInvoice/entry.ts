import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { jsPDF } from 'npm:jspdf@4.0.0';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id' } });
  }

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { payout_id } = await req.json();
    if (!payout_id) return Response.json({ error: 'payout_id required' }, { status: 400 });

    // Get payout and partner data
    const payouts = await base44.asServiceRole.entities.PartnerPayout.filter({ id: payout_id });
    if (payouts.length === 0) return Response.json({ error: 'Payout not found' }, { status: 404 });
    const payout = payouts[0];

    const partners = await base44.asServiceRole.entities.Partner.filter({ id: payout.partner_id });
    if (partners.length === 0) return Response.json({ error: 'Partner not found' }, { status: 404 });
    const partner = partners[0];

    // Generate PDF Invoice
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    // Header
    doc.setFontSize(24);
    doc.setTextColor(26, 54, 93); // #1a365d
    doc.text('VaaniAI', 20, 25);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text('AI Voice Agent Platform', 20, 32);
    doc.text('www.vaaniai.io', 20, 37);

    // Invoice title
    doc.setFontSize(20);
    doc.setTextColor(0);
    doc.text('COMMISSION INVOICE', pageWidth - 20, 25, { align: 'right' });

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Invoice #: ${payout.invoice_number || 'N/A'}`, pageWidth - 20, 33, { align: 'right' });
    doc.text(`Date: ${new Date().toLocaleDateString('en-IN')}`, pageWidth - 20, 39, { align: 'right' });

    // Line
    doc.setDrawColor(200);
    doc.line(20, 45, pageWidth - 20, 45);

    // Partner details
    let y = 55;
    doc.setFontSize(11);
    doc.setTextColor(0);
    doc.text('Bill To:', 20, y);
    doc.setFontSize(10);
    doc.setTextColor(60);
    y += 7;
    doc.text(partner.name, 20, y);
    if (partner.company_name) { y += 5; doc.text(partner.company_name, 20, y); }
    y += 5; doc.text(partner.email, 20, y);
    if (partner.phone) { y += 5; doc.text(partner.phone, 20, y); }
    if (partner.gst_number) { y += 5; doc.text(`GST: ${partner.gst_number}`, 20, y); }
    if (partner.pan_number) { y += 5; doc.text(`PAN: ${partner.pan_number}`, 20, y); }

    // Period
    doc.setFontSize(11);
    doc.setTextColor(0);
    doc.text('Period:', pageWidth / 2, 55);
    doc.setFontSize(10);
    doc.setTextColor(60);
    const periodText = payout.period_start && payout.period_end
      ? `${new Date(payout.period_start).toLocaleDateString('en-IN')} — ${new Date(payout.period_end).toLocaleDateString('en-IN')}`
      : 'N/A';
    doc.text(periodText, pageWidth / 2, 62);
    doc.text(`Payment: ${(payout.payment_method || 'bank_transfer').replace('_', ' ').toUpperCase()}`, pageWidth / 2, 69);

    // Table
    y = Math.max(y, 85) + 15;
    doc.setFillColor(26, 54, 93);
    doc.rect(20, y, pageWidth - 40, 8, 'F');
    doc.setTextColor(255);
    doc.setFontSize(9);
    doc.text('Description', 25, y + 6);
    doc.text('Rate', 110, y + 6);
    doc.text('Amount (INR)', pageWidth - 25, y + 6, { align: 'right' });

    // Row
    y += 12;
    doc.setTextColor(0);
    doc.setFontSize(10);
    doc.text(`Partner Commission (${partner.commission_rate || 20}% Revenue Share)`, 25, y + 4);
    doc.text(`${partner.commission_rate || 20}%`, 110, y + 4);
    doc.text(`₹${(payout.amount || 0).toLocaleString('en-IN')}`, pageWidth - 25, y + 4, { align: 'right' });

    // Totals
    y += 20;
    doc.setDrawColor(200);
    doc.line(110, y, pageWidth - 20, y);
    y += 8;
    doc.text('Gross Amount:', 110, y);
    doc.text(`₹${(payout.amount || 0).toLocaleString('en-IN')}`, pageWidth - 25, y, { align: 'right' });
    y += 7;
    doc.text('TDS Deducted:', 110, y);
    doc.text(`₹${(payout.tds_amount || 0).toLocaleString('en-IN')}`, pageWidth - 25, y, { align: 'right' });
    y += 2;
    doc.setDrawColor(0);
    doc.line(110, y + 2, pageWidth - 20, y + 2);
    y += 9;
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text('Net Payable:', 110, y);
    doc.text(`₹${(payout.net_amount || 0).toLocaleString('en-IN')}`, pageWidth - 25, y, { align: 'right' });

    // Bank details
    y += 20;
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100);
    if (partner.bank_name) {
      doc.text('Payment Details:', 20, y);
      y += 5;
      doc.text(`Bank: ${partner.bank_name} | A/C: ${partner.bank_account_number || 'N/A'} | IFSC: ${partner.bank_ifsc || 'N/A'}`, 20, y);
      if (partner.upi_id) { y += 5; doc.text(`UPI: ${partner.upi_id}`, 20, y); }
    }

    // Footer
    y = 270;
    doc.setTextColor(150);
    doc.setFontSize(8);
    doc.text('This is a system-generated invoice from VaaniAI Partner Program.', pageWidth / 2, y, { align: 'center' });
    doc.text('For queries, contact partners@vaaniai.io', pageWidth / 2, y + 4, { align: 'center' });

    const pdfBytes = doc.output('arraybuffer');

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=${payout.invoice_number || 'invoice'}.pdf`
      }
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});