import { connectDB, client } from "./src/db/index.ts";
await connectDB();
try {
  await client.queryObject(`ALTER TABLE ticket ADD COLUMN priority text`);
  console.log("Added priority column");
} catch(e) {
  console.log("Priority column might already exist:", e.message);
}
