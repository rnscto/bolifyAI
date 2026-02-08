import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const apiKey = Deno.env.get('SMARTFLO_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'Smartflo API key not configured' }, { status: 500 });
    }

    // Fetch DIDs from Smartflo API
    const response = await fetch('https://api-smartflo.tatateleservices.com/v1/my_number', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.text();
      return Response.json({ 
        error: 'Failed to fetch DIDs from Smartflo',
        details: error
      }, { status: response.status });
    }

    const smartfloData = await response.json();

    // Sync DIDs to database
    const existingDids = await base44.asServiceRole.entities.DID.list();
    const existingNumbers = new Set(existingDids.map(d => d.number));

    const newDids = [];
    const didsArray = smartfloData.data || [];
    
    for (const did of didsArray) {
      if (!existingNumbers.has(did.phone_number)) {
        newDids.push({
          number: did.phone_number,
          country_code: did.country_code || '+91',
          status: 'available',
          monthly_cost: 6500
        });
      }
    }

    if (newDids.length > 0) {
      await base44.asServiceRole.entities.DID.bulkCreate(newDids);
    }

    return Response.json({
      success: true,
      total_dids: didsArray.length,
      new_dids: newDids.length,
      message: `Synced ${newDids.length} new DIDs from Smartflo`
    });

  } catch (error) {
    console.error('Error fetching Smartflo DIDs:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});