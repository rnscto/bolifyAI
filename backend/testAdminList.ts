import adminListClients from "./src/functions/adminListClients.ts";
import { client } from "./src/db/index.ts";
const c = {
  req: {
    json: async () => ({ action: 'list' })
  },
  json: (data: any, status = 200) => {
    console.log("Status:", status);
    console.log("Data:", JSON.stringify(data, null, 2));
    return data;
  }
};
await adminListClients(c);
client.end();
