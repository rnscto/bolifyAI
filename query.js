import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: 'backend/.env' });

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const res = await client.query("SELECT count(*) FROM clientlifecycleevent;");
console.log(res.rows);
await client.end();
