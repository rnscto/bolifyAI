import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


// Entity automation: triggers on ComplaintLog create
// Auto-suspends a DID if it receives 3+ unique complaints (TRAI TCCCPR)
export default async function complaintCoolingOff(c: any) {
  const req = c.req.raw || c.req;
  try {
    const appId = Deno.env.get('BASE44_APP_ID');
    /* const base44 = ... */;

    const payload = await c.req.json();
    const { event, data } = payload;

    if (!data || !data.did_number) {
      console.log('[complaintCoolingOff] No DID number in complaint, skipping');
      return c.json({ data: { skipped: true } });
    }

    const didNumber = data.did_number;
    console.log(`[complaintCoolingOff] Checking complaints for DID: ${didNumber}`);

    // Get all complaints for this DID
    const complaints = await base44.entities.ComplaintLog.filter({ did_number: didNumber });

    // Count unique complainant numbers
    const uniqueComplainants = new Set();
    complaints.forEach(c => {
      if (c.complainant_number) uniqueComplainants.add(c.complainant_number);
    });

    console.log(`[complaintCoolingOff] DID ${didNumber}: ${complaints.length} complaints, ${uniqueComplainants.size} unique complainants`);

    // If 3+ unique complaints, auto cooling off
    if (uniqueComplainants.size >= 3) {
      // Check if already in cooling off
      const alreadyCooling = complaints.some(c => c.status === 'cooling_off');
      if (alreadyCooling) {
        console.log(`[complaintCoolingOff] DID ${didNumber} already in cooling off`);
        return c.json({ data: { already_cooling: true } });
      }

      // Find and suspend the DID
      const allDids = await base44.entities.DID.filter({ number: didNumber });
      if (allDids.length > 0) {
        const did = allDids[0];
        await base44.entities.DID.update(did.id, {
          status: 'inactive',
          reserved_note: `Auto cooling off — ${uniqueComplainants.size} unique complaints as of ${new Date().toISOString()}`
        });
        console.log(`[complaintCoolingOff] DID ${didNumber} AUTO-SUSPENDED`);
      }

      // Update the latest complaint with cooling off status
      await base44.entities.ComplaintLog.update(data.id, {
        status: 'cooling_off',
        auto_action_taken: `DID ${didNumber} auto-suspended: ${uniqueComplainants.size} unique complaints (TRAI 3-complaint rule)`
      });

      // Audit log
      await base44.entities.AuditLog.create({
        client_id: data.client_id,
        action_type: 'emergency_takedown',
        details: `AUTO COOLING OFF: DID ${didNumber} suspended — ${uniqueComplainants.size} unique complaints triggered TRAI auto-cooling-off`,
        metadata: {
          did_number: didNumber,
          unique_complainants: uniqueComplainants.size,
          total_complaints: complaints.length,
        }
      });

      // Notify client via email
      try {
        if (data.client_id) {
          const clients = await base44.entities.Client.filter({ id: data.client_id });
          if (clients.length > 0) {
            await base44.integrations.Core.SendEmail({
              to: clients[0].email,
              subject: `⚠️ DID ${didNumber} Suspended — Cooling Off Period`,
              body: `
                <h2>Your DID has been suspended</h2>
                <p>DID Number: <strong>${didNumber}</strong></p>
                <p>Your number has received ${uniqueComplainants.size} unique complaints and has been automatically placed into a Cooling Off period as per TRAI TCCCPR regulations.</p>
                <p>During this period, no outbound calls can be made from this number.</p>
                <p><strong>What to do:</strong></p>
                <ul>
                  <li>Review your AI agent's call scripts for compliance</li>
                  <li>Ensure AI disclosure is present in the first 15 seconds</li>
                  <li>Contact our DPO at nand@brainbucks.in for assistance</li>
                </ul>
                <p>— VaaniAI Compliance Team</p>
              `
            });
          }
        }
      } catch (emailErr) {
        console.error('[complaintCoolingOff] Email notification failed:', emailErr.message);
      }

      return c.json({ data: { 
        action: 'cooling_off',
        did: didNumber,
        unique_complaints: uniqueComplainants.size
      } });
    }

    return c.json({ data: { action: 'none', unique_complaints: uniqueComplainants.size } });

  } catch (error) {
    console.error('[complaintCoolingOff] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};