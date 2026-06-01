// Temporary debug function — tests the exact icpaas.in send-message endpoint from the user's curl.
Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const token = body.token || 'b18ca82d-3b6c-4a43-9bf0-badadc08aed8';
    const phoneId = body.phoneId || '1126527270548587';
    const to = body.to || '919355521144';
    const templateName = body.template || 'confirmationmsg';

    const url = `https://icpaas.in/v23.0/${phoneId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [] }]
      }
    };

    console.log(`[testIcpaasDirect] → POST ${url}`);
    console.log(`[testIcpaasDirect] → Token: ${token.substring(0, 6)}...${token.substring(token.length - 4)} (len=${token.length})`);
    console.log(`[testIcpaasDirect] → Payload: ${JSON.stringify(payload)}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const rawText = await res.text();
    console.log(`[testIcpaasDirect] ← HTTP ${res.status} ${res.statusText}`);
    console.log(`[testIcpaasDirect] ← Body: ${rawText.substring(0, 2000)}`);

    let parsed;
    try { parsed = JSON.parse(rawText); } catch { parsed = rawText; }

    return Response.json({
      http_status: res.status,
      http_statusText: res.statusText,
      ok: res.ok,
      response: parsed
    });
  } catch (error) {
    console.error('[testIcpaasDirect] error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});