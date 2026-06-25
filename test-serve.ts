export default {
  port: 8000,
  hostname: "0.0.0.0",
  fetch(req: Request) {
    return new Response("Hello!");
  }
}
