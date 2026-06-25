import { base44 } from "./src/api/base44Client.js";
async function run() {
  try {
    const res = await base44.functions.invoke('nonExistentFunction', {});
    console.log("Response:", res);
  } catch (err) {
    console.error("Error thrown:", err);
  }
}
run();
