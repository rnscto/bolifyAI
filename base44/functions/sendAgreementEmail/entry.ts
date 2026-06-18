import { createClientFromRequest, createClient } from 'npm:@base44/sdk@0.8.31';

// Send via platform raw SMTP (sendClientEmail with no client_id) — zero integration credits
async function sendEmail(to, subject, htmlBody) {
  const appId = Deno.env.get('BASE44_APP_ID');
  const svc = createClient({ appId, asServiceRole: true });
  await svc.functions.invoke('sendClientEmail', {
    from_name: 'Bolify AI',
    to, subject, html: htmlBody
  });
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { type, data } = await req.json();
    // type: "client_admin_notify" | "partner_signed" | "partner_admin_notify"

    if (type === 'client_admin_notify') {
      // Notify admin when a client signs agreement
      const { company_name, email, agreement_number } = data;
      await sendEmail(
        'yadav.nandkishor73@gmail.com',
        `[Client Agreement Signed] ${company_name} — ${agreement_number}`,
        `<p>Client <strong>${company_name}</strong> (${email}) signed service agreement <strong>${agreement_number}</strong>.</p>`
      );
    } else if (type === 'client_gate_admin_notify') {
      // Notify admin when existing client signs via gate
      const { company_name, email, agreement_number } = data;
      await sendEmail(
        'yadav.nandkishor73@gmail.com',
        `[Client Agreement Signed] ${company_name} — ${agreement_number}`,
        `<p>Existing client <strong>${company_name}</strong> (${email}) signed service agreement <strong>${agreement_number}</strong>.</p>`
      );
    } else if (type === 'partner_signed') {
      // Notify partner that they signed
      const { partner_name, partner_email, agreement_number, signed_timestamp } = data;
      await sendEmail(
        partner_email,
        `Partner Agreement Signed — ${agreement_number}`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
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
      );
    } else if (type === 'partner_admin_notify') {
      // Notify admin when partner signs
      const { partner_name, partner_email, partner_company, agreement_number, signed_timestamp } = data;
      await sendEmail(
        'yadav.nandkishor73@gmail.com',
        `[Partner Agreement Signed] ${partner_name} — ${agreement_number}`,
        `<p>Partner <strong>${partner_name}</strong> (${partner_email}) has signed agreement <strong>${agreement_number}</strong> on ${signed_timestamp}.</p><p>Company: ${partner_company || 'N/A'}</p>`
      );
    } else {
      return Response.json({ error: 'Unknown email type' }, { status: 400 });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('[sendAgreementEmail] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});