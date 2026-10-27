/**
 * Scripted demo runner: the whole engine on fixtures/demo-1 with zero API
 * keys — triage freeze, canned research, real-python gate grading, shrink to
 * a bounded minimal repro, and artifact submit ending in `reproduced`.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateSymptomSpec } from "../gate/spec.js";
import {
  getArtifact,
  getRun,
  getSymptomSpec,
  isSymptomSpecFrozen,
  openLedger,
} from "./ledger.js";
import { executePythonScript, runScriptedDemo } from "./demo-run.js";

const FIXTURE_DIR = "fixtures/demo-1";
const ISSUE_URL = "https://github.com/demo/ducklings/issues/1";

function nonEmptyLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

describe("demo-1 fixture bundle", () => {
  it("parses and the canned symptom spec validates", () => {
    const issue = JSON.parse(readFileSync(join(FIXTURE_DIR, "issue.json"), "utf8")) as {
      title: string;
      body: string;
    };
    expect(typeof issue.title).toBe("string");
    expect(issue.body).toContain("ValueError");

    const tavily = JSON.parse(readFileSync(join(FIXTURE_DIR, "tavily.json"), "utf8")) as {
      searches: Array<{ results: Array<{ url: string }> }>;
    };
    expect(tavily.searches.length).toBeGreaterThan(0);
    expect(tavily.searches[0]?.results.length).toBeGreaterThanOrEqual(2);

    const plan = JSON.parse(readFileSync(join(FIXTURE_DIR, "plan.json"), "utf8")) as {
      symptomSpec: unknown;
      minimalRepro: string;
    };
    const spec = validateSymptomSpec(plan.symptomSpec);
    expect(spec.symptomClass).toBe("exception");
    expect(nonEmptyLines(plan.minimalRepro)).toBeLessThanOrEqual(20);
    expect(plan.minimalRepro).toContain("import");
  });
});

describe("runScriptedDemo", () => {
  it("yields reproduced with a frozen spec and bounded artifacts", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-demo-")), "ledger.db");
    const { runId, verdict } = runScriptedDemo(ISSUE_URL, FIXTURE_DIR, dbPath);
    expect(runId).toBe(1);
    expect(verdict).toBe("reproduced");

    const db = openLedger(dbPath);
    try {
      expect(getRun(db, 1)?.status).toBe("reproduced");
      expect(getRun(db, 1)?.verdict).toBe("reproduced");
      expect(isSymptomSpecFrozen(db, 1)).toBe(true);
      const spec = getSymptomSpec(db, 1) as { symptomClass: string } | null;
      expect(spec?.symptomClass).toBe("exception");

      const repro = getArtifact(db, 1, "repro.py");
      expect(repro?.content).toContain("import");
      expect(repro?.content.split("\n").length).toBeLessThanOrEqual(60);
      expect(nonEmptyLines(repro?.content ?? "")).toBeLessThanOrEqual(20);

      expect(getArtifact(db, 1, "findings.md")?.content).toContain("reproduced");
    } finally {
      db.close();
    }
  });

  it("stored repro.py executes nonzero with the spec's exception class", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-demo-")), "ledger.db");
    runScriptedDemo(ISSUE_URL, FIXTURE_DIR, dbPath);

    const db = openLedger(dbPath);
    let repro = "";
    try {
      repro = getArtifact(db, 1, "repro.py")?.content ?? "";
      expect(repro.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    const result = executePythonScript(repro);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ValueError");
  });

  it("throws a fixture error for a missing fixture dir", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-demo-")), "ledger.db");
    expect(() => runScriptedDemo(ISSUE_URL, join(tmpdir(), "reproducer-no-such-fixture"), dbPath)).toThrow(
      /missing fixture/,
    );
  });
});
