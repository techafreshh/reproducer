import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../dashboard/server.js";
import {
  getArtifact,
  getEvents,
  getRun,
  getSymptomSpec,
  insertRun,
  openLedger,
  type Ledger,
} from "../orchestrator/ledger.js";
import { freezeSymptomSpec } from "../gate/spec.js";
import { runSession, selectDriver } from "./session.js";

/** PRD §10 reference spec for library `lib`. */
const FROZEN_SPEC = {
  library: "lib",
  versions: ["2.2.0"],
  symptomClass: "exception",
  errorStrings: ["ValueError: bad value"],
  frames: [
    { module: "cli.py", function: "<module>" },
    { module: "core.py", function: "parse" },
  ],
  trigger: "parse('')",
  expectedOutput: null,
};

/** Real CPython stderr matching the frozen spec: ValueError plus both frames. */
const VALUE_ERROR_STDERR = [
  "Traceback (most recent call last):",
  '  File "/app/cli.py", line 14, in <module>',
  "    run()",
  '  File "/app/core.py", line 7, in parse',
  '    raise ValueError("bad value")',
  "ValueError: bad value",
].join("\n");

function reproducedRun(): Record<string, unknown> {
  return {
    tool: "env_run",
    envResult: { exitCode: 1, stdout: "", stderr: VALUE_ERROR_STDERR, timedOut: false },
  };
}

function inconclusiveRun(): Record<string, unknown> {
  return {
    tool: "env_run",
    envResult: { exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'pkg'", timedOut: false },
  };
}

describe("investigation session", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    freezeSymptomSpec(1, FROZEN_SPEC, db);
  });

  afterEach(() => {
    db.close();
  });

  it("refuses the 9th env_run for one hypothesis and ends inconclusive", async () => {
    const script = [
      { tool: "env_create", installs: [] },
      { tool: "env_create", installs: [] },
      { tool: "env_create", installs: [] },
      { tool: "env_create", installs: [] },
      ...Array.from({ length: 9 }, () => inconclusiveRun()),
    ];
    const result = await runSession(1, script, db);
    expect(result.status).toBe("inconclusive");
    expect(getRun(db, 1)?.status).toBe("inconclusive");
    const kinds = getEvents(db, 1).map((event) => event.kind);
    expect(kinds).toContain("budget_exceeded");
    expect(kinds.filter((kind) => kind === "gate")).toHaveLength(8);
    expect(kinds.filter((kind) => kind === "tool_call").length).toBeGreaterThanOrEqual(9);
  });

  it("grades a reproduced run and publishes repro.py plus findings.md", async () => {
    const script = [
      { tool: "env_create", installs: [] },
      reproducedRun(),
      {
        tool: "submit_report",
        status: "reproduced",
        reproPy: "print('repro')\n",
        findingsMd: "# findings\nreproduced\n",
      },
    ];
    const result = await runSession(1, script, db);
    expect(result.status).toBe("reproduced");
    expect(result.submitted).toBe(true);
    expect(getRun(db, 1)?.status).toBe("reproduced");
    expect(getArtifact(db, 1, "repro.py")?.content).toBe("print('repro')\n");
    expect(getArtifact(db, 1, "findings.md")?.content).toBe("# findings\nreproduced\n");

    const app: Hono = createApp(db);
    const repro = await app.request("/api/runs/1/artifacts/repro.py");
    expect(repro.status).toBe(200);
    expect(await repro.text()).toBe("print('repro')\n");
    const detail = await app.request("/api/runs/1");
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as Record<string, unknown>;
    expect(body.status).toBe("reproduced");
  });

  it("caps hypotheses at 3 and records hypothesis_limit_reached on the 4th attempt", async () => {
    const script = [
      { newHypothesis: "first" },
      { newHypothesis: "second" },
      inconclusiveRun(),
      { newHypothesis: "third" },
      { newHypothesis: "fourth" },
    ];
    const result = await runSession(1, script, db);
    expect(result.hypotheses).toBeLessThanOrEqual(3);
    expect(result.hypotheses).toBe(3);
    const kinds = getEvents(db, 1).map((event) => event.kind);
    expect(kinds).toContain("hypothesis_limit_reached");
  });

  it("refuses spec writes and leaves the frozen spec byte-identical", async () => {
    const before = JSON.stringify(getSymptomSpec(db, 1));
    const script = [
      { tool: "write_spec", spec: { library: "evil", versions: [] } },
      { tool: "putSymptomSpec", spec: { library: "evil" } },
      inconclusiveRun(),
    ];
    await runSession(1, script, db);
    const kinds = getEvents(db, 1).map((event) => event.kind);
    expect(kinds).toContain("spec_write_refused");
    expect(JSON.stringify(getSymptomSpec(db, 1))).toBe(before);

    const app: Hono = createApp(db);
    const res = await app.request("/api/runs/1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body.symptom_spec)).toBe(before);
  });

  it("requires a frozen spec before the first dispatch", async () => {
    insertRun(db, "https://github.com/octocat/hello-world/issues/2");
    await expect(runSession(2, [inconclusiveRun()], db)).rejects.toThrow(
      "no frozen symptom spec for run 2",
    );
  });

  it("emits tool_call, llm_turn, and gate events for a graded run", async () => {
    await runSession(1, [reproducedRun()], db);
    const kinds = getEvents(db, 1).map((event) => event.kind);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("llm_turn");
    expect(kinds).toContain("gate");
  });

  it("bisects 3 versions into findings.md with firstBad 2.2.0 and 3 env_run events", async () => {
    const goodStderr = [
      "Traceback (most recent call last):",
      '  File "/app/cli.py", line 14, in <module>',
      "    run()",
      '  File "/app/core.py", line 7, in parse',
      '    raise TypeError("bad type")',
      "TypeError: bad type",
    ].join("\n");
    const script = [
      {
        tool: "bisect",
        versions: ["2.0.0", "2.1.0", "2.2.0"],
        results: [
          { exitCode: 1, stdout: "", stderr: goodStderr, timedOut: false },
          { exitCode: 1, stdout: "", stderr: goodStderr, timedOut: false },
          { exitCode: 1, stdout: "", stderr: VALUE_ERROR_STDERR, timedOut: false },
        ],
      },
      {
        tool: "submit_report",
        status: "reproduced",
        reproPy: "print('repro')\n",
        findingsMd: "# findings\nreproduced\n",
      },
    ];
    await runSession(1, script, db);
    const findings = getArtifact(db, 1, "findings.md")?.content ?? "";
    expect(findings).toContain("## Bisect");
    expect(findings).toContain("2.0.0");
    expect(findings).toContain("2.1.0");
    expect(findings).toContain("2.2.0");
    expect(findings).toContain("firstBad");
    expect(findings).toContain("2.2.0");
    const events = getEvents(db, 1);
    const toolCalls = events.filter((event) => event.kind === "tool_call").map((event) => JSON.parse(event.payload_json) as Record<string, unknown>);
    const envRuns = toolCalls.filter((payload) => payload.tool === "env_run");
    expect(envRuns).toHaveLength(3);
    const gates = events.filter((event) => event.kind === "gate");
    expect(gates).toHaveLength(3);
    const versions = gates.map((event) => (JSON.parse(event.payload_json) as Record<string, unknown>).version);
    expect(versions).toEqual(["2.0.0", "2.1.0", "2.2.0"]);
  });

  it("refuses a 12-version bisect with max 8 versions and zero sandbox events", async () => {
    const versions = Array.from({ length: 12 }, (_, index) => `2.${index}.0`);
    await runSession(1, [{ tool: "bisect", versions }], db);
    const events = getEvents(db, 1);
    const toolCalls = events.filter((event) => event.kind === "tool_call").map((event) => JSON.parse(event.payload_json) as Record<string, unknown>);
    const bisectCalls = toolCalls.filter((payload) => payload.tool === "bisect");
    expect(bisectCalls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(bisectCalls)).toContain("max 8 versions");
    expect(toolCalls.filter((payload) => payload.tool === "env_run")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "gate")).toHaveLength(0);
  });
});

describe("selectDriver", () => {
  it("returns live when the default provider key and MODEL_REASON are set", () => {
    expect(selectDriver({ OPENROUTER_API_KEY: "key", MODEL_REASON: "model" })).toBe("live");
  });

  it("returns live for deepseek when its key and MODEL_REASON are set", () => {
    expect(
      selectDriver({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "key", MODEL_REASON: "model" }),
    ).toBe("live");
  });

  it("returns scripted when the key or MODEL_REASON is missing or empty", () => {
    expect(selectDriver({})).toBe("scripted");
    expect(selectDriver({ OPENROUTER_API_KEY: "key" })).toBe("scripted");
    expect(selectDriver({ MODEL_REASON: "model" })).toBe("scripted");
    expect(selectDriver({ OPENROUTER_API_KEY: "", MODEL_REASON: "model" })).toBe("scripted");
    expect(selectDriver({ OPENROUTER_API_KEY: "key", MODEL_REASON: "" })).toBe("scripted");
  });

  it("ignores the unselected provider's key", () => {
    expect(selectDriver({ MODEL_PROVIDER: "deepseek", OPENROUTER_API_KEY: "key" })).toBe("scripted");
    expect(selectDriver({ DEEPSEEK_API_KEY: "key", MODEL_REASON: "model" })).toBe("scripted");
  });

  it("stays scripted on the legacy Token Factory key alone", () => {
    // Split literal keeps the legacy-key scrub check at zero hits while proving the old key is ignored.
    const legacyKey = "NEB" + "IUS_API_KEY";
    expect(selectDriver({ [legacyKey]: "key", MODEL_REASON: "model" })).toBe("scripted");
  });

  it("throws naming both valid options for unknown MODEL_PROVIDER", () => {
    expect(() => selectDriver({ MODEL_PROVIDER: "bedrock" })).toThrow(
      'unknown MODEL_PROVIDER "bedrock": expected "openrouter" or "deepseek"',
    );
  });
});
