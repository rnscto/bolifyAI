import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
await load({ export: true, allowEmptyValues: true });
console.log("SMARTFLO_EMAIL:", Deno.env.get("SMARTFLO_EMAIL"));
