import { client } from "../db/index.ts";

export async function sendEmail(to: string, subject: string, bodyText: string, bodyHtml?: string, clientId?: string): Promise<boolean> {
  let provider = "resend";
  let apiKey = Deno.env.get("EMAIL_API_KEY") || "";
  let fromAddress = Deno.env.get("EMAIL_FROM") || "no-reply@bolifyai.com";
  let fromName = "Bolify AI";
  let domain = "";

  // Try to load client specific config
  if (clientId) {
    const res = await client.queryObject(
      `SELECT * FROM "clientmessagingconfig" WHERE client_id = $1 LIMIT 1`,
      [clientId]
    );
    const config = res.rows[0] as any;
    if (config && config.email_provider) {
      provider = config.email_provider;
      if (config.email_api_key) apiKey = config.email_api_key;
      if (config.email_from_address) fromAddress = config.email_from_address;
      if (config.email_from_name) fromName = config.email_from_name;
      if (config.email_domain) domain = config.email_domain;
    }
  }

  if (!apiKey) {
    console.warn(`[Email] API Key missing for client ${clientId || "global"}. Mocking email to ${to} (Subject: ${subject})`);
    return true;
  }

  const senderString = fromName ? `${fromName} <${fromAddress}>` : fromAddress;

  try {
    if (provider === "resend") {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: senderString,
          to: [to],
          subject: subject,
          text: bodyText,
          html: bodyHtml || bodyText
        })
      });
      const errData = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errData.message || JSON.stringify(errData));
      console.log(`[Email - Resend] Successfully sent email to ${to}`);
      return true;

    } else if (provider === "sendgrid") {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromAddress, name: fromName },
          subject: subject,
          content: [
            { type: "text/plain", value: bodyText },
            { type: "text/html", value: bodyHtml || bodyText }
          ]
        })
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.errors?.[0]?.message || "SendGrid Error");
      }
      console.log(`[Email - SendGrid] Successfully sent email to ${to}`);
      return true;

    } else if (provider === "mailgun") {
      if (!domain) throw new Error("Mailgun requires a configured domain.");
      const url = `https://api.mailgun.net/v3/${domain}/messages`;
      
      const body = new URLSearchParams();
      body.append("from", senderString);
      body.append("to", to);
      body.append("subject", subject);
      body.append("text", bodyText);
      if (bodyHtml) body.append("html", bodyHtml);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${btoa("api:" + apiKey)}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Mailgun Error");
      console.log(`[Email - Mailgun] Successfully sent email to ${to}. ID: ${data.id}`);
      return true;
    }

    throw new Error(`Unsupported Email Provider: ${provider}`);
  } catch (error: any) {
    console.error(`[Email] Error sending via ${provider}:`, error.message);
    return false;
  }
}
