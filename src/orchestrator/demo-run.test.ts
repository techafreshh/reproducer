/**
 * Scripted demo runner: the whole engine on fixtures/demo-1 with zero API
 * keys — triage freeze, canned research, real-python gate grading, shrink to
 * a bounded minimal repro, and artifact submit ending in `reproduced`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("runScriptedDemo issue-14 report contract", () => {
  const ROW_RE = /^\| [^|]+ \| (reproduced|not-reproduced|inconclusive) \|$/;

  function bisectRowsOf(findings: string): string[] {
    return findings
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.includes("---") && line !== "| version | verdict |");
  }

  function tempFixtureDir(planOverride: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "reproducer-issue14-"));
    writeFileSync(join(dir, "issue.json"), readFileSync(join(FIXTURE_DIR, "issue.json"), "utf8"));
    writeFileSync(join(dir, "tavily.json"), readFileSync(join(FIXTURE_DIR, "tavily.json"), "utf8"));
    const base = JSON.parse(readFileSync(join(FIXTURE_DIR, "plan.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ ...base, ...planOverride }));
    return dir;
  }

  it("writes findings.md with Research, Bisect, Environment, and a citation url", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-demo-")), "ledger.db");
    runScriptedDemo(ISSUE_URL, FIXTURE_DIR, dbPath);
    const db = openLedger(dbPath);
    try {
      const findings = getArtifact(db, 1, "findings.md")?.content ?? "";
      expect(findings).toContain("## Research");
      expect(findings).toContain("## Bisect");
      expect(findings).toContain("## Environment");
      expect(findings).toContain("https://");
      expect(findings).toMatch(/verdict: (known-bug-fixed-later|likely-regression|likely-misconfiguration)/);
      const rows = bisectRowsOf(findings);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatch(ROW_RE);
    } finally {
      db.close();
    }
  });

  it("stored repro.py is standalone: shebang, install guard, no harness import", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-demo-")), "ledger.db");
    runScriptedDemo(ISSUE_URL, FIXTURE_DIR, dbPath);
    const db = openLedger(dbPath);
    let repro = "";
    try {
      repro = getArtifact(db, 1, "repro.py")?.content ?? "";
    } finally {
      db.close();
    }
    expect(repro).toContain("#!/usr/bin/env python3");
    expect(repro).toContain("pip install");
    expect(repro).not.toContain("reproducer");
    const result = executePythonScript(repro);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ValueError");
  });

  it("oversized minimal stays inconclusive but still writes both artifacts with the honest header", () => {
    const base = JSON.parse(readFileSync(join(FIXTURE_DIR, "plan.json"), "utf8")) as {
      minimalRepro: string;
    };
    const filler = Array.from({ length: 25 }, (_, i) => `filler_${i} = ${i}`).join("\n");
    const dir = tempFixtureDir({ minimalRepro: `${filler}\n${base.minimalRepro}` });
    const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-demo-")), "ledger.db");
    const { verdict } = runScriptedDemo(ISSUE_URL, dir, dbPath);
    expect(verdict).toBe("inconclusive");
    const db = openLedger(dbPath);
    try {
      expect(getRun(db, 1)?.status).toBe("inconclusive");
      const repro = getArtifact(db, 1, "repro.py")?.content ?? "";
      expect(repro.startsWith("# INCONCLUSIVE \u2014 best evidence attached")).toBe(true);
      expect(repro).not.toContain("reproducer");
      const findings = getArtifact(db, 1, "findings.md")?.content ?? "";
      expect(findings).toContain("## Research");
      expect(findings).toContain("## Bisect");
      expect(findings).toContain("## Environment");
    } finally {
      db.close();
    }
  });

  it("ungradable scripts stay inconclusive with the honest header and never mark reproduced", () => {
    const dir = tempFixtureDir({
      reproCandidate: 'print("ok")\n',
      minimalRepro: 'print("ok")\n',
    });
    const dbPath = join(mkdtempSync(join(tmpdir(), "reproducer-demo-")), "ledger.db");
    const { verdict } = runScriptedDemo(ISSUE_URL, dir, dbPath);
    expect(verdict).toBe("inconclusive");
    const db = openLedger(dbPath);
    try {
      expect(getRun(db, 1)?.status).toBe("inconclusive");
      expect(getRun(db, 1)?.verdict).toBe("inconclusive");
      const repro = getArtifact(db, 1, "repro.py")?.content ?? "";
      expect(repro.startsWith("# INCONCLUSIVE \u2014 best evidence attached")).toBe(true);
      expect(repro).not.toContain("reproducer");
      expect(getArtifact(db, 1, "findings.md")?.content).toContain("## Bisect");
    } finally {
      db.close();
    }
  });
});
