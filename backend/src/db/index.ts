import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

try {
  await load({ export: true, allowEmptyValues: true, envPath: new URL("../../.env", import.meta.url).pathname });
} catch (e: any) {
  console.log("Skipping dotenv load (expected in prod):", e.message);
}

const databaseUrl = Deno.env.get("DATABASE_URL") || "postgresql://postgres:postgres@localhost:5432/bolifyai";

// Initialize PostgreSQL connection pool wrapper
class DBWrapper {
  private pool: Pool;

  constructor(url: string) {
    this.pool = new Pool(url, 10, true);
  }

  async connect() {
    const conn = await this.pool.connect();
    conn.release();
  }

  async queryObject(query: string, params?: any[]) {
    const conn = await this.pool.connect();
    try {
      return await conn.queryObject(query, params);
    } finally {
      conn.release();
    }
  }
}

export const client = new DBWrapper(databaseUrl);

export async function connectDB() {
  try {
    await client.connect();
    console.log("Connected to PostgreSQL successfully with Connection Pool");
  } catch (error) {
    console.error("Failed to connect to PostgreSQL. API will start but DB operations will fail:", error);
    // Removed Deno.exit(1) to allow server to start for testing
  }
}
