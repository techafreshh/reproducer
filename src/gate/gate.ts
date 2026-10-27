/**
 * Deterministic symptom gate: grades an env_run result against the run's
 * frozen symptom spec and returns a verdict for the agent session —
 * `reproduced`, `not-reproduced`, or `inconclusive`. Verdicts are computed by
 * pure code with zero model calls; the agent session only ever sees verdicts,
 * never a prompt.
 *
 * Rules per symptom class:
 * - `exception`: the parsed exception type's last dot-segment must equal the
 *   class derived from `errorStrings` (or appear as a word in them when no
 *   class is derivable; with nothing pinned the class check is vacuous), and
 *   at least `minMatchingFrames` parsed frames must land on the spec's pinned
 *   module+function pairs (vacuous when `frames` is empty).
 * - `wrong-output`: every `expectedOutput` entry (the symptom text a buggy
 *   run emits) must appear in stdout after whitespace normalization; output
 *   match wins over exit code, so a repro that prints the symptom and then
 *   raises still grades `reproduced`. Never fabricates output: a spec without
 *   `expectedOutput` grades `inconclusive`.
 * - `hang`: `timedOut` is the verdict — a genuine hang that logged import
 *   noise still hung.
 * When the trigger was never reached — an import/module-not-found failure, or
 * an `exception` run that exited 0 without crashing — the verdict is
 * `inconclusive`: the environment is broken, which says nothing about the bug.
 */
import {
  getSymptomSpec,
  isSymptomSpecFrozen,
  openLedger,
  type Ledger,
} from "../orchestrator/ledger.js";
import { validateSymptomSpec, type SymptomSpec } from "./spec.js";
import { parseTraceback } from "./traceback.js";

export type GateVerdict = "reproduced" | "not-reproduced" | "inconclusive";

/**
 * One env_run outcome, as produced by the sandbox tool. `stdout`/`stderr`
 * grade as empty when absent — ledger-style leniency for our own tool output.
 */
export interface EnvRunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut: boolean;
}

export interface GateDetail {
  /** One-line, agent-facing explanation of the verdict. */
  reason: string;
  symptomClass: "exception" | "wrong-output" | "hang";
  timedOut: boolean;
  /** Exception type parsed from stderr; null when nothing was parsed or the class is not `exception`. */
  parsedExceptionType: string | null;
  /** Exception class derived from the spec's errorStrings; null = none pinned. */
  expectedExceptionType: string | null;
  matchingFrames: number;
  requiredFrames: number;
  outputMatched: number;
  outputRequired: number;
}

export interface GateResult {
  verdict: GateVerdict;
  detail: GateDetail;
}

// Word-bounded markers of a broken environment on raw stderr — matched before
// any parsing because an import failure never produces a traceback header.
const IMPORT_FAILURE_RE = /\b(?:ModuleNotFoundError|ImportError)\b|\bNo module named\b/;

// Mirrors traceback.ts's EXCEPTION_RE: a leading `Type: message`-shaped token,
// colon optional, so degraded bug-report strings still yield a candidate.
const ERROR_TOKEN_RE = /^\s*([A-Za-z_]\w*(?:\.\w+)*)(?::\s?.*)?$/;

function isImportFailure(stderr: string): boolean {
  return IMPORT_FAILURE_RE.test(stderr);
}

/** Last dot-segment of a (possibly dotted) name; plain names pass through. */
function lastSegment(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * Exception classes pinned by `errorStrings`: the leading `Type: message`
 * token of each string, kept only when its class-naming last segment starts
 * uppercase (CapWords) so message fragments like "boom" are never mistaken
 * for classes. Dotted tokens collapse to that last segment for matching.
 */
function expectedExceptionClasses(errorStrings: string[]): string[] {
  const classes: string[] = [];
  for (const errorString of errorStrings) {
    const token = ERROR_TOKEN_RE.exec(errorString)?.[1];
    if (token === undefined) continue;
    const last = lastSegment(token);
    if (/^[A-Z]/.test(last) && !classes.includes(last)) classes.push(last);
  }
  return classes;
}

/** Copy of traceback.ts's basename, kept local so traceback.ts stays untouched. */
function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep === -1 ? path : path.slice(sep + 1);
}

/**
 * Parsed frames that land on a spec-pinned module basename + function. Every
 * matching parsed frame counts — recursion hitting the same pinned pair in a
 * deeper traceback counts per hit — while the pinned-side set collapses
 * duplicated spec entries so no parsed frame is credited more than once.
 */
function countMatchingFrames(
  parsedFrames: { module: string; function: string }[],
  specFrames: { module: string; function: string }[],
): number {
  const pinned = new Set(specFrames.map((frame) => `${basename(frame.module)}\u0000${frame.function}`));
  let count = 0;
  for (const frame of parsedFrames) {
    if (pinned.has(`${frame.module}\u0000${frame.function}`)) count++;
  }
  return count;
}

/** Trim and collapse runs of whitespace so output comparisons ignore layout. */
function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Render an expectedOutput entry to comparable text: strings verbatim, everything else JSON. */
function renderOutputEntry(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Grade an env_run result against an already-validated spec — the pure core
 * behind `grade`. Never throws, never imports a ledger, never talks to a
 * model: the verdict is fully determined by (spec, envResult).
 */
export function gradeAgainstSpec(spec: SymptomSpec, envResult: EnvRunResult): GateResult {
  const stdout = envResult.stdout ?? "";
  const stderr = envResult.stderr ?? "";
  const timedOut = envResult.timedOut === true;
  const detail: GateDetail = {
    reason: "",
    symptomClass: spec.symptomClass,
    timedOut,
    parsedExceptionType: null,
    expectedExceptionType: null,
    matchingFrames: 0,
    requiredFrames: 0,
    outputMatched: 0,
    outputRequired: 0,
  };

  if (spec.symptomClass === "hang") {
    // Before the import check: a genuine hang that logged import noise still hung.
    if (timedOut) {
      return {
        verdict: "reproduced",
        detail: { ...detail, reason: "command timed out, reproducing the pinned hang" },
      };
    }
    if (isImportFailure(stderr)) {
      return {
        verdict: "inconclusive",
        detail: { ...detail, reason: "trigger never reached: import/module-not-found failure" },
      };
    }
    return {
      verdict: "not-reproduced",
      detail: { ...detail, reason: `command exited ${envResult.exitCode} without hanging` },
    };
  }

  if (spec.symptomClass === "wrong-output") {
    if (isImportFailure(stderr)) {
      return {
        verdict: "inconclusive",
        detail: { ...detail, reason: "trigger never reached: import/module-not-found failure" },
      };
    }
    if (spec.expectedOutput === null || Object.keys(spec.expectedOutput).length === 0) {
      return {
        verdict: "inconclusive",
        detail: { ...detail, reason: "not gradeable: symptom spec pins no expected output" },
      };
    }
    const normalizedStdout = normalizeWhitespace(stdout);
    const entries = Object.entries(spec.expectedOutput);
    let matched = 0;
    for (const [, value] of entries) {
      if (normalizedStdout.includes(normalizeWhitespace(renderOutputEntry(value)))) matched++;
    }
    // Output match wins over exit code: a repro that prints the pinned
    // symptom and then raises still reproduced the bug.
    if (matched === entries.length) {
      return {
        verdict: "reproduced",
        detail: {
          ...detail,
          reason: `matched ${matched}/${entries.length} expected symptom entries in stdout`,
          outputMatched: matched,
          outputRequired: entries.length,
        },
      };
    }
    // A crash short-circuits the symptom output; the agent repairs the env.
    if (envResult.exitCode !== 0) {
      return {
        verdict: "inconclusive",
        detail: { ...detail, reason: `trigger never reached: command exited ${envResult.exitCode}` },
      };
    }
    return {
      verdict: "not-reproduced",
      detail: {
        ...detail,
        reason: `matched ${matched}/${entries.length} expected symptom entries in stdout`,
        outputMatched: matched,
        outputRequired: entries.length,
      },
    };
  }

  // spec.symptomClass === "exception"
  if (isImportFailure(stderr)) {
    return {
      verdict: "inconclusive",
      detail: { ...detail, reason: "trigger never reached: import/module-not-found failure" },
    };
  }
  if (envResult.exitCode === 0) {
    return {
      verdict: "inconclusive",
      detail: { ...detail, reason: "trigger never reached: command exited 0 with no crash" },
    };
  }
  const parsed = parseTraceback(stderr);
  if (parsed.exceptionType === null) {
    return {
      verdict: "not-reproduced",
      detail: { ...detail, reason: "no recognizable traceback in stderr" },
    };
  }

  const derivableClasses = expectedExceptionClasses(spec.errorStrings);
  const parsedLast = lastSegment(parsed.exceptionType);
  // Fallback: only when no leading token derives a class, an error string
  // naming the parsed class in prose ("raises ValueError when empty") still
  // pins it — a derived expected class is never overridden by a word mention.
  const wordPinned = spec.errorStrings.some((errorString) =>
    errorString.split(/[^A-Za-z0-9_]/).includes(parsedLast),
  );
  const classPinned = derivableClasses.length > 0 || wordPinned;
  const classMatched = derivableClasses.includes(parsedLast) || (derivableClasses.length === 0 && wordPinned);
  const expectedExceptionType = derivableClasses[0] ?? null;
  const framesPinned = spec.frames.length > 0;
  const requiredFrames = framesPinned ? (spec.minMatchingFrames ?? 2) : 0;
  const matchingFrames = framesPinned ? countMatchingFrames(parsed.frames, spec.frames) : 0;
  const crashNote =
    expectedExceptionType !== null
      ? `crashed with expected ${expectedExceptionType}`
      : `crashed with ${parsed.exceptionType}`;
  const base = {
    ...detail,
    parsedExceptionType: parsed.exceptionType,
    expectedExceptionType,
    matchingFrames,
    requiredFrames,
  };

  if (classPinned && !classMatched) {
    return {
      verdict: "not-reproduced",
      detail: {
        ...base,
        reason: `crashed with ${parsed.exceptionType} instead of expected ${expectedExceptionType}`,
      },
    };
  }
  if (!framesPinned) {
    if (classMatched) {
      return {
        verdict: "reproduced",
        detail: { ...base, reason: `${crashNote} (no frames pinned)` },
      };
    }
    return {
      verdict: "inconclusive",
      detail: { ...base, reason: "symptom spec pins no exception class and no frames" },
    };
  }
  if (matchingFrames < requiredFrames) {
    return {
      verdict: "not-reproduced",
      detail: { ...base, reason: `crash path matched only ${matchingFrames}/${requiredFrames} pinned frames` },
    };
  }
  return {
    verdict: "reproduced",
    detail: {
      ...base,
      reason: `${crashNote} and matched ${matchingFrames}/${requiredFrames} pinned frames`,
    },
  };
}

/**
 * Grade an env_run against the run's frozen symptom spec — the issue-pinned
 * entry point. Reads (never writes) the ledger; the stored spec is validated
 * again on the way in, materializing `minMatchingFrames`. Throws the sentinel
 * when the run has no frozen spec: the gate is only called after freeze, so a
 * missing (or merely drafted) spec is an orchestration bug, not a verdict.
 */
export function grade(runId: number, envResult: EnvRunResult, db: Ledger = openLedger()): GateResult {
  if (!isSymptomSpecFrozen(db, runId)) {
    throw new Error(`no frozen symptom spec for run ${runId}`);
  }
  const stored = getSymptomSpec(db, runId);
  if (stored === null) {
    throw new Error(`no frozen symptom spec for run ${runId}`);
  }
  return gradeAgainstSpec(validateSymptomSpec(stored), envResult);
}
