import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Admin-only utility: rebuilds the KB blob + semantic index for ALL agents that have
// knowledge_base_ids assigned. Safe to re-run — uploadKBToStorage skips agents whose
// content + embedding model are unchanged (hash + model match).
//
// Optional payload:
//   { agent_id }      — rebuild only one agent
//   { client_id }     — rebuild all agents for a single client
//   { force: true }   — (currently informational; uploadKBToStorage already handles dedup)

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });
    }

    let body = {};
    try { body = await req.json(); } catch { /* GET or empty body */ }
    const { agent_id, client_id } = body;

    const svc = base44.asServiceRole;

    let agents = [];
    if (agent_id) {
      const a = await svc.entities.Agent.get(agent_id);
      if (a) agents = [a];
    } else if (client_id) {
      agents = await svc.entities.Agent.filter({ client_id }, '-created_date', 500);
    } else {
      agents = await svc.entities.Agent.list('-created_date', 1000);
    }

    const eligible = agents.filter(a => Array.isArray(a.knowledge_base_ids) && a.knowledge_base_ids.length > 0);
    const results = { total: agents.length, eligible: eligible.length, processed: 0, skipped: 0, indexed: 0, failed: 0, details: [] };

    for (const agent of eligible) {
      try {
        const resp = await svc.functions.invoke('uploadKBToStorage', {
          agent_id: agent.id,
          _internal: true
        });
        const data = resp?.data || {};
        results.processed++;
        if (data.skipped === 'unchanged') {
          results.skipped++;
          results.details.push({ agent_id: agent.id, name: agent.name, status: 'unchanged' });
        } else if (data.semantic) {
          results.indexed++;
          results.details.push({
            agent_id: agent.id, name: agent.name, status: 'indexed',
            chunks: data.chunk_count, chars: data.char_count
          });
        } else {
          results.details.push({
            agent_id: agent.id, name: agent.name, status: 'uploaded_no_index',
            chars: data.char_count, message: data.message || 'embedding deployment unavailable'
          });
        }
      } catch (err) {
        results.failed++;
        results.details.push({ agent_id: agent.id, name: agent.name, status: 'error', error: err.message });
        console.error(`[rebuildAllAgentKBs] ${agent.id} failed: ${err.message}`);
      }
    }

    console.log(`[rebuildAllAgentKBs] Done: ${results.processed}/${results.eligible} (${results.indexed} indexed, ${results.skipped} unchanged, ${results.failed} failed)`);
    return Response.json({ success: true, ...results });
  } catch (error) {
    console.error('[rebuildAllAgentKBs] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});