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
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  countNonEmptyLines,
  executePythonScript,
  MAX_ARTIFACT_LINES,
  MAX_MINIMAL_NON_EMPTY_LINES,
  stripCommentsAndBlanks,
} from "../replay/exec.js";
import { gradeAgainstSpec, type EnvRunResult, type GateVerdict } from "../gate/gate.js";
import { freezeSymptomSpec, validateSymptomSpec, type SymptomSpec } from "../gate/spec.js";
import { runBisect, type BisectRow } from "../agent/tools/bisect.js";
import {
  buildFindingsMd,
  buildReproPy,
  collectCitationUrls,
  type ResearchVerdict,
} from "../report/findings.js";
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

/** Shared python executor; re-exported so existing importers keep working. */
export { executePythonScript };

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

/** Demo-1 research verdict: hatch() defaulting to brood(-1) is a caller-side misuse. */
const DEMO_RESEARCH_VERDICT: ResearchVerdict = "likely-misconfiguration";

/** Hypotheses joined from scripted bumper payloads for `## Hypothesis`. */
function hypothesisOf(bumpers: Array<{ kind: string; payload: unknown }>): string {
  const parts: string[] = [];
  for (const bumper of bumpers) {
    const payload = bumper.payload;
    if (isRecord(payload) && typeof payload.hypothesis === "string" && payload.hypothesis.length > 0) {
      parts.push(payload.hypothesis);
    } else if (typeof payload === "string" && payload.length > 0) {
      parts.push(payload);
    } else if (isRecord(payload)) {
      try {
        parts.push(JSON.stringify(payload));
      } catch {
        continue;
      }
    }
  }
  if (parts.length === 0) return "No hypothesis recorded.";
  return parts.map((part) => `- ${part}`).join("\n");
}

/** Reported environment from the canned issue body (the `Environment:` line when present). */
function reportedEnvOf(cannedIssue: unknown): string {
  if (isRecord(cannedIssue) && typeof cannedIssue.body === "string" && cannedIssue.body.length > 0) {
    const body = cannedIssue.body;
    const envLine = body.split("\n").find((line) => /environment:/i.test(line));
    if (envLine !== undefined) return envLine.trim();
    const collapsed = body.replace(/\s+/g, " ").trim();
    return collapsed.length <= 500 ? collapsed : collapsed.slice(0, 500);
  }
  return "unknown (no issue body)";
}

/** Issue title for the `## Evidence` section. */
function issueTitleOf(cannedIssue: unknown): string {
  if (isRecord(cannedIssue) && typeof cannedIssue.title === "string") return cannedIssue.title;
  return "";
}

/** One-line evidence entry: issue, trigger, and the gate grading for a script. */
function evidenceOf(title: string, spec: SymptomSpec, label: string, verdict: GateVerdict, reason: string): string {
  return [`- Issue: ${title.length > 0 ? title : "(no title)"}`, `- Trigger: ${spec.trigger}`, `- Gate (${label}): ${verdict} \u2014 ${reason}`].join("\n");
}

/** Fix sketch: concrete for reproduced runs, honest placeholder otherwise. */
function fixSketchFor(status: GateVerdict): string {
  if (status === "reproduced") {
    return "Validate the hatch() default: use brood(0) for an empty flock or surface a caller-facing error instead of propagating ValueError from brood(-1).";
  }
  return "No fix sketch \u2014 run did not reproduce conclusively.";
}

/** Grade one env result per spec version for the `## Bisect` table. */
function bisectRowsFor(spec: SymptomSpec, result: EnvRunResult): BisectRow[] {
  const versions = spec.versions.length > 0 ? spec.versions : ["0.1.0"];
  try {
    return runBisect(spec, versions, versions.map(() => result));
  } catch {
    const graded = gradeAgainstSpec(spec, result);
    return versions.map((version) => ({
      version,
      verdict: graded.verdict,
      reason: graded.detail.reason,
    }));
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

    const citations = collectCitationUrls(cannedTavily);
    const hypothesis = hypothesisOf(plan.bumpers);
    const reportedEnv = reportedEnvOf(cannedIssue);
    const title = issueTitleOf(cannedIssue);
    const library = spec.library;
    const version = spec.versions[0] ?? "unknown";

    let minimal = plan.minimalRepro;
    if (countNonEmptyLines(minimal) > MAX_MINIMAL_NON_EMPTY_LINES) {
      minimal = stripCommentsAndBlanks(minimal);
    }
    if (countNonEmptyLines(minimal) > MAX_MINIMAL_NON_EMPTY_LINES) {
      const rows = bisectRowsFor(spec, candidateResult);
      const reproPy = buildReproPy({ library, version, body: minimal, inconclusive: true });
      const findings = buildFindingsMd({
        hypothesis,
        evidence: `${evidenceOf(title, spec, "candidate", candidateGrade.verdict, candidateGrade.detail.reason)}\n- Shrink: minimal repro exceeds the 20-line shrink budget`,
        researchVerdict: DEMO_RESEARCH_VERDICT,
        citations,
        bisectRows: rows,
        fixSketch: fixSketchFor("inconclusive"),
        reportedEnv,
        status: "inconclusive",
      });
      putArtifact(db, runId, "repro.py", reproPy);
      putArtifact(db, runId, "findings.md", findings);
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
      const rows = bisectRowsFor(spec, minimalResult);
      const reproPy = buildReproPy({ library, version, body: minimal, inconclusive: true });
      const findings = buildFindingsMd({
        hypothesis,
        evidence: evidenceOf(title, spec, "minimal", minimalGrade.verdict, minimalGrade.detail.reason),
        researchVerdict: DEMO_RESEARCH_VERDICT,
        citations,
        bisectRows: rows,
        fixSketch: fixSketchFor("inconclusive"),
        reportedEnv,
        status: "inconclusive",
      });
      putArtifact(db, runId, "repro.py", reproPy);
      putArtifact(db, runId, "findings.md", findings);
      appendEvent(db, runId, "report", {
        status: "inconclusive",
        reason: "neither the candidate nor the minimal repro graded reproduced",
      });
      setRunOutcome(db, runId, "inconclusive", "inconclusive");
      return { runId, verdict: "inconclusive" };
    }

    const finalResult = finalScript === minimal ? minimalResult : candidateResult;
    const finalGrade = finalScript === minimal ? minimalGrade : candidateGrade;
    const builtRepro = buildReproPy({ library, version, body: finalScript, inconclusive: false });
    const builtCodeLines = countNonEmptyLines(stripCommentsAndBlanks(builtRepro));
    if (
      !builtRepro.includes("import") ||
      builtRepro.split("\n").length > MAX_ARTIFACT_LINES ||
      builtCodeLines > MAX_MINIMAL_NON_EMPTY_LINES
    ) {
      const rows = bisectRowsFor(spec, finalResult);
      const reproPy = buildReproPy({ library, version, body: finalScript, inconclusive: true });
      const findings = buildFindingsMd({
        hypothesis,
        evidence: `${evidenceOf(title, spec, "final", finalGrade.verdict, finalGrade.detail.reason)}\n- Bounds: final repro violates the artifact bounds`,
        researchVerdict: DEMO_RESEARCH_VERDICT,
        citations,
        bisectRows: rows,
        fixSketch: fixSketchFor("inconclusive"),
        reportedEnv,
        status: "inconclusive",
      });
      putArtifact(db, runId, "repro.py", reproPy);
      putArtifact(db, runId, "findings.md", findings);
      appendEvent(db, runId, "report", {
        status: "inconclusive",
        reason: "final repro violates the artifact bounds",
      });
      setRunOutcome(db, runId, "inconclusive", "inconclusive");
      return { runId, verdict: "inconclusive" };
    }

    const bisectRows = bisectRowsFor(spec, finalResult);
    const findings = buildFindingsMd({
      hypothesis,
      evidence: evidenceOf(title, spec, "final", finalGrade.verdict, finalGrade.detail.reason),
      researchVerdict: DEMO_RESEARCH_VERDICT,
      citations,
      bisectRows,
      fixSketch: fixSketchFor(verdict),
      reportedEnv,
      status: verdict,
    });
    putArtifact(db, runId, "repro.py", builtRepro);
    putArtifact(db, runId, "findings.md", findings);
    appendEvent(db, runId, "report", { status: verdict, verdict });
    setRunOutcome(db, runId, verdict, verdict);
    return { runId, verdict };
  } finally {
    db.close();
  }
}
