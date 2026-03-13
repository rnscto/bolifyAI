import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const apiKey = Deno.env.get('SMARTFLO_API_KEY');
    
    if (!apiKey) {
      return Response.json({ error: 'SMARTFLO_API_KEY not configured' }, { status: 500 });
    }

    // Fetch all DIDs from Smartflo API using API Key
    const response = await fetch('https://api-smartflo.tatateleservices.com/v1/my_number', {
      method: 'GET',
      headers: {
        'Authorization': apiKey,
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
    console.log('Smartflo response:', JSON.stringify(smartfloData));

    // Handle different response structures
    const didsArray = smartfloData.data || smartfloData.numbers || smartfloData || [];
    
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
    
    for (const did of didsArray) {
      // Handle different field names
      const phoneNumber = did.phone_number || did.number || did.did || did.phoneNumber;
      
      if (phoneNumber && !existingNumbers.has(phoneNumber)) {
        newDids.push({
          number: phoneNumber,
          country_code: did.country_code || did.countryCode || '+91',
          status: 'available',
          monthly_cost: did.monthly_cost || did.cost || 6500
        });
      }
    }

    if (newDids.length > 0) {
      await base44.asServiceRole.entities.DID.bulkCreate(newDids);
    }

    return Response.json({
      success: true,
      total_dids: didsArray.length,
      existing_dids: existingDids.length,
      new_dids: newDids.length,
      message: `Successfully synced ${newDids.length} new DIDs from Smartflo (${didsArray.length} total available)`
    });

  } catch (error) {
    console.error('Error fetching Smartflo DIDs:', error);
    console.error('Stack:', error.stack);
    return Response.json({ 
      error: error.message
    }, { status: 500 });
  }
});