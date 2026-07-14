import { createHabitatApp } from "./routes";

const host = Bun.env.HABITAT_API_HOST ?? "0.0.0.0";
const port = Number(Bun.env.HABITAT_API_PORT ?? "8787");
const app = createHabitatApp();

console.log(`[habitat-api] listening on http://${host}:${port}`);

Bun.serve({
  port,
  hostname: host,
  fetch: app.fetch,
});
