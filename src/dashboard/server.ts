import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import {
  getArtifact,
  getEvents,
  getRun,
  getRunSummary,
  getSymptomSpec,
  listRuns,
  openLedger,
  type Ledger,
} from "../orchestrator/ledger.js";

/**
 * Reject non-empty, unparseable request bodies with 400 — never 5xx.
 * Scoped to the run subtree so unknown routes keep their pinned 404
 * even when they carry a malformed body; empty bodies (plain GETs) pass.
 */
const requireJsonBody: MiddlewareHandler = async (c, next) => {
  const body = await c.req.text();
  if (body.length > 0) {
    try {
      JSON.parse(body) as unknown;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
  }
  await next();
};

/** Build the dashboard app over an open ledger (routes stay read-only). */
export function createApp(db: Ledger): Hono {
  const app = new Hono();

  // PRD pins unknown routes to Hono's default 404 — no error middleware
  // that could turn 404s into 5xx.
  app.use("/api/runs/:id", requireJsonBody);
  app.use("/api/runs/:id/*", requireJsonBody);

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/api/runs", (c) => c.json(listRuns(db)));

  app.get("/api/runs/:id", (c) => {
    const run = getRun(db, Number(c.req.param("id")));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json({
      ...run,
      symptom_spec: getSymptomSpec(db, run.id),
      summary: getRunSummary(db, run.id),
    });
  });

  app.get("/api/runs/:id/events", (c) => {
    const run = getRun(db, Number(c.req.param("id")));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json(getEvents(db, run.id));
  });

  app.get("/api/runs/:id/artifacts/:name", (c) => {
    const run = getRun(db, Number(c.req.param("id")));
    if (!run) return c.json({ error: "run not found" }, 404);
    const artifact = getArtifact(db, run.id, c.req.param("name"));
    if (!artifact) return c.json({ error: "artifact not found" }, 404);
    return c.text(artifact.content);
  });

  return app;
}

/** Dashboard port: process.env.PORT when a positive integer, else 8080. */
export function getPort(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8080;
}

/** Run serve() only when this module is the process entry, so tests can import the app. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const app = createApp(openLedger());
  const server = serve({ fetch: app.fetch, port: getPort() });
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
