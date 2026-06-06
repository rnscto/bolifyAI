import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Probe which DID the SMARTFLO_API_KEY click-to-call token is mapped to
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const apiKey = Deno.env.get('SMARTFLO_API_KEY');
    const email = Deno.env.get('SMARTFLO_EMAIL');
    const password = Deno.env.get('SMARTFLO_PASSWORD');

    // Login to get bearer token
    const loginRes = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const loginData = await loginRes.json();
    if (!loginData.access_token) {
      return Response.json({ error: 'Login failed', details: loginData });
    }
    const token = loginData.access_token;

    // Get all DIDs (numbers) from Smartflo
    const numbersRes = await fetch('https://api-smartflo.tatateleservices.com/v1/my_number', {
      headers: { 'Authorization': token }
    });
    const numbers = await numbersRes.json();

    // Get agents from Smartflo (each agent has a click-to-call token)
    const agentsRes = await fetch('https://api-smartflo.tatateleservices.com/v1/agents', {
      headers: { 'Authorization': token }
    });
    const agentsData = await agentsRes.json();

    // Try click_to_call_support with each DID using the shared SMARTFLO_API_KEY
    // We'll try a dummy number (won't actually ring) to see which caller_id is accepted
    const testResults = [];
    const didsToTest = Array.isArray(numbers) ? numbers.map(n => n.did?.replace('+', '') || n.alias) : [];

    for (const did of didsToTest.slice(0, 10)) {
      const res = await fetch('https://api-smartflo.tatateleservices.com/v1/click_to_call_support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          customer_number: '9000000000', // dummy - won't ring
          caller_id: did,
          async: 1
        })
      });
      const data = await res.json();
      const isValid = !data.caller_id; // if caller_id field is in response, it's an error
      testResults.push({
        did,
        status: res.status,
        response: data,
        is_valid_for_api_key: isValid
      });
      console.log(`DID ${did}: ${isValid ? '✅ VALID' : '❌ INVALID'} — ${JSON.stringify(data)}`);
    }

    // Logout
    await fetch('https://api-smartflo.tatateleservices.com/v1/auth/logout', {
      method: 'POST', headers: { 'Authorization': token }
    }).catch(() => {});

    const validDIDs = testResults.filter(r => r.is_valid_for_api_key).map(r => r.did);

    return Response.json({
      all_smartflo_dids: didsToTest,
      test_results: testResults,
      valid_dids_for_shared_api_key: validDIDs,
      agents_preview: JSON.stringify(agentsData).slice(0, 1000)
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});