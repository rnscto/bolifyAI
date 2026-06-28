import { client } from "../db/index.ts";

export async function processTickets() {
  // Read env vars dynamically to ensure they aren't cached as undefined at boot time
  const baseUrlRaw = (Deno.env.get('AZURE_OPENAI_ENDPOINT') || '').replace(/\/+$/, '');
  const deployment = Deno.env.get('AZURE_OPENAI_DEPLOYMENT');
  const apiKey = Deno.env.get('AZURE_OPENAI_KEY');

  try {
    // Find open and in_progress tickets that are NOT escalated
    const activeTicketsRes = await client.queryObject(`
      SELECT * FROM "ticket" 
      WHERE "status" IN ('open', 'in_progress') 
      AND "escalated_to_admin" IS NOT TRUE
    `);
    const activeTickets: any[] = activeTicketsRes.rows;

    for (const ticket of activeTickets) {
      // Get messages for this ticket, sorted by oldest first
      const messagesRes = await client.queryObject(`
        SELECT * FROM "ticketmessage" 
        WHERE "ticket_id" = $1 
        ORDER BY "created_at" ASC
      `, [ticket.id]);
      const messages: any[] = messagesRes.rows;

      // If the last message is from a client, the AI needs to respond
      if (messages.length > 0 && messages[messages.length - 1].sender_role === 'client') {
        
        console.log(`[TicketAutoResponder] Processing Ticket ${ticket.id}`);

        // Fetch KnowledgeBase articles for context
        const kbRes = await client.queryObject(`SELECT title, content FROM "knowledgebase"`);
        const kbArticles: any[] = kbRes.rows;
        let kbContext = "KNOWLEDGE BASE:\n";
        if (kbArticles.length === 0) {
           kbContext += "No articles available.\n";
        } else {
          kbArticles.forEach(kb => {
            kbContext += `\nTitle: ${kb.title}\nContent: ${kb.content}\n---`;
          });
        }

        // Compile chat history
        let chatHistory = "";
        messages.forEach(m => {
          // If there's attachment data, indicate it in history
          let msgText = m.message;
          if (m.attachment_data) msgText += ` [User attached a ${m.attachment_type} file]`;
          chatHistory += `\n${m.sender_role === 'client' ? 'User' : 'Agent'}: ${msgText}`;
        });

        const systemInstruction = `You are a helpful and technical L1 support agent for an AI voice calling platform.
Your goal is to resolve the user's issue using the provided KNOWLEDGE BASE.
If you know the answer, explain it clearly and politely.
If the issue is too complex, requires manual account changes, or you do NOT know the answer based on the knowledge base, you MUST append exactly [ESCALATE] to your response.

${kbContext}`;

        const promptText = `Ticket Subject: ${ticket.subject}\nCategory: ${ticket.category}\n\nChat History:${chatHistory}\n\nAgent (you):`;

        let aiResponse = "";

        if (apiKey && deployment && baseUrlRaw) {
          try {
            const baseUrl = baseUrlRaw.endsWith('/responses') ? baseUrlRaw.replace('/responses', '') : baseUrlRaw;
            const finalUrl = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`;

            console.log(`[TicketAutoResponder] Calling Azure OpenAI for ticket ${ticket.id}...`);

            const aiRes = await fetch(finalUrl, {
              method: "POST",
              headers: {
                "api-key": apiKey,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                messages: [
                  { role: "system", content: systemInstruction },
                  { role: "user", content: promptText }
                ],
                max_tokens: 500,
                temperature: 0.3
              })
            });

            if (!aiRes.ok) {
               console.error(`[TicketAutoResponder] Azure OpenAI Error HTTP ${aiRes.status}:`, await aiRes.text());
            } else {
               const data = await aiRes.json();
               if (data.choices && data.choices[0]) {
                 aiResponse = data.choices[0].message.content.trim();
                 console.log(`[TicketAutoResponder] AI Response successfully generated.`);
               }
            }
          } catch (e) {
            console.error("[TicketAutoResponder] Azure OpenAI fetch error:", e);
          }
        } else {
           console.warn("[TicketAutoResponder] Azure OpenAI keys are not configured properly. Cannot respond.");
        }

        if (aiResponse) {
          let shouldEscalate = false;
          if (aiResponse.includes("[ESCALATE]")) {
            shouldEscalate = true;
            aiResponse = aiResponse.replace(/\[ESCALATE\]/g, "").trim();
            if (!aiResponse) aiResponse = "I need to escalate this to a human specialist. They will get back to you shortly.";
          }

          // Insert AI reply
          await client.queryObject(
            `INSERT INTO "ticketmessage" ("ticket_id", "sender_id", "sender_role", "message")
             VALUES ($1, $2, $3, $4)`,
            [ticket.id, 'AI_AGENT', 'admin', aiResponse]
          );

          if (shouldEscalate) {
            await client.queryObject(
              `UPDATE "ticket" SET "escalated_to_admin" = true, "status" = 'open', "updated_at" = NOW() WHERE "id" = $1`,
              [ticket.id]
            );
            console.log(`[TicketAutoResponder] Ticket ${ticket.id} escalated by AI.`);
          } else {
            await client.queryObject(
              `UPDATE "ticket" SET "status" = 'in_progress', "updated_at" = NOW() WHERE "id" = $1`,
              [ticket.id]
            );
          }
        }
      }
    }
  } catch (error) {
    console.error("Error in ticket auto-responder:", error);
  }
}

export function initTicketAutoResponder() {
  Deno.cron("Ticket Auto Responder", "*/1 * * * *", async () => {
    console.log("[CRON] Running Ticket Auto Responder...");
    await processTickets();
  });
}
