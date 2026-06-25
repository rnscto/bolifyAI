import { base44ORM } from "./backend/src/db/orm.ts";
import { connectDB } from "./backend/src/db/index.ts";

async function run() {
  await connectDB();
  try {
    const clients = await base44ORM.entities.Client.filter({});
    console.log("Client Account Status:", clients.map(c => ({ id: c.id, status: c.account_status })));
  } catch (error) {
    console.error("Error:", error);
  }
  Deno.exit(0);
}
run();
