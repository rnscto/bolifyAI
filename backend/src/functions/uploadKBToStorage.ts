import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════
// uploadKBToStorage
// Concatenates all KB docs of an agent into one text file, uploads it
// to private storage, and stores the URI on Agent.kb_file_uri.
//
// This keeps agent_config_cache small (just a URI instead of full text)
// and removes the field-size limit — KBs can now be any size.
//
// Call this:
//   - On demand from initiateCall if Agent.kb_file_uri is missing
//   - From an entity automation when Agent.knowledge_base_ids changes
//   - Manually to rebuild (e.g. after editing KB docs)
// ═══════════════════════════════════════════════════════════════════


import { BlobServiceClient } from 'npm:@azure/storage-blob@12.17.0';

// ─── Azure Blob private upload (replaces Core.UploadPrivateFile) ───
async function uploadPrivateToAzure(buffer, blobName, contentType = 'text/plain') {
  const conn = Deno.env.get('AZURE_STORAGE_CONNECTION_STRING');
  const container = Deno.env.get('AZURE_STORAGE_CONTAINER_PRIVATE');
  if (!conn || !container) throw new Error('Azure Blob not configured');
  const svc = BlobServiceClient.fromConnectionString(conn);
  const blob = svc.getContainerClient(container).getBlockBlobClient(blobName);
  await blob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } });
  return `azblob://${container}/${blobName}`;
}

// Simple content hash (djb2) — lightweight, good enough for change detection
function djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

async function buildKBFile(base44, agentId) {
  const agent = await base44.asServiceRole.entities.Agent.get(agentId);
  if (!agent) throw new Error('Agent not found');

  const kbIds = agent.knowledge_base_ids || [];
  if (kbIds.length === 0) {
    return { skipped: true, reason: 'no_kb_docs', agent_id: agentId };
  }

  // Fetch all KB docs in parallel
  const kbDocs = (await Promise.all(
    kbIds.map(id => base44.asServiceRole.entities.KnowledgeBase.get(id).catch(() => null))
  )).filter(d => d && d.content);

  if (kbDocs.length === 0) {
    return { skipped: true, reason: 'no_kb_content', agent_id: agentId };
  }

  // Concatenate with clear section boundaries (RAG chunker uses "---" as doc delimiter)
  const concatenated = kbDocs
    .map(d => `[${d.title || 'Untitled'}]\n${d.content}`)
    .join('\n\n---\n\n');

  const hash = djb2Hash(concatenated);

  // Short-circuit: if hash matches AND file URI is on Azure Blob, no need to re-upload.
  // Legacy Base44 URIs (mp/private/...) must be migrated even when content is unchanged.
  if (agent.kb_file_hash === hash && agent.kb_file_uri && agent.kb_file_uri.startsWith('azblob://')) {
    return {
      skipped: true,
      reason: 'unchanged',
      agent_id: agentId,
      kb_file_uri: agent.kb_file_uri,
      kb_char_count: concatenated.length
    };
  }

  // Upload to Azure Blob private container
  const buffer = new TextEncoder().encode(concatenated);
  const blobName = `kb/agent_${agentId}_${Date.now()}.txt`;
  const fileUri = await uploadPrivateToAzure(buffer, blobName, 'text/plain');
  if (!fileUri) throw new Error('Azure Blob upload did not return file_uri');

  // Persist URI + hash on the agent
  await base44.asServiceRole.entities.Agent.update(agentId, {
    kb_file_uri: fileUri,
    kb_file_hash: hash,
    kb_last_built_at: new Date().toISOString(),
    kb_char_count: concatenated.length
  });

  console.log(`[uploadKBToStorage] agent=${agentId}: uploaded ${concatenated.length} chars from ${kbDocs.length} docs → ${fileUri}`);

  return {
    success: true,
    agent_id: agentId,
    kb_file_uri: fileUri,
    kb_char_count: concatenated.length,
    kb_doc_count: kbDocs.length
  };
}

export default async function uploadKBToStorage(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const body = await c.req.json().catch(() => ({}));

    // Support 3 invocation modes:
    //  1) Entity automation payload: { event: {...}, data: {...} } — rebuild if KB changed
    //  2) Manual: { agent_id } — rebuild one agent
    //  3) Bulk: { client_id } — rebuild all agents for a client (admin)
    let agentIds = [];

    if (body?.event?.entity_name === 'Agent') {
      const data = body.data || {};
      const oldData = body.old_data || {};
      const kbIdsChanged = JSON.stringify(data.knowledge_base_ids || []) !== JSON.stringify(oldData.knowledge_base_ids || []);
      // Only rebuild on create, or when KB list changes on update
      if (body.event.type === 'create' || (body.event.type === 'update' && kbIdsChanged)) {
        if (body.event.entity_id) agentIds = [body.event.entity_id];
      } else {
        return c.json({ data: { skipped: true, reason: 'no_kb_change' } });
      }
    } else if (body?.event?.entity_name === 'KnowledgeBase') {
      // KB doc content changed → find every agent that uses this doc and rebuild.
      // Trigger conditions on the automation already pre-filter to only content/title changes,
      // so we don't re-check changed fields here.
      const kbId = body.event.entity_id;
      if (!kbId) return c.json({ data: { skipped: true, reason: 'no_kb_id' } });

      // Find all agents that reference this KB doc
      const allAgents = await base44.asServiceRole.entities.Agent.list('-created_date', 1000);
      agentIds = allAgents
        .filter(a => Array.isArray(a.knowledge_base_ids) && a.knowledge_base_ids.includes(kbId))
        .map(a => a.id);
      if (agentIds.length === 0) {
        return c.json({ data: { skipped: true, reason: 'no_agents_use_this_kb', kb_id: kbId } });
      }
      console.log(`[uploadKBToStorage] KB ${kbId} changed → rebuilding ${agentIds.length} agent(s)`);
    } else if (body?.agent_id) {
      agentIds = [body.agent_id];
    } else if (body?.client_id) {
      const agents = await base44.asServiceRole.entities.Agent.filter({ client_id: body.client_id });
      agentIds = agents.map(a => a.id);
    } else if (body?.rebuild_all) {
      // Admin one-time bulk rebuild: only agents with non-empty KB lists
      const all = await base44.asServiceRole.entities.Agent.list('-created_date', 500);
      agentIds = all.filter(a => Array.isArray(a.knowledge_base_ids) && a.knowledge_base_ids.length > 0).map(a => a.id);
      console.log(`[uploadKBToStorage] rebuild_all: ${agentIds.length} agents have KB docs`);
    } else {
      return c.json({ data: { error: 'Provide agent_id, client_id, rebuild_all, or entity automation payload' } }, 400);
    }

    const results = [];
    for (const id of agentIds) {
      try {
        results.push(await buildKBFile(base44, id));
      } catch (e) {
        console.error(`[uploadKBToStorage] agent=${id} failed: ${e.message}`);
        results.push({ agent_id: id, error: e.message });
      }
    }

    return c.json({ data: { results } });
  } catch (error) {
    console.error('[uploadKBToStorage] error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};