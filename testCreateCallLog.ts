import { base44ORM } from "./backend/src/db/orm.ts";
import { connectDB } from "./backend/src/db/index.ts";

async function run() {
  await connectDB();
  try {
    const callLog = await base44ORM.entities.CallLog.create({
      client_id: "2d2cbc5b-191a-4b3a-9b99-14f210c13e2d",
      lead_id: "e0388481-229d-429f-a2e6-c116c9688b1f",
      agent_id: "e7ef0b0e-9218-4263-b9fc-000a4764c90b",
      status: "initiated",
      duration: 0,
      caller_id: "test",
      callee_number: "test",
      call_sid: "test",
      direction: 'outbound',
      call_start_time: new Date().toISOString(),
      agent_config_cache: {
        agent_name: "Test"
      }
    });
    console.log("Success", callLog.id);
  } catch (error) {
    console.error("Error:", error);
  }
  Deno.exit(0);
}
run();
