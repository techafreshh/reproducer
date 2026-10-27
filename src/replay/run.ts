/**
 * Shared replay runner: drives the full pipeline from bundled fixtures with
 * zero keys and zero network.
 *
 * `--replay <dir>` (and the `REPLAY=1` env toggle) routes here from
 * `src/cli.ts`. The fixture directory is the single source of canned inputs:
 * `issue.json`, hash-keyed `tavily/<sha256(query)>.json`, and the scripted
 * `trace.json` session. Every stage reuses the live code paths — the ledger
 * (`insertRun`/`appendEvent`/`putArtifact`/`setRunOutcome`), the scripted
 * triage provider plus `runTriage` (freeze + research queries), the
 * `FixturesClient` research seam, the real-python executor shared with
 * `--scripted`, the pure gate via `runSession`, and the report artifacts the
 * dashboard already serves. No live-provider, key, or network changes.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runSession } from "../agent/session.js";
import { runTriage } from "../agent/triage.js";
import { parseIssueUrl } from "../issue-url.js";
import { createScriptedProvider } from "../llm/provider.js";
import {
  appendEvent,
  getArtifact,
  insertRun,
  openLedger,
} from "../orchestrator/ledger.js";
import { isRepoAllowlisted } from "../post/config.js";
import { postGithubComment, type FetchFn } from "../post/github-comment.js";
import { executePythonScript } from "./exec.js";
import { DEFAULT_REPLAY_DIR, FixturesClient } from "./fixtures.js";

export { DEFAULT_REPLAY_DIR };

/** Default budget for one replayed `env_run` when the trace sets no `timeoutMs`. */
export const REPLAY_PYTHON_TIMEOUT_MS = 15000;

export interface ReplayResult {
  runId: number;
  status: string;
}

/** Optional delivery-edge posting after a replay run completes. */
export interface ReplayPostOptions {
  postEnabled?: boolean;
  allowlist?: string[];
  dashboardBase?: string;
  fetchFn?: FetchFn;
  token?: string;
}

/** Resolve the trace base without capturing env at import time. */
function resolveReplayDashboardBase(explicit?: string): string {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim().replace(/\/+$/, "");
  }
  const env = process.env.DASHBOARD_BASE_URL;
  if (typeof env === "string" && env.trim().length > 0) {
    return env.trim().replace(/\/+$/, "");
  }
  return "http://localhost:8080";
}

/** Read and parse a JSON fixture; absent or unparseable reads fail loudly with the basename sentinel. */
function readFixtureJson(dir: string, name: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(resolve(dir, name), "utf8");
  } catch {
    throw new Error(`missing fixture: ${name}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`missing fixture: ${name} is not valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Load the fixture's symptom spec: `spec.json` (a raw spec, or `{symptomSpec}`)
 * when present, else the `symptomSpec` of the legacy `plan.json` bundle.
 */
function loadFixtureSpec(dir: string): unknown {
  for (const name of ["spec.json", "plan.json"]) {
    try {
      const raw = readFixtureJson(dir, name);
      return isRecord(raw) && "symptomSpec" in raw ? raw.symptomSpec : raw;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A present-but-unparseable file is a fixture bug: surface it as-is.
      if (message !== `missing fixture: ${name}`) throw error;
      if (name === "plan.json") throw new Error("missing fixture: spec.json");
    }
  }
  throw new Error("missing fixture: spec.json");
}

/** Load the fixture's scripted session trace; it must carry at least one step. */
function loadTraceScript(dir: string): unknown[] {
  const raw = readFixtureJson(dir, "trace.json");
  const steps = asStepList(raw);
  if (steps.length === 0) {
    throw new Error("missing fixture: trace.json has no scripted steps");
  }
  return steps;
}

function asStepList(script: unknown): unknown[] {
  if (Array.isArray(script)) return script;
  if (isRecord(script)) {
    for (const key of ["steps", "script", "toolCalls", "tool_calls", "calls", "plan"]) {
      const nested = script[key];
      if (Array.isArray(nested)) return nested;
    }
  }
  return [];
}

function canonicalToolName(raw: string): string {
  return raw.toLowerCase().replace(/[_\-\s]/g, "");
}

/** Scripted `env_run` spellings, mirroring the session dispatcher. */
const ENV_RUN_NAMES = new Set(["envrun", "runenv", "sandboxrun", "run", "exec"]);

function toolOf(step: Record<string, unknown>): string | null {
  for (const key of ["tool", "name", "type", "action", "call", "tool_call", "toolCall"]) {
    const value = step[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** A step that already carries a canned result needs no python execution. */
function hasCannedResult(step: Record<string, unknown>): boolean {
  for (const key of ["envResult", "env_result", "result", "output", "response", "sandboxResult", "outcome"]) {
    if (step[key] !== undefined) return true;
  }
  return false;
}

function scriptOf(step: Record<string, unknown>): string | null {
  for (const key of ["script", "code", "cmd", "command"]) {
    const value = step[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Bind each scripted `env_run` step to a real-python outcome: steps carrying
 * inline code but no canned result are executed with the shared `python3`
 * executor (honoring a per-step `timeoutMs`, else the replay budget) and the
 * graded `EnvRunResult` is attached as `envResult`, which is exactly what the
 * session grades. Deterministic, offline, stdlib-only.
 */
export function enrichEnvRuns(
  script: unknown,
  defaultTimeoutMs: number = REPLAY_PYTHON_TIMEOUT_MS,
): Array<Record<string, unknown>> {
  return asStepList(script).map((entry) => {
    if (!isRecord(entry)) return entry as Record<string, unknown>;
    const tool = toolOf(entry);
    if (tool === null || !ENV_RUN_NAMES.has(canonicalToolName(tool))) return entry;
    if (hasCannedResult(entry)) return entry;
    const code = scriptOf(entry);
    if (code === null) return entry;
    const timeoutRaw = entry.timeoutMs;
    const timeoutMs =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.floor(timeoutRaw)
        : defaultTimeoutMs;
    return { ...entry, envResult: executePythonScript(code, timeoutMs) };
  });
}

/**
 * Drive the whole engine once on a fixture directory: parse the issue URL,
 * load the canned spec + trace, replay the issue through `FixturesClient`,
 * freeze the spec via the scripted triage provider (`runTriage`), replay
 * each derived research query through the hash-keyed Tavily seam, execute
 * the trace's `env_run` steps with real python, and submit through
 * `runSession` (grading, `repro.py`/`findings.md` artifacts, terminal
 * outcome). Returns the ledger run id and its terminal status.
 */
export async function runReplay(
  issueUrl: string,
  fixtureDir: string = DEFAULT_REPLAY_DIR,
  dbPath?: string,
  postOptions?: ReplayPostOptions,
): Promise<ReplayResult> {
  const issue = parseIssueUrl(issueUrl);
  const dir = isAbsolute(fixtureDir) ? fixtureDir : resolve(process.cwd(), fixtureDir);

  const client = new FixturesClient(dir);
  // The canned issue loads first so a fixture without `issue.json` always
  // reports that basename, no matter what else the directory is missing.
  const cannedIssue = await client.githubGetIssue(issue.url);
  const symptomSpec = loadFixtureSpec(dir);
  const trace = loadTraceScript(dir);

  const db = openLedger(dbPath);
  try {
    const runId = insertRun(db, issue.url);

    const provider = createScriptedProvider({ triageOutputs: [JSON.stringify(symptomSpec)] });
    const { queries } = await runTriage(
      runId,
      { body: cannedIssue.body, comments: cannedIssue.comments },
      provider,
      db,
    );

    for (const query of queries) {
      const response = await client.tavilySearch(query);
      appendEvent(db, runId, "research", { query, results: response.results });
    }

    const session = await runSession(runId, enrichEnvRuns(trace), db);
    if (postOptions?.postEnabled === true) {
      if (
        postOptions.allowlist !== undefined &&
        !isRepoAllowlisted(issue.owner, issue.repo, postOptions.allowlist)
      ) {
        throw new Error("repo not in post allowlist");
      }
      const findings = getArtifact(db, runId, "findings.md")?.content ?? "";
      const base = resolveReplayDashboardBase(postOptions.dashboardBase);
      const body = `${findings}\n\nTrace: ${base}/runs/${runId}`;
      await postGithubComment(issue.owner, issue.repo, issue.number, body, {
        fetch: postOptions.fetchFn ?? globalThis.fetch,
        token: postOptions.token ?? process.env.GITHUB_TOKEN,
      });
      appendEvent(db, runId, "post_comment", { kind: "github_comment", body });
    }
    return { runId, status: session.status };
  } finally {
    db.close();
  }
}
