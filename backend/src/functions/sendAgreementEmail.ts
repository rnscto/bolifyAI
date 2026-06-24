import { Context } from "hono";
import { sendClientEmailLogic } from "./sendClientEmail.ts";

export default async function (c: Context) {
  try {
    const payload = await c.req.json();
    const { type, data } = payload;
    // type: "client_admin_notify" | "partner_signed" | "partner_admin_notify"

    // Default admin email to receive notifications
    const ADMIN_EMAIL = Deno.env.get('ADMIN_NOTIFICATION_EMAIL') || 'yadav.nandkishor73@gmail.com';

    if (type === 'client_admin_notify') {
      const { company_name, email, agreement_number } = data;
      await sendClientEmailLogic({
        from_name: 'Bolify AI',
        to: ADMIN_EMAIL,
        subject: `[Client Agreement Signed] ${company_name} — ${agreement_number}`,
        html: `<p>Client <strong>${company_name}</strong> (${email}) signed service agreement <strong>${agreement_number}</strong>.</p>`
      });
    } else if (type === 'client_gate_admin_notify') {
      const { company_name, email, agreement_number } = data;
      await sendClientEmailLogic({
        from_name: 'Bolify AI',
        to: ADMIN_EMAIL,
        subject: `[Client Agreement Signed] ${company_name} — ${agreement_number}`,
        html: `<p>Existing client <strong>${company_name}</strong> (${email}) signed service agreement <strong>${agreement_number}</strong>.</p>`
      });
    } else if (type === 'partner_signed') {
      const { partner_name, partner_email, agreement_number, signed_timestamp } = data;
      await sendClientEmailLogic({
        from_name: 'Bolify AI',
        to: partner_email,
        subject: `Partner Agreement Signed — ${agreement_number}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#1a365d,#2563eb);padding:24px;border-radius:12px 12px 0 0;text-align:center;">
            <h2 style="color:white;margin:0;">Agreement Signed Successfully</h2>
          </div>
          <div style="padding:24px;background:white;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
            <p>Dear ${partner_name},</p>
            <p>Your <strong>Master Channel Partner Agreement</strong> (${agreement_number}) has been digitally signed on <strong>${signed_timestamp}</strong>.</p>
            <p>You can view and download your signed agreement anytime from your Partner Dashboard.</p>
            <p style="color:#666;font-size:13px;margin-top:20px;">This is a legally binding digital agreement under the Information Technology Act, 2000.</p>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
            <p style="color:#999;font-size:12px;">TECH BRAINBUCKS INFOSOFT PVT LTD | Bolify AI</p>
          </div>
        </div>`
      });
    } else if (type === 'partner_admin_notify') {
      const { partner_name, partner_email, partner_company, agreement_number, signed_timestamp } = data;
      await sendClientEmailLogic({
        from_name: 'Bolify AI',
        to: ADMIN_EMAIL,
        subject: `[Partner Agreement Signed] ${partner_name} — ${agreement_number}`,
        html: `<p>Partner <strong>${partner_name}</strong> (${partner_email}) has signed agreement <strong>${agreement_number}</strong> on ${signed_timestamp}.</p><p>Company: ${partner_company || 'N/A'}</p>`
      });
    } else {
      return c.json({ data: { success: false, error: 'Unknown email type' } });
    }

    return c.json({ data: { success: true } });
  } catch (error: any) {
    console.error('[sendAgreementEmail] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
