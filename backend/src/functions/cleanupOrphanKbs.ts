import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// ═══════════════════════════════════════════════════════════════════════
// cleanupOrphanKbs — admin-only utility (Option 3)
//
// 1. Identifies KBs that are not referenced by ANY agent's knowledge_base_ids.
// 2. Auto-deletes "obvious junk":
//      • Title length < 6 chars or matches gibberish pattern
//      • Title matches "AI-Generated KB — ..." AND a NEWER one exists
//        for the same client (superseded drafts)
// 3. Returns the remaining orphans for human review.
//
// Usage:
//   POST {} (dry_run defaults to true)
//   POST { "dry_run": false } to actually delete
// ═══════════════════════════════════════════════════════════════════════



const JUNK_PATTERNS = [
  /^[a-z]{1,8}$/i,            // single short lowercase word (sdfvgsdfbg, productq, FAQs are OK because uppercase letters present)
  /^[a-z0-9]{2,10}$/i,        // short alphanumeric jumble
  /^[bcdfghjklmnpqrstvwxyz]{4,}$/i // consonant-only jumble
];

function isGibberishTitle(title) {
  const t = String(title || '').trim();
  if (t.length < 4) return true;
  // Heuristic: ≥6 consecutive consonants → likely jumble (sdfvgsdfbg)
  if (/[bcdfghjklmnpqrstvwxyz]{6,}/i.test(t)) return true;
  // Heuristic: short with no vowel (e.g. "sfgh")
  if (t.length <= 8 && !/[aeiou]/i.test(t)) return true;
  return false;
}

function isAIGeneratedTitle(title) {
  return /^AI-Generated KB\b/i.test(String(title || ''));
}

export default async function cleanupOrphanKbs(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user || user.role !== 'admin') {
      return c.json({ data: { error: 'Forbidden: Admin only' } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const dryRun = body.dry_run !== false; // default true

    const body2 = body; // alias for clarity
    const includeNoAgentClients = body2.include_no_agent_clients !== false; // default true — delete orphans from clients that have zero agents

    const [agents, kbs] = await Promise.all([
      base44.asServiceRole.entities.Agent.list('-updated_date', 1000),
      base44.asServiceRole.entities.KnowledgeBase.list('-created_date', 1000)
    ]);

    // Set of KB IDs referenced anywhere
    const referenced = new Set();
    for (const a of agents) for (const id of (a.knowledge_base_ids || [])) referenced.add(id);

    // Set of client_ids that have at least one agent
    const clientsWithAgents = new Set(agents.map(a => a.client_id).filter(Boolean));

    const orphans = kbs.filter(kb => !referenced.has(kb.id));

    // Group AI-Generated orphans per client to find superseded drafts
    const aiByClient = new Map();
    for (const kb of orphans) {
      if (!isAIGeneratedTitle(kb.title) || !kb.client_id) continue;
      if (!aiByClient.has(kb.client_id)) aiByClient.set(kb.client_id, []);
      aiByClient.get(kb.client_id).push(kb);
    }
    // Sort each client's AI-generated orphans by created_date (newest first)
    const supersededIds = new Set();
    for (const list of aiByClient.values()) {
      list.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
      // Keep newest, mark older ones as superseded
      for (let i = 1; i < list.length; i++) supersededIds.add(list[i].id);
    }
    // Also check if a NON-orphan AI-Generated KB exists for the client → all AI orphans of that client are superseded
    for (const a of agents) {
      for (const kbId of (a.knowledge_base_ids || [])) {
        const kb = kbs.find(k => k.id === kbId);
        if (kb && isAIGeneratedTitle(kb.title) && a.client_id) {
          const aiOrphans = aiByClient.get(a.client_id) || [];
          for (const o of aiOrphans) supersededIds.add(o.id);
        }
      }
    }

    const toDelete = [];
    const toReview = [];

    for (const kb of orphans) {
      let reason = null;
      if (isGibberishTitle(kb.title)) reason = 'gibberish_title';
      else if (supersededIds.has(kb.id)) reason = 'superseded_ai_draft';
      // Empty/no-content KBs are also junk
      else if (!kb.content || kb.content.length < 50) reason = 'empty_content';
      // KBs belonging to clients that have NO agents → un-attachable, safe to delete
      else if (includeNoAgentClients && kb.client_id && !clientsWithAgents.has(kb.client_id)) reason = 'no_agents_for_client';

      if (reason) {
        toDelete.push({
          id: kb.id,
          title: kb.title,
          client_id: kb.client_id,
          content_length: (kb.content || '').length,
          created_date: kb.created_date,
          reason
        });
      } else {
        toReview.push({
          id: kb.id,
          title: kb.title,
          client_id: kb.client_id,
          content_length: (kb.content || '').length,
          created_date: kb.created_date,
          status: kb.status
        });
      }
    }

    if (!dryRun) {
      let deleted = 0, failed = 0;
      for (const item of toDelete) {
        try {
          await base44.asServiceRole.entities.KnowledgeBase.delete(item.id);
          deleted++;
        } catch (e) {
          failed++;
          item.delete_error = e.message;
        }
      }
      return c.json({ data: {
        success: true,
        dry_run: false,
        deleted,
        failed,
        deleted_items: toDelete,
        remaining_for_review: toReview.length,
        review_list: toReview
      } });
    }

    return c.json({ data: {
      dry_run: true,
      would_delete: toDelete.length,
      would_keep_for_review: toReview.length,
      delete_preview: toDelete,
      review_list: toReview
    } });
  } catch (error) {
    return c.json({ data: { error: error.message } }, 500);
  }

};