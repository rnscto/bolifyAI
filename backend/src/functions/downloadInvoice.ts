import { base44ORM as base44 } from "../db/orm.ts";
import { PDFDocument, rgb, StandardFonts } from "npm:pdf-lib";

export default async function downloadInvoice(c: any) {
  try {
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const invoiceId = c.req.query('id');
    if (!invoiceId) {
      return c.json({ data: { error: 'id required' } }, 400);
    }

    const invoice = await base44.entities.Invoice.get(invoiceId);
    if (!invoice) return c.json({ data: { error: 'Invoice not found' } }, 404);

    // Verify RLS conceptually (or rely on the query if we could)
    if (user.role !== 'master_admin' && user.role !== 'admin') {
      if (invoice.biller_client_id !== user.client_id && invoice.client_id !== user.client_id) {
        return c.json({ data: { error: 'Unauthorized' } }, 403);
      }
    }

    // Load clients
    const receiver = await base44.entities.Client.get(invoice.client_id);
    const sender = await base44.entities.Client.get(invoice.biller_client_id);

    // Build PDF
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

    const senderName = sender?.billing_name || sender?.company_name || 'Biller Company';
    const receiverName = receiver?.billing_name || receiver?.company_name || 'Client Company';

    // Header rect
    page.drawRectangle({
      x: 0, y: 842 - 45,
      width: 595, height: 45,
      color: rgb(26/255, 54/255, 93/255)
    });

    page.drawText(senderName.substring(0, 30), { x: 20, y: 842 - 25, size: 24, font: boldFont, color: rgb(1,1,1) });

    page.drawText('INVOICE', { x: 595 - 20 - 75, y: 842 - 25, size: 14, font, color: rgb(1,1,1) });
    page.drawText(`#${invoice.invoice_number}`, { x: 595 - 20 - 85, y: 842 - 35, size: 9, font, color: rgb(1,1,1) });

    const colorBlack = rgb(0,0,0);
    let y = 842 - 60;

    // Sender Details
    page.drawText('From:', { x: 20, y, size: 10, font: boldFont, color: colorBlack });
    page.drawText(senderName, { x: 20, y: y - 12, size: 10, font, color: colorBlack });
    if (sender?.billing_address) page.drawText(sender.billing_address.substring(0, 40), { x: 20, y: y - 24, size: 10, font, color: colorBlack });
    if (sender?.gstin) page.drawText(`GSTIN: ${sender.gstin}`, { x: 20, y: y - 36, size: 10, font, color: colorBlack });
    if (sender?.pan_number) page.drawText(`PAN: ${sender.pan_number}`, { x: 20, y: y - 48, size: 10, font, color: colorBlack });

    // Receiver Details
    page.drawText('Bill To:', { x: 595 - 200, y, size: 10, font: boldFont, color: colorBlack });
    page.drawText(receiverName, { x: 595 - 200, y: y - 12, size: 10, font, color: colorBlack });
    if (receiver?.billing_address) page.drawText(receiver.billing_address.substring(0, 40), { x: 595 - 200, y: y - 24, size: 10, font, color: colorBlack });
    if (receiver?.gstin) page.drawText(`GSTIN: ${receiver.gstin}`, { x: 595 - 200, y: y - 36, size: 10, font, color: colorBlack });

    y -= 70;
    page.drawLine({
      start: { x: 20, y }, end: { x: 595 - 20, y },
      thickness: 1, color: rgb(200/255, 200/255, 200/255)
    });

    y -= 20;
    page.drawText(`Invoice Date: ${new Date(invoice.issue_date).toLocaleDateString()}`, { x: 20, y, size: 9, font, color: colorBlack });
    page.drawText(`Due Date: ${new Date(invoice.due_date).toLocaleDateString()}`, { x: 595 - 180, y, size: 9, font, color: colorBlack });

    y -= 20;
    page.drawRectangle({
      x: 20, y: y - 5,
      width: 595 - 40, height: 15,
      color: rgb(245/255, 245/255, 245/255)
    });

    page.drawText('Description', { x: 25, y, size: 9, font: boldFont, color: colorBlack });
    page.drawText('Qty', { x: 595 - 180, y, size: 9, font: boldFont, color: colorBlack });
    page.drawText('Rate', { x: 595 - 120, y, size: 9, font: boldFont, color: colorBlack });
    page.drawText('Amount', { x: 595 - 60, y, size: 9, font: boldFont, color: colorBlack });

    y -= 20;
    if (invoice.items && Array.isArray(invoice.items)) {
      invoice.items.forEach((item: any) => {
        page.drawText((item.description || '').substring(0, 50), { x: 25, y, size: 9, font, color: colorBlack });
        page.drawText(String(item.qty || 1), { x: 595 - 180, y, size: 9, font, color: colorBlack });
        page.drawText(`Rs ${Number(item.unit_price || 0).toLocaleString()}`, { x: 595 - 120, y, size: 9, font, color: colorBlack });
        page.drawText(`Rs ${Number(item.total || 0).toLocaleString()}`, { x: 595 - 60, y, size: 9, font, color: colorBlack });
        y -= 15;
      });
    }

    y -= 15;
    page.drawLine({
      start: { x: 595 - 200, y }, end: { x: 595 - 20, y },
      thickness: 1, color: rgb(200/255, 200/255, 200/255)
    });

    y -= 20;
    page.drawText('Subtotal:', { x: 595 - 200, y, size: 10, font, color: colorBlack });
    page.drawText(`Rs ${Number(invoice.subtotal || 0).toLocaleString()}`, { x: 595 - 80, y, size: 10, font, color: colorBlack });

    y -= 15;
    page.drawText('GST Amount:', { x: 595 - 200, y, size: 10, font, color: colorBlack });
    page.drawText(`Rs ${Number(invoice.gst_amount || 0).toLocaleString()}`, { x: 595 - 80, y, size: 10, font, color: colorBlack });

    y -= 15;
    page.drawText('Total:', { x: 595 - 200, y, size: 11, font: boldFont, color: colorBlack });
    page.drawText(`Rs ${Number(invoice.total_amount || 0).toLocaleString()}`, { x: 595 - 80, y, size: 11, font: boldFont, color: colorBlack });

    const pdfBytes = await doc.save();

    return c.body(pdfBytes as any, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=Invoice-${invoice.invoice_number}.pdf`,
    });
  } catch (error: any) {
    console.error('Download Invoice error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
