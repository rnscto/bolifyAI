const { sign } = require("jsonwebtoken");
const fetch = require("node-fetch");

async function run() {
  const token = sign({ id: "1", email: "test@test.com", client_id: "client1", role: "master_reseller" }, "your_super_secret_jwt_key_here");
  const res = await fetch("http://localhost:8000/api/reseller/custom-domain", {
    headers: { Authorization: "Bearer " + token }
  });
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Body:", text);
}
run();
