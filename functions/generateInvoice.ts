import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { jsPDF } from 'npm:jspdf@4.0.0';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { payment_id } = await req.json();
    if (!payment_id) return Response.json({ error: 'payment_id required' }, { status: 400 });

    // Load payment, client data
    const payments = await base44.entities.Payment.filter({ id: payment_id });
    if (payments.length === 0) return Response.json({ error: 'Payment not found' }, { status: 404 });
    const payment = payments[0];

    const clients = await base44.entities.Client.filter({ id: payment.client_id });
    const client = clients.length > 0 ? clients[0] : null;

    // Build PDF
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    // Header
    doc.setFillColor(26, 54, 93); // #1a365d
    doc.rect(0, 0, pageWidth, 45, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.text('VaaniAI', 20, 25);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text('AI-Powered Voice & Sales Platform', 20, 33);

    // Invoice label
    doc.setFontSize(14);
    doc.text('INVOICE', pageWidth - 20, 25, { align: 'right' });
    doc.setFontSize(9);
    doc.text(`#INV-${payment.id.slice(-8).toUpperCase()}`, pageWidth - 20, 33, { align: 'right' });

    // Reset color
    doc.setTextColor(0, 0, 0);

    // Company info
    let y = 60;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('From:', 20, y);
    doc.setFont('helvetica', 'normal');
    doc.text('Vaani AI Pvt Ltd', 20, y + 6);
    doc.text('Ahmedabad, Gujarat, India', 20, y + 12);
    doc.text('CIN: U62099GJ2025PTC161822', 20, y + 18);

    // Bill To
    doc.setFont('helvetica', 'bold');
    doc.text('Bill To:', pageWidth - 80, y);
    doc.setFont('helvetica', 'normal');
    doc.text(client?.company_name || 'N/A', pageWidth - 80, y + 6);
    doc.text(client?.email || 'N/A', pageWidth - 80, y + 12);
    if (client?.phone) doc.text(client.phone, pageWidth - 80, y + 18);

    // Invoice details
    y = 100;
    doc.setDrawColor(200, 200, 200);
    doc.line(20, y, pageWidth - 20, y);
    y += 10;

    doc.setFontSize(9);
    doc.text(`Invoice Date: ${new Date(payment.created_date || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, 20, y);
    doc.text(`Payment ID: ${payment.cashfree_payment_id || payment.cashfree_order_id || '-'}`, pageWidth - 20, y, { align: 'right' });
    y += 6;
    doc.text(`Status: ${payment.status?.toUpperCase()}`, 20, y);
    if (payment.paid_at) {
      doc.text(`Paid On: ${new Date(payment.paid_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, pageWidth - 20, y, { align: 'right' });
    }

    // Table header
    y += 15;
    doc.setFillColor(245, 245, 245);
    doc.rect(20, y - 5, pageWidth - 40, 10, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Description', 25, y + 1);
    doc.text('Amount', pageWidth - 25, y + 1, { align: 'right' });

    // Line items
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.text(payment.description || 'VaaniAI Subscription', 25, y);
    doc.text(`₹${payment.amount?.toLocaleString('en-IN')}`, pageWidth - 25, y, { align: 'right' });

    // Total
    y += 15;
    doc.setDrawColor(200, 200, 200);
    doc.line(pageWidth - 100, y, pageWidth - 20, y);
    y += 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Total:', pageWidth - 100, y);
    doc.text(`₹${payment.amount?.toLocaleString('en-IN')}`, pageWidth - 25, y, { align: 'right' });

    // Footer
    y = 250;
    doc.setDrawColor(200, 200, 200);
    doc.line(20, y, pageWidth - 20, y);
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text('This is a computer-generated invoice and does not require a signature.', pageWidth / 2, y, { align: 'center' });
    doc.text('For queries, contact support@vaaniai.in', pageWidth / 2, y + 5, { align: 'center' });

    const pdfBytes = doc.output('arraybuffer');

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=VaaniAI-Invoice-${payment.id.slice(-8)}.pdf`,
      },
    });
  } catch (error) {
    console.error('Invoice error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});