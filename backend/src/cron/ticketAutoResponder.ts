import { client } from "../db/index.ts";
import { callAzureLLM } from "../lib/azureOpenAI.ts";

export async function processTickets() {
  const apiKey = Deno.env.get("AZURE_OPENAI_KEY");
  const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT");
  const endpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");

  if (!apiKey || !deployment || !endpoint) {
    console.warn("[TicketAutoResponder] Azure OpenAI keys are not configured. Skipping.");
    return;
  }

  try {
    const activeTicketsRes = await client.queryObject(`
      SELECT * FROM "ticket" 
      WHERE "status" IN ('open', 'in_progress') 
      AND "escalated_to_admin" IS NOT TRUE
    `);
    const activeTickets: any[] = activeTicketsRes.rows;

    for (const ticket of activeTickets) {
      const messagesRes = await client.queryObject(`
        SELECT * FROM "ticketmessage" 
        WHERE "ticket_id" = $1 
        ORDER BY "created_at" ASC
      `, [ticket.id]);
      const messages: any[] = messagesRes.rows;

      if (messages.length === 0 || messages[messages.length - 1].sender_role !== "client") {
        continue; // Only respond when the last message is from a client
      }

      console.log(`[TicketAutoResponder] Processing Ticket ${ticket.id}`);

      // Fetch KnowledgeBase articles for context
      const kbRes = await client.queryObject(`SELECT title, content FROM "knowledgebase" LIMIT 20`);
      const kbArticles: any[] = kbRes.rows;
      let kbContext = "KNOWLEDGE BASE:\n";
      if (kbArticles.length === 0) {
        kbContext += "No articles available.\n";
      } else {
        kbArticles.forEach(kb => {
          kbContext += `\nTitle: ${kb.title}\nContent: ${(kb.content || "").substring(0, 600)}\n---`;
        });
      }

      // Build chat history
      let chatHistory = "";
      messages.forEach(m => {
        let msgText = m.message || "";
        if (m.attachment_data) msgText += ` [User attached a ${m.attachment_type} file]`;
        chatHistory += `\n${m.sender_role === "client" ? "User" : "Agent"}: ${msgText}`;
      });

      const systemInstruction = `You are a helpful and technical L1 support agent for an AI voice calling platform.
Your goal is to resolve the user's issue using the provided KNOWLEDGE BASE.
If you know the answer, explain it clearly and politely.
If the issue is too complex, requires manual account changes, or you do NOT know the answer based on the knowledge base, you MUST append exactly [ESCALATE] to your response.

${kbContext}`;

      const promptText = `Ticket Subject: ${ticket.subject}\nCategory: ${ticket.category}\n\nChat History:${chatHistory}\n\nAgent (you):`;

      let aiResponse = "";
      try {
        console.log(`[TicketAutoResponder] Calling Azure OpenAI for ticket ${ticket.id}...`);
        aiResponse = await callAzureLLM(
          [
            { role: "system", content: systemInstruction },
            { role: "user", content: promptText },
          ],
          { maxTokens: 500, temperature: 0.3 }
        );
        console.log(`[TicketAutoResponder] AI Response generated for ticket ${ticket.id}.`);
      } catch (e: any) {
        console.error(`[TicketAutoResponder] Azure OpenAI error for ticket ${ticket.id}:`, e.message);
        continue; // Don't insert a blank reply
      }

      if (!aiResponse) continue;

      let shouldEscalate = false;
      if (aiResponse.includes("[ESCALATE]")) {
        shouldEscalate = true;
        aiResponse = aiResponse.replace(/\[ESCALATE\]/g, "").trim();
        if (!aiResponse) aiResponse = "I need to escalate this to a human specialist. They will get back to you shortly.";
      }

      await client.queryObject(
        `INSERT INTO "ticketmessage" ("ticket_id", "sender_id", "sender_role", "message")
         VALUES ($1, $2, $3, $4)`,
        [ticket.id, "AI_AGENT", "admin", aiResponse]
      );

      if (shouldEscalate) {
        await client.queryObject(
          `UPDATE "ticket" SET "escalated_to_admin" = true, "status" = 'open', "updated_at" = NOW() WHERE "id" = $1`,
          [ticket.id]
        );
        console.log(`[TicketAutoResponder] Ticket ${ticket.id} escalated.`);
      } else {
        await client.queryObject(
          `UPDATE "ticket" SET "status" = 'in_progress', "updated_at" = NOW() WHERE "id" = $1`,
          [ticket.id]
        );
      }
    }
  } catch (error: any) {
    console.error("[TicketAutoResponder] Fatal error:", error.message);
  }
}

export function initTicketAutoResponder() {
  Deno.cron("Ticket Auto Responder", "*/1 * * * *", async () => {
    console.log("[CRON] Running Ticket Auto Responder...");
    await processTickets();
  });
}
