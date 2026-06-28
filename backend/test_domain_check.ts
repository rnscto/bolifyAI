import "jsr:@std/dotenv/load";
import { client } from "./src/db/index.ts";

async function test() {
  // Check actual domainmapping table columns
  const res = await client.queryObject(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'domainmapping'
    ORDER BY ordinal_position
  `);
  console.log("DomainMapping columns:", res.rows);
  Deno.exit(0);
}
test();
