import { GoogleGenAI } from "npm:@google/genai";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
await load({ export: true, allowEmptyValues: true });

const ai = new GoogleGenAI({ apiKey: Deno.env.get("GEMINI_API_KEY") });

async function run() {
  const ws = await ai.clients.createWebSocketClient({
    model: "gemini-2.0-flash",
  });
  
  ws.connect();
  
  ws.on('open', () => {
    console.log("Connected via SDK!");
    ws.disconnect();
  });
  
  ws.on('close', (e) => {
    console.log("Closed via SDK", e);
  });
  
  ws.on('error', (e) => {
    console.log("Error via SDK", e);
  });
}

run();
