import { base44ORM as base44 } from "../db/orm.ts";
import { getSmartfloToken } from "../services/smartflo.ts";

export default async function fetchSmartfloDIDs(c: any) {
  try {
    const smartfloApiKey = Deno.env.get("SMARTFLO_API_KEY");
    if (!smartfloApiKey) {
       return c.json({ data: { success: false, error: "SMARTFLO_API_KEY not set" } });
    }
    const token = await getSmartfloToken();
    const res = await fetch("https://api-smartflo.tatateleservices.com/v1/did", {
       headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!res.ok) {
       return c.json({ data: { success: false, error: "Failed to fetch DIDs from Smartflo" } });
    }
    const data = await res.json();
    const dids = data.data || [];
    let added = 0;
    for (const did of dids) {
       const existing = await base44.entities.DID.filter({ number: did.did_number });
       if (existing.length === 0) {
          await base44.entities.DID.create({
             number: did.did_number,
             country_code: "+91",
             status: "available",
             monthly_cost: 6500
          });
          added++;
       }
    }
    return c.json({ data: { success: true, message: `Synced ${added} new DIDs from Smartflo` } });
  } catch (err: any) {
    return c.json({ data: { success: false, error: err.message } });
  }
}
