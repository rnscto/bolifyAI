import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { load } from "jsr:@std/dotenv";

await load({ export: true, allowEmptyValues: true });

const dbUrl = Deno.env.get("DATABASE_URL");
if (!dbUrl) {
  console.error("No DATABASE_URL found in .env");
  Deno.exit(1);
}

console.log("Connecting to Azure Postgres...");
const client = new Client(dbUrl);
await client.connect();

console.log("Reading init.sql...");
const sql = await Deno.readTextFile("./scripts/init.sql");

console.log("Applying schema...");
try {
  await client.queryArray(sql);
  console.log("Successfully created all tables in Azure PostgreSQL!");
} catch (err) {
  console.error("Error creating tables:", err);
} finally {
  await client.end();
}
