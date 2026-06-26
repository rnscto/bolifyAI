import { base44ORM as base44 } from "../db/orm.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

export async function processTickets() {
  try {
    // Find open tickets with no messages or where last message was from client and not responded to by admin/AI
    // For simplicity, find tickets in 'open' status
    const openTickets = await base44.entities.Ticket.filter({ status: 'open' });

    for (const ticket of openTickets) {
      // Get messages for this ticket
      const messages = await base44.entities.TicketMessage.filter({ ticket_id: ticket.id });

      // If no messages or the last message is from the client, we might want to auto-respond
      if (messages.length === 0) {
        // AI Auto-Responder
        let aiResponse = "Thank you for reaching out. We have received your ticket and will look into it shortly.";

        if (OPENAI_API_KEY) {
          try {
            const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "gpt-5.4-pro",
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
        await base44.entities.TicketMessage.create({
          ticket_id: ticket.id,
          sender_id: 'AI_AGENT',
          sender_role: 'admin',
          message: aiResponse
        });

        // Update ticket status to in_progress so we don't auto-respond repeatedly
        await base44.entities.Ticket.update(ticket.id, { status: 'in_progress' });
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
