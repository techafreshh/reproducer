import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";

export const app = new Hono();

// Walking-skeleton seam only: PRD pins unknown routes to Hono's default 404 —
// no error middleware that could turn 404s into 5xx.
app.get("/healthz", (c) => c.json({ ok: true }));

/** Dashboard port: process.env.PORT when a positive integer, else 8080. */
export function getPort(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8080;
}

/** Run serve() only when this module is the process entry, so tests can import the app. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = serve({ fetch: app.fetch, port: getPort() });
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
