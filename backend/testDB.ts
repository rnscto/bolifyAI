import { base44ORM as base44 } from "./src/db/orm.ts";
import { client } from "./src/db/index.ts";
try {
  await base44.entities.CallLog.filter({ call_sid: undefined });
  console.log("Success");
} catch(e) {
  console.error("Error:", e);
}
client.end();
