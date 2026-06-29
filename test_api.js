import { fetch } from 'undici';

async function test() {
  const res = await fetch("http://localhost:8000/api/v1/client-lifecycle-events?sort=-created_at&limit=10000", {
    headers: {
      "Authorization": "Bearer TEST_TOKEN"
    }
  });
  console.log(res.status, await res.text());
}
test();
