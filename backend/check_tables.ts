import { connectDB, client } from "./src/db/index.ts";
await connectDB();
const result = await client.queryObject("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
console.log(result.rows);
