import { Pool } from "https://deno.land/x/postgres@v0.19.2/mod.ts";
const pool = new Pool({database: "db", user: "u", port: 5432, hostname: "localhost"}, 10);
console.log("connect type:", typeof pool.connect);
console.log("queryObject type:", typeof pool.queryObject);
