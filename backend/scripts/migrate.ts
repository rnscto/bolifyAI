import { load } from "@std/dotenv";
import { client } from "../src/db/index.ts";

await load({ export: true, allowEmptyValues: true });

async function migrate() {
  console.log("Starting database migration...");
  
  try {
    // Read the init.sql file
    const sql = await Deno.readTextFile("./scripts/init.sql");
    
    // Execute the SQL
    await client.queryObject(sql);
    
    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    Deno.exit(1);
  } finally {
    Deno.exit(0);
  }
}

migrate();
