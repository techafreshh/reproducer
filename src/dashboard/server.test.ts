import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { runSession } from "../agent/session.js";
import { freezeSymptomSpec } from "../gate/spec.js";
import {
  appendEvent,
  insertRun,
  openLedger,
  putArtifact,
  putSymptomSpec,
  type Ledger,
} from "../orchestrator/ledger.js";
import { createApp, getPort } from "./server.js";

/** PRD §10 reference spec (issue #4): frozen via the gate, served at `symptom_spec`. */
const FROZEN_SPEC = {
  library: "lib",
  versions: ["2.2.0"],
  symptomClass: "exception",
  errorStrings: ["boom"],
  frames: [{ module: "lib/core.js", function: "parse" }],
  trigger: "parse('')",
  expectedOutput: null,
};

describe("dashboard app", () => {
  let db: Ledger;
  let app: Hono;

  beforeEach(() => {
    db = openLedger(":memory:");
    app = createApp(db);
  });

  afterEach(() => {
    db.close();
  });

  it("serves GET /healthz with 200 and the exact body {\"ok\":true}", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("returns 404 for unknown routes (PRD status-code contract)", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });

  it("returns 200 with an empty array for GET /api/runs on a fresh ledger", async () => {
    const res = await app.request("/api/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("renders a run with exactly the six contract fields", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    const res = await app.request("/api/runs");
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0] ?? {}).sort()).toEqual([
      "budget",
      "created_at",
      "id",
      "issue_url",
      "status",
      "verdict",
    ]);
    expect(runs[0]).toMatchObject({
      id: 1,
      issue_url: "https://github.com/octocat/hello-world/issues/1",
      status: "created",
      verdict: null,
      budget: null,
    });
    expect(typeof runs[0]?.created_at).toBe("string");
  });

  it("serves run detail with null spec and empty summary when bare", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    const res = await app.request("/api/runs/1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issue_url).toBe("https://github.com/octocat/hello-world/issues/1");
    expect(body.verdict).toBeNull();
    expect(body.budget).toBeNull();
    expect(body.symptom_spec).toBeNull();
    expect(body.summary).toEqual({ events: 0, artifacts: [] });
  });

  it("serves run detail with spec and summary when populated", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    appendEvent(db, 1, "gate", { verdict: "reproduced" });
    putArtifact(db, 1, "repro.py", "print('hi')");
    putSymptomSpec(db, 1, { symptom: "crash on save" });
    const res = await app.request("/api/runs/1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.symptom_spec).toEqual({ symptom: "crash on save" });
    expect(body.summary).toEqual({ events: 1, artifacts: ["repro.py"] });
  });

  it("serves the frozen spec at symptom_spec after freezeSymptomSpec (issue #4)", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    freezeSymptomSpec(1, FROZEN_SPEC, db);
    const res = await app.request("/api/runs/1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.symptom_spec).toEqual({ ...FROZEN_SPEC, minMatchingFrames: 2 });
  });

  it("returns exactly 404 for unknown and non-integer run ids", async () => {
    expect((await app.request("/api/runs/999")).status).toBe(404);
    expect((await app.request("/api/runs/abc")).status).toBe(404);
  });

  it("serves ordered events with exactly the six contract fields", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    appendEvent(db, 1, "note", { step: "clone" });
    appendEvent(db, 1, "gate", { verdict: "reproduced" });
    const res = await app.request("/api/runs/1/events");
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual([
      "created_at",
      "id",
      "kind",
      "payload_json",
      "run_id",
      "seq",
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]?.payload_json).toBe('{"step":"clone"}');
    expect(events.map((e) => e.run_id)).toEqual([1, 1]);
  });

  it("serves one appended event with seq 1 (acceptance scenario)", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    appendEvent(db, 1, "note", {});
    const res = await app.request("/api/runs/1/events");
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<{ seq: number }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
  });

  it("returns 404 for events of an unknown run", async () => {
    expect((await app.request("/api/runs/999/events")).status).toBe(404);
  });

  it("serves stored artifacts as text with verbatim bodies", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    putArtifact(db, 1, "repro.py", "print('hi')\n");
    putArtifact(db, 1, "findings.md", "# findings\nnothing sprayed\n");
    const res = await app.request("/api/runs/1/artifacts/repro.py");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.startsWith("text/plain")).toBe(true);
    expect(await res.text()).toBe("print('hi')\n");
    const findings = await app.request("/api/runs/1/artifacts/findings.md");
    expect(await findings.text()).toBe("# findings\nnothing sprayed\n");
  });

  it("returns 404 for unknown artifact names and unknown runs", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    putArtifact(db, 1, "repro.py", "print('hi')");
    expect((await app.request("/api/runs/1/artifacts/nope.md")).status).toBe(404);
    expect((await app.request("/api/runs/999/artifacts/repro.py")).status).toBe(404);
  });

  it("returns 400 with a JSON error body for a malformed body on a run path", async () => {
    const res = await app.request("/api/runs/1", { method: "PUT", body: "{bad json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  it("returns 400 for a POST with a malformed body on a run path", async () => {
    const res = await app.request("/api/runs/1", { method: "POST", body: "{bad json" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a valid-JSON PUT — the read API has no write endpoints", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    const res = await app.request("/api/runs/1", { method: "PUT", body: '{"verdict":"reproduced"}' });
    expect(res.status).toBe(404);
  });

  it("keeps unknown /api routes 404 even with a malformed body", async () => {
    expect((await app.request("/api/definitely/not/here")).status).toBe(404);
    const res = await app.request("/api/definitely/not/here", { method: "PUT", body: "{bad json" });
    expect(res.status).toBe(404);
  });

  it("serves the dashboard root with the runs list and the app.js script tag", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("runs list");
    expect(body).toContain("<script");
    expect(body).toContain("/static/app.js");
  });

  it("serves app.js as javascript and style.css as css, 404 otherwise", async () => {
    const js = await app.request("/static/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("application/javascript");
    const css = await app.request("/static/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await app.request("/static/nope.js")).status).toBe(404);
  });

  it("persists the enriched env_run tool_call payload the timeline consumes", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    freezeSymptomSpec(1, FROZEN_SPEC, db);
    await runSession(
      1,
      [{ tool: "env_run", cmd: "python repro.py", stdout: "hello", stderr: "boom" }],
      db,
    );
    const res = await app.request("/api/runs/1/events");
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.kind).toBeDefined();
      expect(event.seq).toBeDefined();
    }
    const toolCall = events.find((event) => event.kind === "tool_call");
    expect(toolCall).toBeDefined();
    const payload = JSON.parse(toolCall?.payload_json as string) as Record<string, unknown>;
    expect(payload.tool).toBe("env_run");
    expect(payload.cmd).toBe("python repro.py");
    expect(payload.stdout).toBe("hello");
    expect(payload.stderr).toBe("boom");
    expect(typeof payload.verdict).toBe("string");
    expect(typeof toolCall?.seq).toBe("number");
  });

  it("round-trips sanitize_flag events with their flag text for system notes", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    appendEvent(db, 1, "note", { step: "triage" });
    appendEvent(db, 1, "sanitize_flag", { flags: ["prompt:ignore-previous"], source: "issue" });
    appendEvent(db, 1, "gate", { verdict: "inconclusive" });
    const res = await app.request("/api/runs/1/events");
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(3);
    const flagged = events.find((event) => event.kind === "sanitize_flag");
    expect(flagged).toBeDefined();
    expect(typeof flagged?.seq).toBe("number");
    expect(flagged?.payload_json as string).toContain("prompt:ignore-previous");
  });
});

describe("getPort", () => {
  it("defaults to 8080 and honors a valid PORT", () => {
    expect(getPort({})).toBe(8080);
    expect(getPort({ PORT: "3210" })).toBe(3210);
  });

  it("falls back to 8080 on missing, invalid, or non-positive PORT", () => {
    expect(getPort({ PORT: "" })).toBe(8080);
    expect(getPort({ PORT: "abc" })).toBe(8080);
    expect(getPort({ PORT: "0" })).toBe(8080);
    expect(getPort({ PORT: "-1" })).toBe(8080);
    expect(getPort({ PORT: "8080.5" })).toBe(8080);
  });
});
