import { load } from 'https://deno.land/std@0.224.0/dotenv/mod.ts';

await load({ export: true });

const LOCAL_URL = 'http://localhost:8000';

async function runE2E() {
  console.log("=== Bolify AI Local End-to-End Test ===\\n");

  // 1. Test Smartflo Webhook
  console.log("1. Simulating inbound Smartflo Webhook...");
  const mockWebhookPayload = {
    "call_id": "mock_call_" + Date.now(),
    "caller_id": "1234567890",
    "dialed_number": "0987654321",
    "call_duration": "60",
    "status": "completed",
    "transcript": "Hello, this is a simulated transcription of a successful sales call. The customer was interested in buying the enterprise plan. They said to send over the contract and they will sign it tomorrow.",
    "agent_id": "test_agent_123"
  };

  try {
    const res = await fetch(\`\${LOCAL_URL}/api/webhook/smartflo\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mockWebhookPayload)
    });
    
    if (!res.ok) {
      console.error(\`Webhook failed: HTTP \${res.status} - \${await res.text()}\`);
    } else {
      console.log(\`Webhook success: HTTP \${res.status}\`);
      const data = await res.json();
      console.log("Webhook Response:", data);
    }
  } catch (e: any) {
    console.error("Webhook connection failed. Is the server running? error:", e.message);
  }

  // 2. Test Manual Call Extractor Trigger
  console.log("\\n2. Triggering Manual Extractor via /api/functions/invoke...");
  try {
    // In a real scenario we'd use the callLogId returned above or known from DB
    // Here we just test if the endpoint is reachable
    const res2 = await fetch(\`\${LOCAL_URL}/api/functions/invoke\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        functionName: 'postCallActionExtractor',
        payload: { call_log_id: 'dummy_id_for_test' }
      })
    });
    
    console.log(\`Extractor Invoke Response: HTTP \${res2.status}\`);
    if (res2.ok) {
      console.log(await res2.json());
    } else {
      console.log(await res2.text());
    }
  } catch (e: any) {
    console.error("Extractor invoke failed:", e.message);
  }

  console.log("\\n=== End of E2E Test ===");
}

runE2E();
