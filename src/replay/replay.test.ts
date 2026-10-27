/**
 * Replay mode: hash-keyed fixture loading, env-toggle parsing, and the full
 * `runReplay` pipeline on each bundled demo fixture.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveResearchQueries } from "../agent/triage.js";
import { validateSymptomSpec } from "../gate/spec.js";
import { getArtifact, getRun, openLedger } from "../orchestrator/ledger.js";
import {
  DEFAULT_REPLAY_DIR,
  FixturesClient,
  fixtureHash,
  isReplayEnabled,
  resolveFixtureDir,
} from "./fixtures.js";
import { enrichEnvRuns, runReplay } from "./run.js";
import { executePythonScript } from "./exec.js";

const BUNDLES = ["demo-1", "demo-2", "demo-3"] as const;

function expectedOf(bundle: string): { url: string; expectedStatus: string } {
  return JSON.parse(readFileSync(join("fixtures", bundle, "expected.json"), "utf8")) as {
    url: string;
    expectedStatus: string;
  };
}

describe("FixturesClient missing-fixture sentinel", () => {
  it("throws basename-only `missing fixture: issue.json` for an empty dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reproducer-replay-empty-"));
    const client = new FixturesClient(dir);
    await expect(client.githubGetIssue("https://github.com/demo/ducklings/issues/1")).rejects.toThrow(
      "missing fixture: issue.json",
    );
  });

  it("loads `tavily/<sha256(query)>.json` keyed by the raw query", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reproducer-replay-tavily-"));
    const query = "ducklings ValueError hatch";
    mkdirSync(join(dir, "tavily"), { recursive: true });
    writeFileSync(
      join(dir, "tavily", `${fixtureHash(query)}.json`),
      JSON.stringify({
        results: [{ title: "t", url: "https://example.com/t", content: "hatch crashes" }],
      }),
    );
    const response = await new FixturesClient(dir).tavilySearch(query);
    expect(response.results.map((entry) => entry.url)).toContain("https://example.com/t");
  });

  it("falls back to the legacy `tavily.json` bundle when no hash file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reproducer-replay-legacy-"));
    const query = "ducklings ValueError hatch";
    writeFileSync(
      join(dir, "tavily.json"),
      JSON.stringify({ searches: [{ query, results: [{ url: "https://example.com/legacy" }] }] }),
    );
    const response = await new FixturesClient(dir).tavilySearch(query);
    expect(response.results.map((entry) => entry.url)).toContain("https://example.com/legacy");
  });

  it("throws a basename-only sentinel when neither hash nor legacy Tavily exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reproducer-replay-notavily-"));
    await expect(new FixturesClient(dir).tavilySearch("some query")).rejects.toThrow(/missing fixture: [0-9a-f]+\.json/);
  });
});

describe("replay env toggle", () => {
  it("recognizes 1/true/yes case-insensitively and rejects everything else", () => {
    expect(isReplayEnabled({ REPLAY: "1" })).toBe(true);
    expect(isReplayEnabled({ REPLAY: "true" })).toBe(true);
    expect(isReplayEnabled({ REPLAY: "TRUE" })).toBe(true);
    expect(isReplayEnabled({ REPLAY: "yes" })).toBe(true);
    expect(isReplayEnabled({ REPLAY: "Yes" })).toBe(true);
    expect(isReplayEnabled({})).toBe(false);
    expect(isReplayEnabled({ REPLAY: "" })).toBe(false);
    expect(isReplayEnabled({ REPLAY: "0" })).toBe(false);
    expect(isReplayEnabled({ REPLAY: "false" })).toBe(false);
    expect(isReplayEnabled({ REPLAY: "no" })).toBe(false);
  });

  it("resolves the flag dir first, then the REPLAY default, then off", () => {
    expect(DEFAULT_REPLAY_DIR).toBe("fixtures/demo-1");
    expect(resolveFixtureDir("fixtures/demo-2", { REPLAY: "1" })).toBe("fixtures/demo-2");
    expect(resolveFixtureDir(undefined, { REPLAY: "1" })).toBe("fixtures/demo-1");
    expect(resolveFixtureDir(undefined, {})).toBeUndefined();
  });
});

describe("enrichEnvRuns", () => {
  it("executes script-only env_run steps and leaves canned steps alone", () => {
    const steps = enrichEnvRuns([
      { tool: "env_run", script: 'print("hello")\n' },
      { tool: "env_run", envResult: { exitCode: 0, stdout: "canned", stderr: "", timedOut: false } },
      { tool: "tavily_search", query: "q" },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({
      envResult: { exitCode: 0, stdout: "hello\n", timedOut: false },
    });
    expect(steps[1]).toMatchObject({ envResult: { exitCode: 0, stdout: "canned" } });
    expect(steps[2]).not.toHaveProperty("envResult");
  });
});

describe("runReplay per bundle", () => {
  for (const bundle of BUNDLES) {
    it(`${bundle} ends with its expected.json status and both artifacts`, async () => {
      const { url, expectedStatus } = expectedOf(bundle);
      const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-replay-")), "ledger.db");
      const { runId, status } = await runReplay(url, join("fixtures", bundle), dbPath);
      expect(runId).toBe(1);
      expect(status).toBe(expectedStatus);

      const db = openLedger(dbPath);
      try {
        expect(getRun(db, 1)?.status).toBe(expectedStatus);
        const repro = getArtifact(db, 1, "repro.py");
        expect(repro?.content).toContain("python3");
        const findings = getArtifact(db, 1, "findings.md");
        expect(findings?.content).toContain(expectedStatus);
        expect(findings?.content).toContain("## Research");
        // The stored artifact must stand alone: execute it with the shared
        // python executor and prove the pinned symptom behavior.
        const executed = executePythonScript(repro?.content ?? "", bundle === "demo-3" ? 2000 : 15000);
        if (bundle === "demo-1") {
          expect(executed.exitCode).not.toBe(0);
          expect(executed.stderr).toContain("ValueError");
        } else if (bundle === "demo-2") {
          expect(executed.exitCode).not.toBe(0);
          expect(executed.stderr).toContain("AssertionError");
        } else {
          expect(executed.timedOut).toBe(true);
        }
        // Citation-backed report with a two-row version boundary.
        expect(findings?.content).toMatch(/https:\/\//);
        const bisectSection = (findings?.content ?? "").split("## Bisect")[1] ?? "";
        const dataRows = bisectSection
          .split("\n")
          .map((line) => line.trim())
          .filter(
            (line) =>
              /^\|[^|]+\|[^|]+\|$/.test(line) && !line.includes("---") && !/version/i.test(line),
          );
        expect(dataRows.length).toBeGreaterThanOrEqual(2);
      } finally {
        db.close();
      }
    }, 60000);
  }

  it("replays the legacy plan.json bundle identically to its fixture queries", async () => {
    const dir = "fixtures/demo-1";
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as { symptomSpec: unknown };
    const spec = validateSymptomSpec(plan.symptomSpec);
    const queries = deriveResearchQueries(spec);
    const client = new FixturesClient(dir);
    for (const query of queries) {
      const response = await client.tavilySearch(query);
      expect(response.results.length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown issue URL with `invalid issue url`", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-replay-")), "ledger.db");
    await expect(runReplay("not-a-url", "fixtures/demo-1", dbPath)).rejects.toThrow("invalid issue url");
  });

  it("rejects a fixture dir without issue.json with the basename sentinel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reproducer-replay-noissue-"));
    const dbPath = join(dir, "ledger.db");
    await expect(
      runReplay("https://github.com/demo/ducklings/issues/1", dir, dbPath),
    ).rejects.toThrow("missing fixture: issue.json");
  });
});
