import fetch from "node-fetch";

async function run() {
  const res = await fetch("http://localhost:8000/api/reseller/custom-domain-config");
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Body:", text);
}
run();
