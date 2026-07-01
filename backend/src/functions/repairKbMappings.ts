import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { BlobServiceClient } from 'npm:@azure/storage-blob@12.17.0';

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isKbReferenced(kbId, agents) {
  return agents.some(agent => (agent.knowledge_base_ids || []).includes(kbId));
}

function djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

async function uploadPrivateToAzure(buffer, blobName, contentType = 'text/plain') {
  const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  const container = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
  if (!conn || !container) throw new Error('Azure Blob not configured');
  const svc = BlobServiceClient.fromConnectionString(conn);
  const blob = svc.getContainerClient(container).getBlockBlobClient(blobName);
  await blob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } });
  return `azblob://${container}/${blobName}`;
}

async function rebuildAgentKb(base44, agentId) {
  const agent = await base44.asServiceRole.entities.Agent.get(agentId);
  const kbIds = agent.knowledge_base_ids || [];
  if (kbIds.length === 0) return { skipped: true, reason: 'no_kb_docs' };

  const docs = (await Promise.all(
    kbIds.map(id => base44.asServiceRole.entities.KnowledgeBase.get(id).catch(() => null))
  )).filter(d => d && d.content);

  if (docs.length === 0) return { skipped: true, reason: 'no_kb_content' };

  const content = docs.map(d => `[${d.title || 'Untitled'}]\n${d.content}`).join('\n\n---\n\n');
  const hash = djb2Hash(content);
  const buffer = new TextEncoder().encode(content);
  const fileUri = await uploadPrivateToAzure(buffer, `kb/agent_${agentId}_${Date.now()}.txt`, 'text/plain');

  await base44.asServiceRole.entities.Agent.update(agentId, {
    kb_file_uri: fileUri,
    kb_file_hash: hash,
    kb_last_built_at: new Date().toISOString(),
    kb_char_count: content.length
  });

  return { success: true, kb_file_uri: fileUri, kb_char_count: content.length, kb_doc_count: docs.length };
}

export default async function repairKbMappings(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;
    const forceAttach = body.force_attach === true; // stack orphan KBs onto agents that already have other KBs

    const [agents, kbs] = await Promise.all([
      base44.asServiceRole.entities.Agent.list('-updated_date', 1000),
      base44.asServiceRole.entities.KnowledgeBase.list('-updated_date', 1000)
    ]);

    const plans = [];
    const readyKbs = kbs.filter(kb => kb.status === 'ready' && kb.content && !isKbReferenced(kb.id, agents));

    // Group orphan KBs by client
    const orphansByClient = new Map();
    for (const kb of readyKbs) {
      if (!kb.client_id) continue;
      if (!orphansByClient.has(kb.client_id)) orphansByClient.set(kb.client_id, []);
      orphansByClient.get(kb.client_id).push(kb);
    }

    const plannedPairs = new Set(); // dedupe (agent_id|kb_id)

    // Pass 1 — strict name match (KB title contains agent name)
    for (const kb of readyKbs) {
      const kbTitle = normalizeName(kb.title);
      const unmappedAgents = agents.filter(a => a.client_id === kb.client_id && (a.knowledge_base_ids || []).length === 0);
      const named = unmappedAgents.filter(a => {
        const n = normalizeName(a.name);
        return n && kbTitle.includes(n);
      });
      if (named.length === 1) {
        const key = `${named[0].id}|${kb.id}`;
        if (!plannedPairs.has(key)) {
          plannedPairs.add(key);
          plans.push({ agent_id: named[0].id, agent_name: named[0].name, kb_id: kb.id, kb_title: kb.title, client_id: kb.client_id, reason: 'name_match' });
        }
      }
    }

    // Pass 2 — client-scoped fallback: attach every remaining orphan KB to every
    // unmapped agent of the same client. This is the desired business behavior:
    // every agent of a client should be able to answer from that client's KBs.
    for (const [clientId, clientOrphans] of orphansByClient.entries()) {
      const unmappedAgents = agents.filter(a => a.client_id === clientId && (a.knowledge_base_ids || []).length === 0);
      if (unmappedAgents.length === 0) continue;
      for (const agent of unmappedAgents) {
        for (const kb of clientOrphans) {
          const key = `${agent.id}|${kb.id}`;
          if (plannedPairs.has(key)) continue;
          plannedPairs.add(key);
          plans.push({ agent_id: agent.id, agent_name: agent.name, kb_id: kb.id, kb_title: kb.title, client_id: clientId, reason: 'client_scoped' });
        }
      }
    }

    // Pass 3 (force_attach only) — stack remaining orphan KBs onto agents
    // that ALREADY have other KBs in the same client. Use this when you want
    // every agent of a client to see every one of that client's ready KBs.
    if (forceAttach) {
      for (const [clientId, clientOrphans] of orphansByClient.entries()) {
        const clientAgents = agents.filter(a => a.client_id === clientId);
        if (clientAgents.length === 0) continue;
        for (const agent of clientAgents) {
          for (const kb of clientOrphans) {
            const key = `${agent.id}|${kb.id}`;
            if (plannedPairs.has(key)) continue;
            // Skip if already attached
            if ((agent.knowledge_base_ids || []).includes(kb.id)) continue;
            plannedPairs.add(key);
            plans.push({ agent_id: agent.id, agent_name: agent.name, kb_id: kb.id, kb_title: kb.title, client_id: clientId, reason: 'force_attach_stack' });
          }
        }
      }
    }

    if (dryRun) {
      return c.json({ data: { dry_run: true, planned_mappings: plans.length, plans } });
    }

    // Apply all KB-id updates per agent FIRST (one update per agent), then rebuild blob once.
    const planByAgent = new Map();
    for (const plan of plans) {
      if (!planByAgent.has(plan.agent_id)) planByAgent.set(plan.agent_id, { agent_name: plan.agent_name, client_id: plan.client_id, kbs: [] });
      planByAgent.get(plan.agent_id).kbs.push({ kb_id: plan.kb_id, kb_title: plan.kb_title, reason: plan.reason });
    }

    const results = [];
    for (const [agentId, info] of planByAgent.entries()) {
      const agent = agents.find(a => a.id === agentId);
      const nextKbIds = [...new Set([...(agent.knowledge_base_ids || []), ...info.kbs.map(k => k.kb_id)])];
      await base44.asServiceRole.entities.Agent.update(agentId, {
        knowledge_base_ids: nextKbIds,
        kb_file_uri: '',
        kb_file_hash: ''
      });
      agent.knowledge_base_ids = nextKbIds;
      agent.kb_file_uri = '';
      agent.kb_file_hash = '';
      const rebuild = await rebuildAgentKb(base44, agentId);
      results.push({ agent_id: agentId, agent_name: info.agent_name, client_id: info.client_id, attached_kbs: info.kbs, rebuild });
    }

    const rebuildOnlyAgents = agents.filter(agent => (agent.knowledge_base_ids || []).length > 0 && !agent.kb_file_uri);
    const rebuildResults = [];
    for (const agent of rebuildOnlyAgents) {
      const rebuild = await rebuildAgentKb(base44, agent.id);
      rebuildResults.push({ agent_id: agent.id, agent_name: agent.name, rebuild });
    }

    return c.json({ data: { success: true, mapped: results.length, rebuilt_existing: rebuildResults.length, results, rebuildResults } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};