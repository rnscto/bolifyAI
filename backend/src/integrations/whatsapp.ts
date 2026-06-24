export async function sendWhatsAppMessage(toPhone: string, templateName: string, parameters: string[]): Promise<boolean> {
  const WHATSAPP_API_TOKEN = Deno.env.get("WHATSAPP_API_TOKEN");
  const WHATSAPP_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID");

  if (!WHATSAPP_API_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn(`[WhatsApp] Missing credentials. Mocking send to ${toPhone} with template ${templateName}`);
    return true;
  }

  try {
    const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`;
    
    // Construct the payload for a WhatsApp Template Message
    const payload = {
      messaging_product: "whatsapp",
      to: toPhone,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: "en_US"
        },
        components: [
          {
            type: "body",
            parameters: parameters.map(p => ({
              type: "text",
              text: p
            }))
          }
        ]
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    if (data.error) {
      console.error("[WhatsApp] API Error:", data.error);
      return false;
    }

    console.log(`[WhatsApp] Sent message to ${toPhone}. Message ID: ${data.messages[0].id}`);
    return true;
  } catch (error) {
    console.error("[WhatsApp] Network Error:", error);
    return false;
  }
}
