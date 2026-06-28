import { Context, Hono } from "hono";
import { bindCustomDomain, unbindCustomDomain } from "../services/azureContainerService.ts";
import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
import { campaignPostCallCore } from "../functions/campaignPostCall.ts";
import { postCallActionExtractorCore } from "../functions/postCallActionExtractor.ts";
export const daprRouter = new Hono();

daprRouter.get("/debug", async (c) => {
  try {
    const res = await fetch("http://localhost:3500/v1.0/metadata");
    const data = await res.json();
    console.log("[Dapr Debug] Metadata:", JSON.stringify(data, null, 2));
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Dapr calls this endpoint on startup to know which topics we are listening to
daprRouter.get("/subscribe", (c) => {
  return c.json([
    {
      pubsubname: "pubsub", // Name of the Dapr pubsub component
      topic: "domain-tasks", // The topic we want to subscribe to
      route: "/api/dapr/domain-tasks", // Our webhook endpoint
    },
    {
      pubsubname: "pubsub",
      topic: "call-tasks",
      route: "/api/dapr/call-tasks",
    },
  ]);
});

// The webhook that receives events from Dapr
daprRouter.post("/domain-tasks", async (c) => {
  try {
    // Dapr wraps the original message inside a CloudEvent JSON structure.
    // The actual payload we published is in the `data` field.
    const cloudEvent = await c.req.json();
    const data = cloudEvent.data;

    console.log(`[Dapr] Received domain task:`, data);

    if (!data || !data.action || !data.domain) {
      console.error("[Dapr] Invalid message payload", data);
      return c.json({ status: "success" }); // Return 200 so Dapr drops the invalid message
    }

    const { action, domain } = data;

    if (action === "bind") {
      try {
        await bindCustomDomain(domain);
        console.log(`[Dapr] Successfully bound domain: ${domain}`);
        // Find mapping and update status to active
        const mappings = await base44.entities.DomainMapping.filter({ custom_domain: domain });
        if (mappings.length > 0) {
          await base44.entities.DomainMapping.update(mappings[0].id, { ssl_status: 'active', ssl_error: null }).catch(() => {});
        }
      } catch (bindErr: any) {
        console.error(`[Dapr] Failed to bind domain ${domain}:`, bindErr);
        const errMsg = bindErr.message || String(bindErr);
        const friendly = errMsg.includes("CustomDomainVerificationFailed") || errMsg.includes("DNS")
          ? "DNS verification failed. Ensure TXT and CNAME records are correct and DNS has propagated."
          : errMsg;
        const mappings = await base44.entities.DomainMapping.filter({ custom_domain: domain });
        if (mappings.length > 0) {
          await base44.entities.DomainMapping.update(mappings[0].id, { ssl_status: 'error', ssl_error: friendly }).catch(() => {});
        }
        // Throw so Dapr retries it (unless it's a fatal DNS error which shouldn't be retried indefinitely, 
        // but for simplicity we let Dapr handle the retry policy).
        throw bindErr;
      }
    } else if (action === "unbind") {
      await unbindCustomDomain(domain);
      console.log(`[Dapr] Successfully unbound domain: ${domain}`);
    } else {
      console.warn(`[Dapr] Unknown action: ${action}`);
    }

    // Always return 200 OK so Dapr knows we processed it successfully.
    // If we throw an error or return 500, Dapr will retry the message later.
    return c.json({ status: "success" });
  } catch (err: any) {
    console.error("[Dapr] Error processing domain task:", err);
    // Returning 500 tells Dapr to retry the message.
    return c.json({ status: "error", message: err.message }, 500);
  }
});

// Webhook for post-call processing (Azure OpenAI summarization, Lead scoring, Campaign follow-ups)
daprRouter.post("/call-tasks", async (c) => {
  try {
    const cloudEvent = await c.req.json();
    const data = cloudEvent.data;
    if (!data || data.action !== "process_post_call") {
      return c.json({ status: "success" }); 
    }

    const { callLogId, transcript, duration, leadId, reqId } = data;
    console.log(`[Dapr] Processing call-task for callLogId: ${callLogId}`);

    let summary = '', leadStatus = 'contacted', sentiment = 'neutral', leadScore = 0, intentSignals: string[] = [], scoreBreakdown: any = {}, keyTopics: string[] = [], summaryHindi = '';

    if (transcript && transcript.trim().length > 30) {
      try {
        const azureKey = Deno.env.get("AZURE_OPENAI_KEY");
        let baseUrlRaw = (Deno.env.get("AZURE_OPENAI_ENDPOINT") || "").replace(/\/+$/, '');
        const _oi = baseUrlRaw.indexOf('/openai/'); 
        if (_oi > 0) baseUrlRaw = baseUrlRaw.substring(0, _oi);
        const azureDeployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT") || "gpt-5.4-pro";
        
        if (azureKey && baseUrlRaw) {
          const azureEndpoint = `${baseUrlRaw}/openai/v1/responses`;
          const sysPrompt = 'Expert sales call analyst. Score 0-100. Respond ONLY in valid JSON.';
          const userPrompt = `Analyze the following AI voice call transcript.\nTranscript:\n${transcript}\n\nReturn JSON exactly matching this format: {"summary":"2-3 sentences","summary_hindi":"Devanagari translation of summary","lead_status":"interested|not_interested|callback|no_answer|converted|contacted|do_not_call","sentiment":"very_positive|positive|neutral|negative|very_negative","lead_score":<number 0-100>,"intent_signals":["signal1", "signal2"],"score_breakdown":{"sentiment_score":0,"intent_score":0,"engagement_score":0,"keyword_score":0,"reasoning":"..."},"key_topics":["topic1", "topic2"],"objections":["obj1"],"recommended_next_action":"..."}\n\nIMPORTANT: Output ONLY valid JSON. Do not include markdown formatting or backticks.`;
          
          const requestBody = JSON.stringify({
            model: azureDeployment,
            instructions: sysPrompt,
            input: userPrompt,
            max_output_tokens: 2000,
            text: { format: { type: 'json_object' } }
          });
          
          let r = await fetch(azureEndpoint, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json', 'api-key': azureKey }, 
            body: requestBody
          });
          
          if (r.ok) {
            const resp = await r.json();
            let raw = resp.output_text || '';
            if (!raw && Array.isArray(resp.output)) {
              for (const item of resp.output) {
                const parts = item?.content || [];
                for (const p of parts) { if ((p.type === 'output_text' || p.type === 'text') && p.text) { raw += p.text; } }
              }
            }
            
            const aText = raw.replace(/^```(?:json)?\n?/i, '').replace(/```$/i, '').trim();
            const a = JSON.parse(aText);
            summary = a.summary || ''; summaryHindi = a.summary_hindi || '';
            leadStatus = a.lead_status || 'contacted'; sentiment = a.sentiment || 'neutral';
            leadScore = Math.min(100, Math.max(0, a.lead_score || 0));
            intentSignals = a.intent_signals || [];
            scoreBreakdown = { ...(a.score_breakdown || {}), objections: a.objections || [], recommended_next_action: a.recommended_next_action || '', key_topics: a.key_topics || [], summary_hindi: summaryHindi };
            keyTopics = a.key_topics || [];
            console.log(`[Dapr][${reqId}] 🧠 Score=${leadScore}, status=${leadStatus}`);
          } else {
            console.error(`[Dapr][${reqId}] Azure OpenAI error:`, await r.text());
          }
        }
      } catch (e: any) { console.error(`[Dapr][${reqId}] AI err: ${e.message}`); }
    } else { summary = 'Call ended with minimal conversation.'; }

    const custLines = transcript ? transcript.split('\\n').filter((l: string) => l.startsWith('Customer:')) : [];
    const custWords = custLines.reduce((a: number, t: string) => a + t.split(/\s+/).length, 0);
    if (custWords <= 5 && duration < 30 && (leadStatus === 'do_not_call' || leadStatus === 'not_interested')) {
      leadStatus = 'contacted'; sentiment = 'neutral'; leadScore = Math.max(leadScore, 10);
    }

    let qTier = 'cold', qReason = '';
    if (leadScore >= 75 && ['very_positive', 'positive'].includes(sentiment)) { qTier = 'hot'; qReason = `${leadScore}/100, ${sentiment}`; }
    else if (leadScore >= 50) { qTier = 'warm'; qReason = `${leadScore}/100`; }
    else if (leadScore >= 25) { qTier = 'nurture'; qReason = `${leadScore}/100`; }
    else if (['negative', 'very_negative'].includes(sentiment)) qTier = 'disqualified';
    if (leadStatus === 'converted') qTier = 'hot';
    if (leadStatus === 'do_not_call') qTier = 'disqualified';

    const enriched = summary ? `${summary}${summaryHindi ? '\n\n🇮🇳 ' + summaryHindi : ''}\n\n---\nScore: ${leadScore}/100 | ${sentiment} | ${qTier} | ${intentSignals.join(', ')}` : '';

    // Update CallLog
    await client.queryObject(`
      UPDATE "calllog" 
      SET lead_status_updated = $1, conversation_summary = $2
      WHERE id = $3
    `, [leadStatus, enriched || null, callLogId]);
    console.log(`[Dapr][${reqId}] 💾 AI Summary Saved to CallLog: ${callLogId}, score=${leadScore}`);

    // Update Lead
    if (leadId) {
      try {
        const exQuery = await client.queryObject(`SELECT * FROM "lead" WHERE id = $1 LIMIT 1`, [leadId]);
        const ex = exQuery.rows[0] as any;
        if (ex) {
           const merged = [...new Set([...(ex.tags || []), ...keyTopics.slice(0, 10)])];
           await client.queryObject(`
             UPDATE "lead"
             SET status = $1, score = $2, sentiment = $3, intent_signals = $4, score_breakdown = $5,
                 qualification_tier = $6, qualification_reason = $7, tags = $8,
                 last_call_date = $9, last_engagement_date = $10,
                 engagement_count = $11, notes = $12
             WHERE id = $13
           `, [
             leadStatus, leadScore, sentiment, JSON.stringify(intentSignals), JSON.stringify(scoreBreakdown),
             qTier, qReason, JSON.stringify(merged),
             new Date().toISOString(), new Date().toISOString(),
             (ex.engagement_count || 0) + 1,
             `[Score: ${leadScore}/100 | ${sentiment} | ${qTier}] ${summary.substring(0, 300)}`,
             leadId
           ]);
        }
      } catch (e: any) { console.error(`[Dapr][${reqId}] Lead err: ${e.message}`); }
    }

    // Trigger Orchestrators
    if (callLogId) {
        try {
          console.log(`[Dapr][${reqId}] 🚀 Triggering Post-Call Orchestrator for ${callLogId}`);
          const clRes = await client.queryObject(`SELECT id, campaign_id FROM "campaignlead" WHERE call_log_id = $1 LIMIT 1`, [callLogId]);
          if (clRes.rows.length > 0) {
            const cl = clRes.rows[0] as any;
            await campaignPostCallCore(callLogId, cl.campaign_id);
          } else {
            await postCallActionExtractorCore(callLogId);
          }
        } catch (postErr: any) {
          console.error(`[Dapr][${reqId}] ❌ Post-Call Orchestrator error: ${postErr.message}`);
        }
    }

    return c.json({ status: "success" });
  } catch (err: any) {
    console.error("[Dapr] Error processing call task:", err);
    return c.json({ status: "error", message: err.message }, 500);
  }
});
