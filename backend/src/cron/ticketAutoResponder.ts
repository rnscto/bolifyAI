import { client } from "../db/index.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

export async function processTickets() {
  try {
    // Find open tickets with no messages
    const openTicketsRes = await client.queryObject(`SELECT * FROM "ticket" WHERE "status" = 'open'`);
    const openTickets: any[] = openTicketsRes.rows;

    for (const ticket of openTickets) {
      // Get messages for this ticket
      const messagesRes = await client.queryObject(`SELECT * FROM "ticketmessage" WHERE "ticket_id" = $1`, [ticket.id]);
      const messages: any[] = messagesRes.rows;

      // If no messages or the last message is from the client, we might want to auto-respond
      if (messages.length === 0) {
        // AI Auto-Responder
        let aiResponse = "Thank you for reaching out. We have received your ticket and will look into it shortly.";

        if (Deno.env.get("GEMINI_API_KEY")) {
          try {
            const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${Deno.env.get("GEMINI_API_KEY")}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                system_instruction: {
                  parts: [{ text: "You are a helpful support agent for an AI voice calling platform. Give a short, polite initial response acknowledging the issue." }]
                },
                contents: [{
                  parts: [{ text: `Subject: ${ticket.subject}\n\nCategory: ${ticket.category}\n\nPlease help.` }]
                }],
                generationConfig: { maxOutputTokens: 100 }
              })
            });
            const data = await geminiRes.json();
            if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
              aiResponse = data.candidates[0].content.parts[0].text;
            }
          } catch (e) {
            console.error("Gemini error:", e);
          }
        } else if (OPENAI_API_KEY) {
          // Fallback to OpenAI if Gemini isn't configured
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
                  { role: "system", content: "You are a helpful support agent for an AI voice calling platform. Give a short, polite initial response acknowledging the issue." },
                  { role: "user", content: `Subject: ${ticket.subject}\n\nCategory: ${ticket.category}\n\nPlease help.` }
                ],
                max_tokens: 100
              })
            });
            const data = await aiRes.json();
            if (data.choices && data.choices[0]) {
              aiResponse = data.choices[0].message.content;
            }
          } catch (e) {
            console.error("OpenAI error:", e);
          }
        }

        // Add AI message
        await client.queryObject(
          `INSERT INTO "ticketmessage" ("ticket_id", "sender_id", "sender_role", "message")
           VALUES ($1, $2, $3, $4)`,
          [ticket.id, 'AI_AGENT', 'admin', aiResponse]
        );

        // Update ticket status to in_progress so we don't auto-respond repeatedly
        await client.queryObject(
          `UPDATE "ticket" SET "status" = 'in_progress', "updated_at" = NOW() WHERE "id" = $1`,
          [ticket.id]
        );
        
        console.log(`Auto-responded to ticket ${ticket.id}`);
      }
    }
  } catch (error) {
    console.error("Error in ticket auto-responder:", error);
  }
}

export function initTicketAutoResponder() {
  Deno.cron("Ticket Auto Responder", "*/5 * * * *", async () => {
    console.log("[CRON] Running Ticket Auto Responder...");
    await processTickets();
  });
}
