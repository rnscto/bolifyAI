import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const email = Deno.env.get('SMARTFLO_EMAIL');
    const password = Deno.env.get('SMARTFLO_PASSWORD');

    if (!email || !password) {
      return Response.json({ error: 'SMARTFLO_EMAIL or SMARTFLO_PASSWORD not configured' }, { status: 500 });
    }

    // Login to get fresh bearer token
    console.log('Logging in to Smartflo...');
    const loginRes = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const loginData = await loginRes.json();

    if (!loginData.success || !loginData.access_token) {
      return Response.json({ error: 'Smartflo login failed', details: loginData }, { status: 401 });
    }

    const token = loginData.access_token;
    console.log('Login successful');

    // Fetch DIDs using bearer token
    const response = await fetch('https://api-smartflo.tatateleservices.com/v1/my_number', {
      method: 'GET',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Smartflo API error:', errorText);
      return Response.json({ 
        error: 'Failed to fetch DIDs from Smartflo',
        details: errorText,
        status_code: response.status
      }, { status: response.status });
    }

    const smartfloData = await response.json();
    console.log('Smartflo /my_number response:', JSON.stringify(smartfloData).slice(0, 500));

    // Response is an array of DID objects with fields: id, name, alias, did
    const didsArray = Array.isArray(smartfloData) ? smartfloData : (smartfloData.data || []);

    if (!Array.isArray(didsArray)) {
      return Response.json({
        error: 'Unexpected response format from Smartflo',
        response: smartfloData
      }, { status: 500 });
    }

    // Sync all DIDs to database
    const existingDids = await base44.asServiceRole.entities.DID.list();
    const existingNumbers = new Set(existingDids.map(d => d.number));

    const newDids = [];
    const updatedDids = [];

    for (const did of didsArray) {
      // did.did is like "+918065485979", did.alias is "918065485979"
      const rawDid = did.did || did.alias || '';
      // Strip leading + to get the number as stored (e.g. 918065485979 or 8065485979)
      const phoneNumber = rawDid.replace(/^\+/, '');
      // Also store the 10-digit local version for matching
      const localNumber = phoneNumber.startsWith('91') ? phoneNumber.slice(2) : phoneNumber;

      if (!phoneNumber) continue;

      // Check if already exists by full number or local number
      const existingFull = existingDids.find(d => d.number === phoneNumber || d.number === localNumber || d.number === rawDid);

      if (!existingFull) {
        newDids.push({
          number: phoneNumber,
          country_code: '+91',
          status: 'available',
          monthly_cost: 6500
        });
      }
    }

    if (newDids.length > 0) {
      await base44.asServiceRole.entities.DID.bulkCreate(newDids);
    }

    // Logout
    try {
      await fetch('https://api-smartflo.tatateleservices.com/v1/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': token }
      });
    } catch (_) {}

    return Response.json({
      success: true,
      total_dids: didsArray.length,
      existing_dids: existingDids.length,
      new_dids_added: newDids.length,
      dids_in_smartflo: didsArray.map(d => d.did || d.alias),
      message: `Successfully synced ${newDids.length} new DIDs from Smartflo (${didsArray.length} total in Smartflo)`
    });

  } catch (error) {
    console.error('Error fetching Smartflo DIDs:', error);
    console.error('Stack:', error.stack);
    return Response.json({ 
      error: error.message
    }, { status: 500 });
  }
});