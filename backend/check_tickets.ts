import { connectDB, client } from "./src/db/index.ts";
await connectDB();
const res = await client.queryObject(`SELECT * FROM "ticket" ORDER BY "created_at" DESC LIMIT 5`);
console.log("Recent Tickets:", res.rows);
const msgs = await client.queryObject(`SELECT * FROM "ticketmessage" ORDER BY "created_at" DESC LIMIT 5`);
console.log("Recent Messages:", msgs.rows);
