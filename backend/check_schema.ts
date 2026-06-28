import { connectDB, client } from "./src/db/index.ts";
await connectDB();
const res = await client.queryObject(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ticket'`);
console.log("Ticket Schema:", res.rows);
const res2 = await client.queryObject(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ticketmessage'`);
console.log("TicketMessage Schema:", res2.rows);
