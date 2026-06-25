import { client } from "../db/index.ts";

export async function sendSMS(toPhone: string, messageText: string, clientId?: string): Promise<boolean> {
  let provider = "msg91";
  let apiKey = Deno.env.get("SMS_API_KEY") || ""; 
  let senderId = Deno.env.get("SMS_SENDER_ID") || "BOLIFY";

  // Try to load client specific config
  if (clientId) {
    const res = await client.queryObject(
      `SELECT * FROM "clientmessagingconfig" WHERE client_id = $1 LIMIT 1`,
      [clientId]
    );
    const config = res.rows[0] as any;
    if (config && config.rcs_provider) {
      provider = config.rcs_provider;
      if (config.rcs_api_key) apiKey = config.rcs_api_key;
      if (config.rcs_sender_id) senderId = config.rcs_sender_id;
    }
  }

  if (!apiKey) {
    console.warn(`[SMS] API Key missing for client ${clientId || "global"}. Mocking SMS to ${toPhone}: "${messageText}"`);
    return true;
  }

  try {
    if (provider === "msg91") {
      const url = "https://api.msg91.com/api/v5/sms";
      const payload = {
        sender: senderId,
        route: "4",
        country: "91", // Can be dynamic
        sms: [
          {
            message: messageText,
            to: [toPhone.replace(/^\+91/, '').replace(/\D/g, '')]
          }
        ]
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "authkey": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (data.type === "error") throw new Error(data.message);
      console.log(`[SMS - MSG91] Sent to ${toPhone}.`);
      return true;

    } else if (provider === "twilio") {
      // Twilio expects apiKey to be AccountSID:AuthToken
      const [accountSid, authToken] = apiKey.split(":");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      
      const body = new URLSearchParams();
      body.append("To", `+${toPhone.replace(/\D/g, '')}`);
      body.append("From", senderId); // Twilio phone number
      body.append("Body", messageText);
      
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
      console.log(`[SMS - Twilio] Sent to ${toPhone}. SID: ${data.sid}`);
      return true;

    }

    throw new Error(`Unsupported SMS Provider: ${provider}`);
  } catch (error: any) {
    console.error(`[SMS] Error sending via ${provider}:`, error.message);
    return false;
  }
}
