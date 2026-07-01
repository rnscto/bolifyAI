import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


export default async function diagnoseKbMappings(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const [agents, kbs] = await Promise.all([
      base44.asServiceRole.entities.Agent.list('-updated_date', 1000),
      base44.asServiceRole.entities.KnowledgeBase.list('-updated_date', 1000)
    ]);

    const kbById = new Map(kbs.map(k => [k.id, k]));
    const referencedKbIds = new Set();

    for (const agent of agents) {
      for (const kbId of agent.knowledge_base_ids || []) referencedKbIds.add(kbId);
    }

    const agentsWithKbIdsButNoBlob = agents
      .filter(a => (a.knowledge_base_ids || []).length > 0 && !a.kb_file_uri)
      .map(a => ({ id: a.id, name: a.name, client_id: a.client_id, kb_count: (a.knowledge_base_ids || []).length }));

    const agentsWithBlobButNoKbIds = agents
      .filter(a => (a.kb_file_uri || '') && (a.knowledge_base_ids || []).length === 0)
      .map(a => ({ id: a.id, name: a.name, client_id: a.client_id, kb_file_uri: a.kb_file_uri }));

    const agentsMentionKbButNoMapping = agents
      .filter(a => {
        const prompt = `${a.system_prompt || ''} ${a.greeting_message || ''}`.toLowerCase();
        const mentionsKb = prompt.includes('knowledge base') || prompt.includes('kb') || prompt.includes('knowledgebase');
        return mentionsKb && (a.knowledge_base_ids || []).length === 0;
      })
      .map(a => ({ id: a.id, name: a.name, client_id: a.client_id, assigned_dids: a.assigned_dids || [], assigned_did: a.assigned_did || '' }));

    const orphanKnowledgeBases = kbs
      .filter(k => !referencedKbIds.has(k.id))
      .map(k => ({ id: k.id, title: k.title, client_id: k.client_id, status: k.status, content_length: (k.content || '').length, created_by: k.created_by }));

    const brokenKbReferences = agents
      .map(a => ({
        id: a.id,
        name: a.name,
        client_id: a.client_id,
        missing_kb_ids: (a.knowledge_base_ids || []).filter(kbId => !kbById.has(kbId))
      }))
      .filter(a => a.missing_kb_ids.length > 0);

    const readyKbCount = kbs.filter(k => k.status === 'ready').length;
    const agentsWithAnyKb = agents.filter(a => (a.knowledge_base_ids || []).length > 0).length;
    const agentsWithBlob = agents.filter(a => !!a.kb_file_uri).length;

    return c.json({ data: {
      summary: {
        total_agents: agents.length,
        total_knowledge_bases: kbs.length,
        ready_knowledge_bases: readyKbCount,
        agents_with_kb_mapping: agentsWithAnyKb,
        agents_with_kb_blob: agentsWithBlob,
        orphan_knowledge_bases: orphanKnowledgeBases.length,
        agents_mention_kb_but_no_mapping: agentsMentionKbButNoMapping.length,
        agents_with_kb_ids_but_no_blob: agentsWithKbIdsButNoBlob.length,
        agents_with_blob_but_no_kb_ids: agentsWithBlobButNoKbIds.length,
        broken_kb_references: brokenKbReferences.length
      },
      orphanKnowledgeBases: orphanKnowledgeBases.slice(0, 100),
      agentsMentionKbButNoMapping,
      agentsWithKbIdsButNoBlob,
      agentsWithBlobButNoKbIds,
      brokenKbReferences
    } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};