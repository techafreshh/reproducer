/**
 * Scripted end-to-end runner for fixtures/demo-1 (demo/ducklings#1).
 *
 * Keyless validation path: reads the canned issue, Tavily results, and plan
 * off disk, freezes the fixture's symptom spec via the existing latch,
 * executes the plan's repro candidate and minimal repro with the real
 * `python3` (each written to a temp file named `repro.py` so the graded
 * frames match the spec's pinned `repro.py` frames and the delivered
 * artifact's real crash path), grades both with the pure gate, shrinks to
 * the checked-in minimal script, and submits `repro.py` + `findings.md`.
 * No model, no network, no env secrets.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { gradeAgainstSpec, type EnvRunResult, type GateVerdict } from "../gate/gate.js";
import { freezeSymptomSpec, validateSymptomSpec, type SymptomSpec } from "../gate/spec.js";
import { parseIssueUrl } from "../issue-url.js";
import {
  appendEvent,
  insertRun,
  openLedger,
  putArtifact,
  setRunOutcome,
} from "./ledger.js";

/** Default fixture directory for a bare `--scripted` flag (relative to cwd). */
export const DEMO_FIXTURE_DIR = "fixtures/demo-1";

/** Hard timeout for each graded python execution. */
const PYTHON_TIMEOUT_MS = 60000;

/** Submitted `repro.py` must stay within this many total lines. */
const MAX_ARTIFACT_LINES = 60;

/** The shrink target: minimal repro must fit this many non-empty lines. */
const MAX_MINIMAL_NON_EMPTY_LINES = 20;

export interface ScriptedDemoResult {
  runId: number;
  verdict: GateVerdict;
}

interface DemoPlan {
  symptomSpec: unknown;
  reproCandidate: string;
  minimalRepro: string;
  findingsMd: string;
  bumpers: Array<{ kind: string; payload: unknown }>;
}

/** Read and parse a JSON fixture file; absent or unparseable reads fail loudly. */
function readFixtureJson(dir: string, name: string): unknown {
  const path = join(dir, name);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`missing fixture: ${path}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`missing fixture: ${path} is not valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Shape-check the canned plan; fixture-authoring bugs surface as fixture errors. */
function parseDemoPlan(raw: unknown, dir: string): DemoPlan {
  if (!isRecord(raw)) {
    throw new Error(`missing fixture: ${join(dir, "plan.json")} has no plan object`);
  }
  const { symptomSpec, reproCandidate, minimalRepro, findingsMd, bumpers } = raw;
  if (typeof reproCandidate !== "string" || reproCandidate.length === 0) {
    throw new Error(`missing fixture: ${join(dir, "plan.json")} has no reproCandidate script`);
  }
  if (typeof minimalRepro !== "string" || minimalRepro.length === 0) {
    throw new Error(`missing fixture: ${join(dir, "plan.json")} has no minimalRepro script`);
  }
  if (typeof findingsMd !== "string" || findingsMd.length === 0) {
    throw new Error(`missing fixture: ${join(dir, "plan.json")} has no findingsMd`);
  }
  const steps: Array<{ kind: string; payload: unknown }> = [];
  if (Array.isArray(bumpers)) {
    for (const bumper of bumpers) {
      if (isRecord(bumper) && typeof bumper.kind === "string") {
        steps.push({ kind: bumper.kind, payload: bumper.payload ?? null });
      }
    }
  }
  return { symptomSpec, reproCandidate, minimalRepro, findingsMd, bumpers: steps };
}

/** Lines carrying code or prose; blank lines never count toward the shrink budget. */
function countNonEmptyLines(script: string): number {
  let count = 0;
  for (const line of script.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
}

/** Drop blank lines and full-line `#` comments for the shrink fallback. */
function stripCommentsAndBlanks(script: string): string {
  return script
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    })
    .join("\n")
    .concat("\n");
}

/**
 * Run a repro script with the real `python3`, graded exactly like the
 * delivered artifact: written to a temp file named `repro.py` so the parsed
 * traceback frames carry the `repro.py` module basename the spec pins.
 */
export function executePythonScript(script: string): EnvRunResult {
  const dir = mkdtempSync(join(tmpdir(), "reproducer-demo-"));
  try {
    const file = join(dir, "repro.py");
    writeFileSync(file, script);
    const result = spawnSync("python3", [file], {
      encoding: "utf-8",
      timeout: PYTHON_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const code = (result.error as { code?: unknown } | undefined)?.code;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    return {
      exitCode: typeof result.status === "number" ? result.status : -1,
      stdout,
      stderr,
      timedOut: code === "ETIMEDOUT" || result.signal === "SIGKILL",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Drive the whole engine once on a scripted fixture: triage (freeze the
 * canned spec) → research (replay canned Tavily) → investigation (replay
 * canned bumpers) → repro loop (real-python grade of the candidate, then
 * the shrunk minimal) → submit `repro.py` + `findings.md`.
 */
export function runScriptedDemo(
  issueUrl: string,
  fixtureDir: string = DEMO_FIXTURE_DIR,
  dbPath?: string,
): ScriptedDemoResult {
  const issue = parseIssueUrl(issueUrl);
  const dir = isAbsolute(fixtureDir) ? fixtureDir : resolve(process.cwd(), fixtureDir);

  const cannedIssue = readFixtureJson(dir, "issue.json");
  const cannedTavily = readFixtureJson(dir, "tavily.json");
  const plan = parseDemoPlan(readFixtureJson(dir, "plan.json"), dir);
  const spec: SymptomSpec = validateSymptomSpec(plan.symptomSpec);

  const db = openLedger(dbPath);
  try {
    const runId = insertRun(db, issue.url);

    const issueTitle =
      isRecord(cannedIssue) && typeof cannedIssue.title === "string" ? cannedIssue.title : "";
    appendEvent(db, runId, "triage", { issueUrl: issue.url, title: issueTitle, library: spec.library });
    freezeSymptomSpec(runId, spec, db);

    appendEvent(db, runId, "research", { canned: cannedTavily });

    for (const bumper of plan.bumpers) {
      appendEvent(db, runId, bumper.kind, bumper.payload);
    }

    const candidateResult = executePythonScript(plan.reproCandidate);
    const candidateGrade = gradeAgainstSpec(spec, candidateResult);
    appendEvent(db, runId, "gate", {
      script: "candidate",
      verdict: candidateGrade.verdict,
      reason: candidateGrade.detail.reason,
    });

    let minimal = plan.minimalRepro;
    if (countNonEmptyLines(minimal) > MAX_MINIMAL_NON_EMPTY_LINES) {
      minimal = stripCommentsAndBlanks(minimal);
    }
    if (countNonEmptyLines(minimal) > MAX_MINIMAL_NON_EMPTY_LINES) {
      putArtifact(db, runId, "findings.md", plan.findingsMd);
      appendEvent(db, runId, "report", {
        status: "inconclusive",
        reason: "minimal repro exceeds the 20-line shrink budget",
      });
      setRunOutcome(db, runId, "inconclusive", "inconclusive");
      return { runId, verdict: "inconclusive" };
    }

    const minimalResult = executePythonScript(minimal);
    const minimalGrade = gradeAgainstSpec(spec, minimalResult);
    appendEvent(db, runId, "gate", {
      script: "minimal",
      verdict: minimalGrade.verdict,
      reason: minimalGrade.detail.reason,
    });

    let finalScript: string | null = null;
    let verdict: GateVerdict = "inconclusive";
    if (minimalGrade.verdict === "reproduced") {
      finalScript = minimal;
      verdict = "reproduced";
    } else if (candidateGrade.verdict === "reproduced") {
      finalScript = plan.reproCandidate;
      verdict = "reproduced";
    }
    if (finalScript === null) {
      putArtifact(db, runId, "repro.py", minimal);
      putArtifact(db, runId, "findings.md", plan.findingsMd);
      appendEvent(db, runId, "report", {
        status: "inconclusive",
        reason: "neither the candidate nor the minimal repro graded reproduced",
      });
      setRunOutcome(db, runId, "inconclusive", "inconclusive");
      return { runId, verdict: "inconclusive" };
    }

    if (!finalScript.includes("import") || finalScript.split("\n").length > MAX_ARTIFACT_LINES) {
      putArtifact(db, runId, "repro.py", finalScript);
      putArtifact(db, runId, "findings.md", plan.findingsMd);
      appendEvent(db, runId, "report", {
        status: "inconclusive",
        reason: "final repro violates the artifact bounds",
      });
      setRunOutcome(db, runId, "inconclusive", "inconclusive");
      return { runId, verdict: "inconclusive" };
    }

    putArtifact(db, runId, "repro.py", finalScript);
    putArtifact(db, runId, "findings.md", plan.findingsMd);
    appendEvent(db, runId, "report", { status: verdict, verdict });
    setRunOutcome(db, runId, verdict, verdict);
    return { runId, verdict };
  } finally {
    db.close();
  }
}
