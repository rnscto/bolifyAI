export async function sendEmail(to: string, subject: string, bodyText: string, bodyHtml?: string): Promise<boolean> {
  const EMAIL_API_KEY = Deno.env.get("EMAIL_API_KEY"); // e.g., SendGrid, Resend
  const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "no-reply@bolifyai.com";

  if (!EMAIL_API_KEY) {
    console.warn(`[Email] API Key missing. Mocking email to ${to} (Subject: ${subject})`);
    return true;
  }

  try {
    // Example using Resend API format (can be adapted for SendGrid, etc.)
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${EMAIL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject: subject,
        text: bodyText,
        html: bodyHtml || bodyText
      })
    });

    if (!response.ok) {
       const errData = await response.json().catch(() => ({}));
       console.error("[Email] Provider Error:", errData);
       return false;
    }

    console.log(`[Email] Successfully sent email to ${to}`);
    return true;
  } catch (error) {
    console.error("[Email] Network Error:", error);
    return false;
  }
}
