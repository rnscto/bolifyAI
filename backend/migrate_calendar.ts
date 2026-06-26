import { client } from "./src/db/index.ts";
await client.queryObject(`CREATE TABLE IF NOT EXISTS "calendarintegration" ( "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, "client_id" TEXT, "provider" TEXT, "access_token" TEXT, "refresh_token" TEXT, "expires_at" TIMESTAMP WITH TIME ZONE, "account_email" TEXT, "status" TEXT );`);
console.log("Done");
Deno.exit(0);
