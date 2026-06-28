import { client } from "../db/index.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

export async function processTickets() {
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
          chatHistory += `\n${m.sender_role === 'client' ? 'User' : 'Agent'}: ${m.message}`;
        });

        const systemInstruction = `You are a helpful and technical L1 support agent for an AI voice calling platform.
Your goal is to resolve the user's issue using the provided KNOWLEDGE BASE.
If you know the answer, explain it clearly and politely.
If the issue is too complex, requires manual account changes, or you do NOT know the answer based on the knowledge base, you MUST append exactly [ESCALATE] to your response.

${kbContext}`;

        const promptText = `Ticket Subject: ${ticket.subject}\nCategory: ${ticket.category}\n\nChat History:${chatHistory}\n\nAgent (you):`;

        let aiResponse = "";

        if (GEMINI_API_KEY) {
          try {
            const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                system_instruction: {
                  parts: [{ text: systemInstruction }]
                },
                contents: [{
                  parts: [{ text: promptText }]
                }],
                generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
              })
            });
            const data = await geminiRes.json();
            if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
              aiResponse = data.candidates[0].content.parts[0].text.trim();
            }
          } catch (e) {
            console.error("Gemini error:", e);
          }
        } else if (OPENAI_API_KEY) {
          try {
            const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "gpt-4o",
                messages: [
                  { role: "system", content: systemInstruction },
                  { role: "user", content: promptText }
                ],
                max_tokens: 500,
                temperature: 0.3
              })
            });
            const data = await aiRes.json();
            if (data.choices && data.choices[0]) {
              aiResponse = data.choices[0].message.content.trim();
            }
          } catch (e) {
            console.error("OpenAI error:", e);
          }
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
            console.log(`Ticket ${ticket.id} escalated by AI.`);
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
