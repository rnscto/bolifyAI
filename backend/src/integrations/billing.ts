export async function generateCashfreePaymentLink(clientId: string, amount: number, customerPhone: string, customerEmail: string): Promise<string> {
  const CASHFREE_APP_ID = Deno.env.get("CASHFREE_APP_ID");
  const CASHFREE_SECRET_KEY = Deno.env.get("CASHFREE_SECRET_KEY");
  const CASHFREE_ENV = Deno.env.get("CASHFREE_ENV") || "TEST"; // TEST or PROD

  if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
    console.warn(`[Cashfree] Credentials missing. Mocking payment link for client ${clientId}`);
    return `https://mock.cashfree.com/pay/${clientId}-${Date.now()}`;
  }

  const baseUrl = CASHFREE_ENV === "PROD" 
    ? "https://api.cashfree.com/pg" 
    : "https://sandbox.cashfree.com/pg";

  try {
    const payload = {
      customer_details: {
        customer_id: clientId,
        customer_phone: customerPhone,
        customer_email: customerEmail
      },
      link_notify: {
        send_sms: true,
        send_email: true
      },
      link_amount: amount,
      link_currency: "INR",
      link_purpose: "BolifyAI Platform Subscription/Recharge"
    };

    const response = await fetch(`${baseUrl}/links`, {
      method: "POST",
      headers: {
        "x-client-id": CASHFREE_APP_ID,
        "x-client-secret": CASHFREE_SECRET_KEY,
        "x-api-version": "2023-08-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.link_url) {
       console.log(`[Cashfree] Generated payment link for client ${clientId}`);
       return data.link_url;
    } else {
       console.error("[Cashfree] Failed to generate link:", data);
       throw new Error(data.message || "Payment Link generation failed");
    }

  } catch (error) {
    console.error("[Cashfree] Integration Error:", error);
    throw error;
  }
}
