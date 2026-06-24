const token = "0f0e334e-2e1d-4607-a4c3-e2f0a4a50367";
const url = "https://api-smartflo.tatateleservices.com/v1/click_to_call";
const payload = {
  agent_number: "918064520005",
  destination_number: "7020609101",
  async: 1
};

const formats = [
  `Bearer ${token}`,
  token,
  `Token ${token}`,
  `Basic ${btoa(token + ":")}`,
  `Basic ${btoa(":" + token)}`
];

for (const auth of formats) {
  console.log(`Testing format: ${auth}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "accept": "application/json",
      "Authorization": auth
    },
    body: JSON.stringify(payload)
  });
  console.log(await res.text());
  console.log("------------------------");
}
