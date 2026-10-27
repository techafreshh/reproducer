import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

/** Allowlisted dashboard static files with their exact content types. */
const STATIC_FILES: Record<string, string> = {
  "app.js": "application/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  "index.html": "text/html; charset=utf-8",
};

/**
 * Resolve the dashboard public dir: relative to this module file so both
 * `tsx src/dashboard/server.ts` and compiled `dist/dashboard/server.js`
 * find it (compiled output falls back to the `src` tree when `dist` has no
 * copied assets). Never throws — missing dirs read as absent files (404).
 */
function resolvePublicDir(): string {
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "public"));
  } catch {
    // ignore: fall through to cwd-relative candidates
  }
  candidates.push(join(process.cwd(), "src", "dashboard", "public"));
  for (const dir of candidates) {
    try {
      if (existsSync(dir)) return dir;
    } catch {
      continue;
    }
  }
  return candidates[0] as string;
}

/** Read a public file by name; null when allowlisted-but-absent or not allowlisted. */
function readPublicFile(name: string): { content: string; contentType: string } | null {
  const contentType = STATIC_FILES[name];
  if (contentType === undefined) return null;
  try {
    const content = readFileSync(join(resolvePublicDir(), name), "utf-8");
    return { content, contentType };
  } catch {
    return null;
  }
}

/** Build the dashboard app over an open ledger (routes stay read-only). */
export function createApp(db: Ledger): Hono {
  const app = new Hono();

  // PRD pins unknown routes to Hono's default 404 — no error middleware
  // that could turn 404s into 5xx.
  app.use("/api/runs/:id", requireJsonBody);
  app.use("/api/runs/:id/*", requireJsonBody);

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/", (c) => {
    const file = readPublicFile("index.html");
    if (file === null) return c.text("not found", 404);
    return c.body(file.content, 200, { "content-type": file.contentType });
  });

  app.get("/static/:name", (c) => {
    const file = readPublicFile(c.req.param("name"));
    if (file === null) return c.text("not found", 404);
    return c.body(file.content, 200, { "content-type": file.contentType });
  });

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
