import { base44ORM as base44 } from "../db/orm.ts";
import { PDFDocument, rgb, StandardFonts } from "npm:pdf-lib";

export default async function generateInvoice(c: any) {
  try {
    const user = c.get('jwtPayload');
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
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]); // A4
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    
    // Header rect
    page.drawRectangle({
      x: 0, y: 842 - 45,
      width: 595, height: 45,
      color: rgb(26/255, 54/255, 93/255)
    });

    page.drawText('VaaniAI', { x: 20, y: 842 - 25, size: 24, font: boldFont, color: rgb(1,1,1) });
    page.drawText('AI-Powered Voice & Sales Platform', { x: 20, y: 842 - 35, size: 10, font, color: rgb(1,1,1) });

    page.drawText('INVOICE', { x: 595 - 20 - 75, y: 842 - 25, size: 14, font, color: rgb(1,1,1) });
    page.drawText(`#INV-${payment.id.slice(-8).toUpperCase()}`, { x: 595 - 20 - 85, y: 842 - 35, size: 9, font, color: rgb(1,1,1) });
    
    const colorBlack = rgb(0,0,0);
    let y = 842 - 60;
    
    page.drawText('From:', { x: 20, y, size: 10, font: boldFont, color: colorBlack });
    page.drawText('Vaani AI Pvt Ltd', { x: 20, y: y - 12, size: 10, font, color: colorBlack });
    page.drawText('Ahmedabad, Gujarat, India', { x: 20, y: y - 24, size: 10, font, color: colorBlack });
    page.drawText('CIN: U62099GJ2025PTC161822', { x: 20, y: y - 36, size: 10, font, color: colorBlack });

    page.drawText('Bill To:', { x: 595 - 180, y, size: 10, font: boldFont, color: colorBlack });
    page.drawText(client?.company_name || 'N/A', { x: 595 - 180, y: y - 12, size: 10, font, color: colorBlack });
    page.drawText(client?.email || 'N/A', { x: 595 - 180, y: y - 24, size: 10, font, color: colorBlack });
    if (client?.phone) page.drawText(client.phone, { x: 595 - 180, y: y - 36, size: 10, font, color: colorBlack });

    y -= 60;
    page.drawLine({
      start: { x: 20, y }, end: { x: 595 - 20, y },
      thickness: 1, color: rgb(200/255, 200/255, 200/255)
    });
    
    y -= 20;
    page.drawText(`Invoice Date: ${new Date(payment.created_at || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, { x: 20, y, size: 9, font, color: colorBlack });
    page.drawText(`Payment ID: ${payment.cashfree_payment_id || payment.cashfree_order_id || '-'}`, { x: 595 - 180, y, size: 9, font, color: colorBlack });
    
    y -= 12;
    page.drawText(`Status: ${(payment.status || '').toUpperCase()}`, { x: 20, y, size: 9, font, color: colorBlack });
    if (payment.paid_at) {
      page.drawText(`Paid On: ${new Date(payment.paid_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, { x: 595 - 180, y, size: 9, font, color: colorBlack });
    }

    y -= 20;
    page.drawRectangle({
      x: 20, y: y - 5,
      width: 595 - 40, height: 15,
      color: rgb(245/255, 245/255, 245/255)
    });
    
    page.drawText('Description', { x: 25, y, size: 9, font: boldFont, color: colorBlack });
    page.drawText('Amount', { x: 595 - 60, y, size: 9, font: boldFont, color: colorBlack });
    
    y -= 20;
    page.drawText(payment.description || 'VaaniAI Subscription', { x: 25, y, size: 9, font, color: colorBlack });
    page.drawText(`Rs ${Number(payment.amount || 0).toLocaleString('en-IN')}`, { x: 595 - 60, y, size: 9, font, color: colorBlack });
    
    y -= 30;
    page.drawLine({
      start: { x: 595 - 120, y }, end: { x: 595 - 20, y },
      thickness: 1, color: rgb(200/255, 200/255, 200/255)
    });
    
    y -= 20;
    page.drawText('Total:', { x: 595 - 120, y, size: 11, font: boldFont, color: colorBlack });
    page.drawText(`Rs ${Number(payment.amount || 0).toLocaleString('en-IN')}`, { x: 595 - 80, y, size: 11, font: boldFont, color: colorBlack });

    // Footer
    y = 50;
    page.drawLine({
      start: { x: 20, y }, end: { x: 595 - 20, y },
      thickness: 1, color: rgb(200/255, 200/255, 200/255)
    });
    
    y -= 15;
    page.drawText('This is a computer-generated invoice and does not require a signature.', { x: 595/2 - 120, y, size: 8, font, color: rgb(120/255, 120/255, 120/255) });
    page.drawText('For queries, contact support@vaaniai.in', { x: 595/2 - 70, y: y - 10, size: 8, font, color: rgb(120/255, 120/255, 120/255) });

    const pdfBytes = await doc.save();

    return c.body(pdfBytes as any, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=VaaniAI-Invoice-${payment.id.slice(-8)}.pdf`,
    });
  } catch (error: any) {
    console.error('Invoice error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }
}
