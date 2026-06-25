import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.text("OK"));
const req = new Request("http://localhost/notfound", { method: "POST" });
const res = await app.fetch(req);
console.log(res.status);
