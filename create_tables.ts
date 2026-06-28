import { client } from "./backend/src/db/index.ts";

async function run() {
  await client.queryObject(`
    CREATE TABLE IF NOT EXISTS "ticket" (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID,
      subject TEXT,
      category TEXT DEFAULT 'other',
      status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'medium',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS "ticketmessage" (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID REFERENCES "ticket"(id) ON DELETE CASCADE,
      sender_id TEXT,
      sender_role TEXT,
      message TEXT,
      attachment_url TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
  console.log("Tables created!");
}

run();
