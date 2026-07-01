import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function fetchSmartfloDIDs(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');

    if (user?.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin access required' } }, 403);
    }

    // Login with email/password to get a fresh bearer token (same approach as provisioner)
    const loginRes = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: Deno.env.get('SMARTFLO_EMAIL'),
        password: Deno.env.get('SMARTFLO_PASSWORD')
      })
    });
    if (!loginRes.ok) {
      return c.json({ data: { error: 'Smartflo login failed', details: await loginRes.text() } }, 500);
    }
    const loginData = await loginRes.json();
    const authToken = loginData.access_token || loginData.token || loginData.data?.token;
    if (!authToken) {
      return c.json({ data: { error: 'Smartflo login returned no token', details: loginData } }, 500);
    }

    // Fetch all DIDs from Smartflo API using bearer token (correct endpoint is singular /v1/my_number)
    const response = await fetch('https://api-smartflo.tatateleservices.com/v1/my_number', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Smartflo API error:', errorText);
      return c.json({ data: { 
        error: 'Failed to fetch DIDs from Smartflo',
        details: errorText,
        status_code: response.status
      } }, response.status);
    }

    const smartfloData = await response.json();
    console.log('Smartflo response:', JSON.stringify(smartfloData));

    // Handle different response structures
    const didsArray = smartfloData.data || smartfloData.numbers || smartfloData || [];
    
    if (!Array.isArray(didsArray)) {
      return c.json({ data: {
        error: 'Unexpected response format from Smartflo',
        response: smartfloData
      } }, 500);
    }

    // Sync all DIDs to database
    const existingDids = await base44.asServiceRole.entities.DID.list();
    const existingByNumber = new Map(existingDids.map((d) => [d.number, d]));

    const newDids = [];
    let updatedCount = 0;

    for (const did of didsArray) {
      // Smartflo /v1/my_number returns: { id, did, alias, name, ... }
      const phoneNumber = did.did || did.phone_number || did.number || did.phoneNumber;
      // The `id` field is what must be passed as caller_id when provisioning users
      const smartfloDidId = did.id || did.did_id || did.number_id || did.numberId;

      if (!phoneNumber) continue;

      const existing = existingByNumber.get(phoneNumber);
      if (!existing) {
        newDids.push({
          number: phoneNumber,
          country_code: did.country_code || did.countryCode || '+91',
          status: 'available',
          monthly_cost: did.monthly_cost || did.cost || 6500,
          smartflo_did_id: smartfloDidId ? String(smartfloDidId) : ''
        });
      } else if (smartfloDidId && String(smartfloDidId) !== (existing.smartflo_did_id || '')) {
        // Backfill smartflo_did_id on existing DIDs that don't have it yet
        await base44.asServiceRole.entities.DID.update(existing.id, {
          smartflo_did_id: String(smartfloDidId)
        });
        updatedCount++;
      }
    }

    if (newDids.length > 0) {
      await base44.asServiceRole.entities.DID.bulkCreate(newDids);
    }

    return c.json({ data: {
      success: true,
      total_dids: didsArray.length,
      existing_dids: existingDids.length,
      new_dids: newDids.length,
      updated_smartflo_ids: updatedCount,
      message: `Synced ${newDids.length} new DIDs, backfilled Smartflo IDs on ${updatedCount} existing DIDs (${didsArray.length} total).`
    } });

  } catch (error) {
    console.error('Error fetching Smartflo DIDs:', error);
    console.error('Stack:', error.stack);
    return c.json({ data: { 
      error: error.message
    } }, 500);
  }

};