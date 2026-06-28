import { connectDB, client } from "./src/db/index.ts";
await connectDB();
try {
  await client.queryObject(`ALTER TABLE "ticketmessage" ADD COLUMN IF NOT EXISTS "attachment_data" TEXT;`);
  await client.queryObject(`ALTER TABLE "ticketmessage" ADD COLUMN IF NOT EXISTS "attachment_type" TEXT;`);
  console.log("Migration successful");
} catch(e) {
  console.error("Migration failed:", e);
}
