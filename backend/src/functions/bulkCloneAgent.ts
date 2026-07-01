import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// bulkCloneAgent — Admin-only. Creates N replicas of a source agent for a
// target client, each with its own name + (optionally) its own DID.
//
// Payload:
//   {
//     source_agent_id: string,
//     target_client_id: string,
//     replicas: [
//       { name: "Sales Agent 1", did_number: "+919...", smartflo_api_token?: "" },
//       { name: "Sales Agent 2", did_number: "+919...", smartflo_api_token?: "" },
//       ...
//     ],
//     status: "active" | "inactive",          // applied to all replicas
//     auto_provision_smartflo: boolean        // if true, fires smartfloAgentProvisioner per agent
//   }
//
// For each replica:
//   1. Clone all config from source (system_prompt, greeting, persona, KB, industry, transfer, etc.)
//   2. Override name + assigned_did + assigned_dids + client_id + status + optional smartflo token
//   3. Update the DID row → status=assigned, client_id, agent_id
//   4. Optionally invoke smartfloAgentProvisioner
//
// Returns: { success, created: N, failed: M, agent_ids: [...], errors: [...] }
// ═══════════════════════════════════════════════════════════════════════



export default async function bulkCloneAgent(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);
    if (user.role !== 'admin') return c.json({ data: { error: 'Forbidden: Admin only' } }, 403);

    const body = await c.req.json().catch(() => ({}));
    const {
      source_agent_id,
      target_client_id,
      replicas,
      status = 'inactive',
      auto_provision_smartflo = false,
    } = body;

    if (!source_agent_id) return c.json({ data: { error: 'source_agent_id required' } }, 400);
    if (!target_client_id) return c.json({ data: { error: 'target_client_id required' } }, 400);
    if (!Array.isArray(replicas) || replicas.length === 0) {
      return c.json({ data: { error: 'replicas array required (at least 1)' } }, 400);
    }
    if (replicas.length > 50) {
      return c.json({ data: { error: 'Max 50 replicas per call' } }, 400);
    }

    const svc = base44.asServiceRole;

    // Load source agent
    const source = await svc.entities.Agent.get(source_agent_id).catch(() => null);
    if (!source) return c.json({ data: { error: 'Source agent not found' } }, 404);

    // Verify target client exists
    const client = await svc.entities.Client.get(target_client_id).catch(() => null);
    if (!client) return c.json({ data: { error: 'Target client not found' } }, 404);

    const agentIds = [];
    const errors = [];
    let created = 0;
    let failed = 0;

    for (let i = 0; i < replicas.length; i++) {
      const r = replicas[i];
      try {
        const name = String(r.name || '').trim();
        if (!name) {
          errors.push({ index: i, error: 'name required' });
          failed++;
          continue;
        }

        const didNumber = r.did_number ? String(r.did_number).trim() : '';
        const assigned_dids = didNumber ? [didNumber] : [];

        // Build new agent payload — clone everything from source, override per-replica fields
        const newAgentPayload = {
          name,
          client_id: target_client_id,
          industry: source.industry || '',
          persona: source.persona || {},
          greeting_message: source.greeting_message || '',
          system_prompt: source.system_prompt || '',
          knowledge_base_ids: Array.isArray(source.knowledge_base_ids) ? [...source.knowledge_base_ids] : [],
          status: status || 'inactive',
          assigned_did: didNumber,
          assigned_dids,
          smartflo_api_token: r.smartflo_api_token || source.smartflo_api_token || '',
          human_transfer_number: source.human_transfer_number || '',
          smartflo_intercom_number: '',  // per-agent, do NOT copy
          smartflo_agent_id: '',          // per-agent, do NOT copy
          enable_auto_transfer: source.enable_auto_transfer !== false,
          calling_provider: source.calling_provider || 'auto',
          region: source.region || client.region || 'IN',
          twilio_dids: [],                // per-agent, do NOT copy
          // KB-related fields — we'll let the KB rebuild flow re-hydrate these
          kb_file_uri: source.kb_file_uri || '',
          kb_file_hash: source.kb_file_hash || '',
          kb_char_count: source.kb_char_count || 0,
        };

        const newAgent = await svc.entities.Agent.create(newAgentPayload);
        agentIds.push(newAgent.id);
        created++;

        // Wire the DID → assigned to this new agent
        if (didNumber) {
          try {
            const didMatches = await svc.entities.DID.filter({ number: didNumber });
            const didRow = didMatches[0];
            if (didRow && !didRow.is_demo) {
              await svc.entities.DID.update(didRow.id, {
                client_id: target_client_id,
                agent_id: newAgent.id,
                status: 'assigned',
              });
            }
          } catch (e) {
            console.error(`[bulkCloneAgent] DID wire failed for ${didNumber}: ${e.message}`);
          }
        }

        // Optional Smartflo provisioning (fire-and-forget per agent)
        if (auto_provision_smartflo) {
          svc.functions.invoke('smartfloAgentProvisioner', { agent_id: newAgent.id })
            .catch(e => console.error(`[bulkCloneAgent] smartflo provision failed for ${newAgent.id}: ${e.message}`));
        }
      } catch (e) {
        console.error(`[bulkCloneAgent] replica ${i} failed:`, e);
        errors.push({ index: i, name: r.name, error: e.message });
        failed++;
      }
    }

    return c.json({ data: {
      success: true,
      created,
      failed,
      agent_ids: agentIds,
      errors,
      source_agent_id,
      target_client_id,
    } });
  } catch (error) {
    console.error('[bulkCloneAgent] Error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};