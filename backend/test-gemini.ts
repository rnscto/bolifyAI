import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
await load({ export: true, allowEmptyValues: true });

const key = Deno.env.get("GEMINI_API_KEY");
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${key}`);

ws.onopen = () => {
  console.log("Connected");
  ws.send(JSON.stringify({
    setup: {
      model: "models/gemini-3.1-flash-live-preview",
      generationConfig: { responseModalities: ["AUDIO"] }
    }
  }));
};
ws.onmessage = (e) => console.log("Message:", e.data);
ws.onclose = (e) => { console.log("Closed:", e.code, e.reason); Deno.exit(0); }
