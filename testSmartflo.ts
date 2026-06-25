import "https://deno.land/std@0.210.0/dotenv/load.ts";

async function testSmartflo(callerId: string) {
  const apiKey = Deno.env.get("SMARTFLO_API_KEY");
  console.log(`Testing caller_id: ${callerId}`);
  const res = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      customer_number: "919999999999", // dummy customer
      caller_id: callerId,
      custom_identifier: "test1234",
      async: 1
    })
  });
  const data = await res.json();
  console.log(`Response for ${callerId}:`, JSON.stringify(data));
}

async function run() {
  await testSmartflo("918065902522");
  await testSmartflo("8065902522");
  await testSmartflo("08065902522");
  await testSmartflo("+918065902522");
  Deno.exit(0);
}
run();
