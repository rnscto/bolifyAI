import { connectDB, client } from "./src/db/index.ts";
await connectDB();
const res = await client.queryObject(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'user'`);
console.log("User Schema:", res.rows);
const res2 = await client.queryObject(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'client'`);
console.log("Client Schema:", res2.rows);
