import { client } from "../db/index.ts";

export async function sendWhatsAppMessage(toPhone: string, templateName: string, parameters: string[], clientId?: string): Promise<boolean> {
  let provider = "meta";
  let apiKey = Deno.env.get("WHATSAPP_API_TOKEN") || "";
  let phoneId = Deno.env.get("WHATSAPP_PHONE_ID") || "";
  
  // Try to load client specific config
  if (clientId) {
    const res = await client.queryObject(
      `SELECT * FROM "clientmessagingconfig" WHERE client_id = $1 LIMIT 1`,
      [clientId]
    );
    const config = res.rows[0] as any;
    if (config && config.whatsapp_provider) {
      provider = config.whatsapp_provider;
      if (config.whatsapp_api_key) apiKey = config.whatsapp_api_key;
      if (config.whatsapp_phone_number_id) phoneId = config.whatsapp_phone_number_id;
    }
  }

  if (!apiKey) {
    console.warn(`[WhatsApp] Missing credentials for client ${clientId || "global"}. Mocking send to ${toPhone}`);
    return true;
  }

  try {
    if (provider === "meta") {
      const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;
      const payload = {
        messaging_product: "whatsapp",
        to: toPhone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en_US" },
          components: parameters.length > 0 ? [{
            type: "body",
            parameters: parameters.map(p => ({ type: "text", text: p }))
          }] : []
        }
      };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      console.log(`[WhatsApp - Meta] Sent to ${toPhone}. ID: ${data.messages?.[0]?.id}`);
      return true;

    } else if (provider === "twilio") {
      // Twilio expects apiKey to be AccountSID:AuthToken base64 encoded or passed as basic auth. 
      // For simplicity, assume apiKey is "AccountSID:AuthToken"
      const [accountSid, authToken] = apiKey.split(":");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      
      const body = new URLSearchParams();
      body.append("To", `whatsapp:+${toPhone.replace(/\D/g, '')}`);
      body.append("From", `whatsapp:${phoneId}`); // phoneId acts as from number
      body.append("Body", `Template: ${templateName} - ${parameters.join(", ")}`); // Simplified mapping for twilio template
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${btoa(apiKey)}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      });
      
      const data = await response.json();
      if (data.code || data.error_message) throw new Error(data.message || data.error_message);
      console.log(`[WhatsApp - Twilio] Sent to ${toPhone}. SID: ${data.sid}`);
      return true;

    } else if (provider === "interakt") {
      const url = "https://api.interakt.ai/v1/public/message/";
      const payload = {
        countryCode: "+91", // Can be dynamic
        phoneNumber: toPhone.replace(/^\+91/, ''),
        callbackData: "bolify_campaign",
        type: "Template",
        template: {
          name: templateName,
          languageCode: "en",
          bodyValues: parameters
        }
      };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Basic ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      
      const data = await response.json();
      if (!data.result) throw new Error(JSON.stringify(data));
      console.log(`[WhatsApp - Interakt] Sent to ${toPhone}.`);
      return true;
    }

    throw new Error(`Unsupported WhatsApp Provider: ${provider}`);
  } catch (error: any) {
    console.error(`[WhatsApp] Error sending via ${provider}:`, error.message);
    return false;
  }
}
