import { client } from "./backend/src/db/index.ts";

async function main() {
  try {
    const res = await client.queryObject(`SELECT count(*) FROM clientlifecycleevent`);
    console.log("Events count:", res.rows[0]);
    
    const res2 = await client.queryObject(`SELECT count(*) FROM client`);
    console.log("Clients count:", res2.rows[0]);
  } catch (e) {
    console.error(e);
  } finally {
    client.end();
  }
}
main();
