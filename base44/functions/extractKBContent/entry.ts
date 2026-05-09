import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    const payload = await req.json();
    const { event, data } = payload;

    // Entity automation trigger
    if (event && event.entity_name === 'KnowledgeBase' && event.type === 'create') {
      const kbId = event.entity_id;
      const fileUrl = data?.file_url;

      if (!fileUrl) {
        console.log(`[extractKB] No file_url on KB ${kbId}, skipping`);
        return Response.json({ success: true, skipped: 'no_file_url' });
      }

      console.log(`[extractKB] Extracting content from KB ${kbId}: ${fileUrl}`);

      const extracted = await svc.integrations.Core.ExtractDataFromUploadedFile({
        file_url: fileUrl,
        json_schema: {
          type: "object",
          properties: {
            text_content: {
              type: "string",
              description: "The full text content extracted from the document"
            }
          }
        }
      });

      if (extracted.status === 'success' && extracted.output) {
        const content = typeof extracted.output === 'string' 
          ? extracted.output 
          : extracted.output.text_content || JSON.stringify(extracted.output);

        await svc.entities.KnowledgeBase.update(kbId, {
          content: content.substring(0, 50000), // Limit to 50k chars
          status: 'ready'
        });

        console.log(`[extractKB] KB ${kbId} content extracted: ${content.length} chars`);

        // ─── Auto-rebuild Azure Blob KB for any agent using this doc ───
        try {
          const clientId = data?.client_id;
          if (clientId) {
            const agents = await svc.entities.Agent.filter({ client_id: clientId });
            const affected = agents.filter(a => (a.knowledge_base_ids || []).includes(kbId));
            console.log(`[extractKB] Triggering uploadKBToStorage for ${affected.length} affected agent(s)`);
            for (const a of affected) {
              svc.functions.invoke('uploadKBToStorage', { agent_id: a.id, _internal: true })
                .catch(e => console.error(`[extractKB] uploadKBToStorage(${a.id}) failed: ${e.message}`));
            }
          }
        } catch (rebuildErr) {
          console.error(`[extractKB] KB rebuild trigger failed: ${rebuildErr.message}`);
        }

        return Response.json({ success: true, chars: content.length });
      } else {
        console.error(`[extractKB] Extraction failed for KB ${kbId}:`, extracted.details);
        await svc.entities.KnowledgeBase.update(kbId, {
          status: 'failed'
        });
        return Response.json({ success: false, error: extracted.details });
      }
    }

    // Direct invocation fallback
    if (payload.kb_id) {
      const kb = await svc.entities.KnowledgeBase.get(payload.kb_id);
      if (!kb || !kb.file_url) {
        return Response.json({ error: 'KB not found or no file' }, { status: 400 });
      }

      const extracted = await svc.integrations.Core.ExtractDataFromUploadedFile({
        file_url: kb.file_url,
        json_schema: {
          type: "object",
          properties: {
            text_content: {
              type: "string",
              description: "The full text content extracted from the document"
            }
          }
        }
      });

      if (extracted.status === 'success' && extracted.output) {
        const content = typeof extracted.output === 'string'
          ? extracted.output
          : extracted.output.text_content || JSON.stringify(extracted.output);

        await svc.entities.KnowledgeBase.update(payload.kb_id, {
          content: content.substring(0, 50000),
          status: 'ready'
        });

        // Auto-rebuild Azure Blob KB for affected agents
        try {
          if (kb.client_id) {
            const agents = await svc.entities.Agent.filter({ client_id: kb.client_id });
            const affected = agents.filter(a => (a.knowledge_base_ids || []).includes(payload.kb_id));
            for (const a of affected) {
              svc.functions.invoke('uploadKBToStorage', { agent_id: a.id, _internal: true }).catch(() => {});
            }
            console.log(`[extractKB] Triggered KB rebuild for ${affected.length} agent(s)`);
          }
        } catch (_) {}

        return Response.json({ success: true, chars: content.length });
      } else {
        await svc.entities.KnowledgeBase.update(payload.kb_id, {
          status: 'failed'
        });
        return Response.json({ success: false, error: extracted.details });
      }
    }

    return Response.json({ success: true, skipped: 'no_matching_trigger' });

  } catch (error) {
    console.error('[extractKB] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});