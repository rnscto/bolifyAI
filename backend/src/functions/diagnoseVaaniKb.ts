import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function diagnoseVaaniKb(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const agents = await base44.asServiceRole.entities.Agent.list('-updated_date', 1000);
    const kbs = await base44.asServiceRole.entities.KnowledgeBase.list('-updated_date', 1000);
    const calls = await base44.asServiceRole.entities.CallLog.list('-created_date', 50);

    const exactKb = kbs.find(k => (k.title || '').trim() === 'AI-Generated KB — Vaani (2026-05-09)') || null;
    const exactKbId = exactKb?.id || '';

    const targetAgents = agents
      .filter(a => a.id === '69997be2d36c109901d183d6' || (exactKbId && Array.isArray(a.knowledge_base_ids) && a.knowledge_base_ids.includes(exactKbId)))
      .map(a => ({
        id: a.id,
        name: a.name,
        client_id: a.client_id,
        knowledge_base_ids: a.knowledge_base_ids || [],
        has_exact_kb_attached: exactKbId ? (a.knowledge_base_ids || []).includes(exactKbId) : false,
        kb_file_uri: a.kb_file_uri || '',
        kb_file_hash: a.kb_file_hash || '',
        kb_char_count: a.kb_char_count || 0,
        kb_last_built_at: a.kb_last_built_at || '',
        voice_engine: a.persona?.voice_engine || '',
        assigned_dids: a.assigned_dids || [],
        assigned_did: a.assigned_did || ''
      }));

    const targetKbs = exactKb ? [{
      id: exactKb.id,
      title: exactKb.title,
      client_id: exactKb.client_id,
      status: exactKb.status,
      content_length: (exactKb.content || '').length,
      referenced_by_agents: agents.filter(a => Array.isArray(a.knowledge_base_ids) && a.knowledge_base_ids.includes(exactKb.id)).map(a => ({ id: a.id, name: a.name, client_id: a.client_id }))
    }] : [];

    const recentVaaniCalls = calls
      .filter(c => c.agent_id === '69997be2d36c109901d183d6' || `${c.agent_config_cache?.agent_name || ''} ${c.agent_config_cache?.core_prompt || ''} ${c.agent_config_cache?.system_prompt || ''}`.toLowerCase().includes('vaani'))
      .map(c => ({
        id: c.id,
        created_date: c.created_date,
        created_by: c.created_by,
        agent_id: c.agent_id,
        status: c.status,
        direction: c.direction,
        caller_id: c.caller_id,
        callee_number: c.callee_number,
        cache_agent_name: c.agent_config_cache?.agent_name || '',
        cache_agent_id: c.agent_config_cache?.agent_id || '',
        cache_has_kb: c.agent_config_cache?.tool_flags?.has_kb,
        cache_kb_file_uri: c.agent_config_cache?.kb_file_uri || '',
        cache_kb_content_length: (c.agent_config_cache?.knowledge_base_content || '').length,
        cache_keys: Object.keys(c.agent_config_cache || {})
      }));

    return c.json({ data: { targetAgents, targetKbs, recentVaaniCalls } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};