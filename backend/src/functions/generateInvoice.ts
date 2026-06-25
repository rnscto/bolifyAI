import { base44ORM as base44 } from "../db/orm.ts";
import { jsPDF } from "jspdf";

export default async function generateInvoice(c: any) {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { payment_id } = await c.req.json().catch(() => ({}));
    if (!payment_id) {
      return c.json({ data: { error: 'payment_id required' } }, 400);
    }

    // Load payment, client data
    const payment = await base44.entities.Payment.get(payment_id);
    if (!payment) return c.json({ data: { error: 'Payment not found' } }, 404);

    const client = await base44.entities.Client.get(payment.client_id);

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
    doc.text(`#INV-\${payment.id.slice(-8).toUpperCase()}`, pageWidth - 20, 33, { align: 'right' });

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
    doc.text(`Invoice Date: \${new Date(payment.created_at || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, 20, y);
    doc.text(`Payment ID: \${payment.cashfree_payment_id || payment.cashfree_order_id || '-'}`, pageWidth - 20, y, { align: 'right' });
    y += 6;
    doc.text(`Status: \${(payment.status || '').toUpperCase()}`, 20, y);
    if (payment.paid_at) {
      doc.text(`Paid On: \${new Date(payment.paid_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, pageWidth - 20, y, { align: 'right' });
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
    doc.text(`₹\${Number(payment.amount || 0).toLocaleString('en-IN')}`, pageWidth - 25, y, { align: 'right' });

    // Total
    y += 15;
    doc.setDrawColor(200, 200, 200);
    doc.line(pageWidth - 100, y, pageWidth - 20, y);
    y += 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Total:', pageWidth - 100, y);
    doc.text(`₹\${Number(payment.amount || 0).toLocaleString('en-IN')}`, pageWidth - 25, y, { align: 'right' });

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

    return c.body(pdfBytes, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=VaaniAI-Invoice-\${payment.id.slice(-8)}.pdf`,
    });
  } catch (error: any) {
    console.error('Invoice error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
