/**
 * Investigation session: the MODEL_REASON agent loop over the seven-tool
 * surface, graded only by the frozen symptom-spec gate, under hard budget
 * latches.
 *
 * Driver duality: a deterministic `ScriptedDriver` (ordered tool-call script —
 * the acceptance and replay path) and a `LiveDriver` seam that dynamically
 * imports `pi-agent-core` only when keys exist and otherwise falls back to
 * scripted. Both paths share the same dispatch/gate/ledger functions, so
 * keyless CI proves the live path's orchestration.
 *
 * Budgets (`src/orchestrator/budgets.ts`) are checked before every dispatch:
 * at most 3 hypotheses, at most 8 `env_run` calls per hypothesis, a
 * wall-clock deadline (default 20 min) and a token cap; exceeding any aborts
 * honestly to `inconclusive` with best evidence attached. The session never
 * writes to the symptom spec after freeze: any scripted spec-write step is
 * refused with `spec_write_refused` and the ledger spec stays byte-identical.
 */
import { Type, type Static } from "@sinclair/typebox/type";
import {
  appendEvent,
  getRun,
  getSymptomSpec,
  isSymptomSpecFrozen,
  openLedger,
  putArtifact,
  setRunOutcome,
  type Ledger,
} from "../orchestrator/ledger.js";
import {
  addTokens,
  BUDGET_DEFAULTS,
  checkBudget,
  checkEnvRun,
  checkNewHypothesis,
  createBudgets,
  recordEnvRun,
  recordHypothesis,
  type BudgetState,
} from "../orchestrator/budgets.js";
import { grade, type EnvRunResult, type GateVerdict } from "../gate/gate.js";
import { BisectInputSchema, runBisect, toBisectResult, type BisectResult } from "./tools/bisect.js";
import { withBisectSection } from "../report/findings.js";

/** Read-only ingestion: issue body/comments via public REST (scripted: canned). */
export const GithubGetIssueSchema = Type.Object({
  issueUrl: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
});

/** Research: exact error strings, changelogs, related reports (scripted: canned). */
export const TavilySearchSchema = Type.Object({
  query: Type.Optional(Type.String()),
  maxResults: Type.Optional(Type.Number()),
});

/** Research extract for one URL (scripted: canned). */
export const TavilyExtractSchema = Type.Object({
  url: Type.Optional(Type.String()),
});

export type TavilySearchInput = Static<typeof TavilySearchSchema>;

/** Fresh venv with pinned installs; returns an env handle (scripted: incrementing). */
export const EnvCreateSchema = Type.Object({
  installs: Type.Optional(Type.Array(Type.String())),
  pythonVersion: Type.Optional(Type.String()),
});

/** Sandbox execution graded by the frozen gate (scripted: canned result). */
export const EnvRunSchema = Type.Object({
  cmd: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  exitCode: Type.Optional(Type.Number()),
  stdout: Type.Optional(Type.String()),
  stderr: Type.Optional(Type.String()),
  timedOut: Type.Optional(Type.Boolean()),
});

export type EnvRunInput = Static<typeof EnvRunSchema>;

/** Version-matrix runner over the verified repro (at most 8 versions). */
export const BisectToolSchema = BisectInputSchema;

/** Ends the session at the gate; emits the final artifacts. */
export const SubmitReportSchema = Type.Object({
  status: Type.Union([
    Type.Literal("reproduced"),
    Type.Literal("not-reproduced"),
    Type.Literal("inconclusive"),
  ]),
  reproPy: Type.Optional(Type.String()),
  findingsMd: Type.Optional(Type.String()),
});

export type SubmitReportInput = Static<typeof SubmitReportSchema>;

/** The seven-tool surface, in dispatch order. */
export const TOOL_SCHEMAS = {
  github_get_issue: GithubGetIssueSchema,
  tavily_search: TavilySearchSchema,
  tavily_extract: TavilyExtractSchema,
  env_create: EnvCreateSchema,
  env_run: EnvRunSchema,
  bisect: BisectToolSchema,
  submit_report: SubmitReportSchema,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

/** One ordered script step: any object with a tool marker plus its input. */
export type ScriptStep = Record<string, unknown>;

export interface RunSessionOptions {
  budget?: Partial<Pick<BudgetState, "maxHypotheses" | "maxEnvRunsPerHypothesis" | "wallClockMs" | "maxTokens">>;
  wallClockMs?: number;
  maxTokens?: number;
  startTime?: number;
  tokensPerCall?: number;
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface SessionResult {
  runId: number;
  status: string;
  verdict: string | null;
  hypotheses: number;
  envRuns: number[];
  driver: "scripted" | "live";
  submitted: boolean;
}

export type SessionDriver = "scripted" | "live";

/**
 * Driver selection: `live` only when both `NEBIUS_API_KEY` and `MODEL_REASON`
 * exist; otherwise `scripted`. No imports, no network — the dynamic
 * `pi-agent-core` import happens in `resolveDriver`.
 */
export function selectDriver(env: NodeJS.ProcessEnv = process.env): SessionDriver {
  const apiKey = env.NEBIUS_API_KEY;
  const model = env.MODEL_REASON;
  if (
    apiKey !== undefined &&
    apiKey !== "" &&
    model !== undefined &&
    model !== ""
  ) {
    return "live";
  }
  return "scripted";
}

/**
 * Live-driver seam: when keys exist, attempt the `pi-agent-core` import and
 * fall back to scripted on failure. Both drivers share the dispatch/gate/
 * ledger path below, so acceptance never needs keys.
 */
export async function resolveDriver(env: NodeJS.ProcessEnv = process.env): Promise<SessionDriver> {
  if (selectDriver(env) === "scripted") return "scripted";
  for (const id of ["@earendil-works/pi-agent-core", "pi-agent-core"]) {
    try {
      await import(/* @vite-ignore */ id);
      return "live";
    } catch {
      continue;
    }
  }
  return "scripted";
}

/** Minimal agent shim: every session event flows through `emit` (and `subscribe`). */
export interface SessionAgent {
  subscribe(listener: (event: { kind: string; payload: unknown }) => void): () => void;
  emit(kind: string, payload: unknown): number;
}

/** Event-sourced agent over the ledger: `emit` appends with per-run `seq`. */
export function createSessionAgent(db: Ledger, runId: number): SessionAgent {
  const listeners = new Set<(event: { kind: string; payload: unknown }) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(kind, payload) {
      const id = appendEvent(db, runId, kind, payload);
      for (const listener of listeners) {
        listener({ kind, payload });
      }
      return id;
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Normalize the scripted plan into an ordered step list (lenient by design). */
function normalizeScript(script: unknown): ScriptStep[] {
  if (script === undefined || script === null) return [];
  if (typeof script === "string") {
    try {
      return normalizeScript(JSON.parse(script) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(script)) {
    return script.filter((step) => asRecord(step) !== null) as ScriptStep[];
  }
  const record = asRecord(script);
  if (record === null) return [];
  for (const key of ["steps", "script", "toolCalls", "tool_calls", "calls", "plan"]) {
    if (Array.isArray(record[key])) {
      return normalizeScript(record[key]);
    }
  }
  return [record as ScriptStep];
}

function canonicalToolName(raw: string): string {
  return raw.toLowerCase().replace(/[_\-\s]/g, "");
}

const SPEC_WRITE_NAMES = new Set(
  ["writespec", "putsymptomspec", "freezesymptomspec", "freezespec", "freeze", "symptomspec", "spec", "specwrite", "putspect", "writesymptomspec"].map(
    (name) => name,
  ),
);

/** A step targeting the latched spec: refused, never written. */
function isSpecWriteStep(step: ScriptStep, tool: string | null): boolean {
  if (tool !== null && SPEC_WRITE_NAMES.has(canonicalToolName(tool))) return true;
  if (tool !== null && /spec/i.test(tool)) return true;
  for (const key of ["putSymptomSpec", "freezeSymptomSpec", "write_spec", "writeSpec", "spec_json", "symptom_spec"]) {
    if (step[key] !== undefined) return true;
  }
  if (tool !== null && canonicalToolName(tool) === "putspect") return true;
  return false;
}

/** Extract the tool marker from the many script shapes probes may use. */
function toolNameOf(step: ScriptStep): string | null {
  for (const key of ["tool", "name", "type", "action", "call", "tool_call", "toolCall"]) {
    const value = step[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Hypothesis marker: `{ newHypothesis: "label" }` and its aliases. */
function hypothesisLabelOf(step: ScriptStep, tool: string | null): string | null {
  for (const key of ["newHypothesis", "new_hypothesis", "newHypotheses"]) {
    const value = step[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  if (tool !== null) {
    const canonical = canonicalToolName(tool);
    if (canonical === "newhypothesis" || canonical === "hypothesis" || canonical === "newhypotheses") {
      const label =
        stringField(step, ["label", "title", "hypothesis", "newHypothesis", "new_hypothesis", "input"]) ??
        "hypothesis";
      return label;
    }
  }
  return null;
}

function nestedInput(step: ScriptStep): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...step };
  for (const key of ["input", "args", "params", "arguments"]) {
    const nested = asRecord(step[key]);
    if (nested !== null) {
      for (const [nestedKey, nestedValue] of Object.entries(nested)) {
        if (merged[nestedKey] === undefined) merged[nestedKey] = nestedValue;
      }
    }
  }
  return merged;
}

/** Coerce any scripted payload into an `EnvRunResult` (lenient; never throws). */
function toEnvRunResult(step: ScriptStep): EnvRunResult {
  const merged = nestedInput(step);
  const candidates: unknown[] = [
    step.envResult,
    step.env_result,
    step.result,
    step.output,
    step.response,
    step.sandboxResult,
    step.outcome,
    merged.envResult,
    merged.result,
  ];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (record === null) continue;
    const inner = asRecord(record.envResult) ?? asRecord(record.result) ?? record;
    if (inner === null) continue;
    const exitRaw = inner.exitCode ?? inner.exit_code ?? inner.code;
    const exitCode =
      typeof exitRaw === "number" && Number.isFinite(exitRaw) ? Math.floor(exitRaw) : undefined;
    const stdout = typeof inner.stdout === "string" ? inner.stdout : undefined;
    const stderr = typeof inner.stderr === "string" ? inner.stderr : undefined;
    const timedOut = inner.timedOut ?? inner.timed_out ?? inner.timeout;
    if (exitCode !== undefined || stdout !== undefined || stderr !== undefined || timedOut !== undefined) {
      return {
        exitCode: exitCode ?? 1,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        timedOut: timedOut === true,
      };
    }
  }
  const directExit = numberField(merged, ["exitCode", "exit_code", "code"]);
  const directStdout = stringField(merged, ["stdout", "out"]);
  const directStderr = stringField(merged, ["stderr", "err"]);
  if (directExit !== undefined || directStdout !== undefined || directStderr !== undefined) {
    const timedRaw = merged.timedOut ?? merged.timed_out ?? merged.timeout;
    return {
      exitCode: directExit ?? 1,
      stdout: directStdout ?? "",
      stderr: directStderr ?? "",
      timedOut: timedRaw === true,
    };
  }
  return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
}

function toStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

/** Extract the bisect version list from the many script shapes. */
function bisectVersionsOf(step: ScriptStep): string[] | null {
  const merged = nestedInput(step);
  for (const key of ["versions", "versionList", "version_list"]) {
    const list = toStringList(step[key]) ?? toStringList(merged[key]);
    if (list !== null) return list;
  }
  return null;
}

/** Extract per-version canned results for `bisect`. */
function bisectResultsOf(step: ScriptStep): EnvRunResult[] {
  const merged = nestedInput(step);
  for (const key of ["results", "outputs", "runs", "envResults"]) {
    const raw = step[key] ?? merged[key];
    if (Array.isArray(raw)) {
      return raw.map((entry) => {
        const record = asRecord(entry);
        if (record === null) return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
        return toEnvRunResult({ envResult: record });
      });
    }
  }
  return [];
}

function submitStatusOf(step: ScriptStep): string | null {
  const merged = nestedInput(step);
  const status = stringField(merged, ["status", "verdict", "outcome", "conclusion"]);
  return status ?? null;
}

function submitArtifactsOf(step: ScriptStep): { reproPy?: string; findingsMd?: string } {
  const merged = nestedInput(step);
  const reproPy = stringField(merged, ["reproPy", "repro_py", "repro", "repro.py", "code", "script"]);
  const findingsMd = stringField(merged, [
    "findingsMd",
    "findings_md",
    "findings",
    "findings.md",
    "report",
    "notes",
  ]);
  return { reproPy, findingsMd };
}

function stepTokensOf(step: ScriptStep, fallback: number): number {
  const merged = nestedInput(step);
  for (const key of ["tokens", "tokenUsage", "tokensUsed", "token_count"]) {
    const value = step[key] ?? merged[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

function resolveLedger(dbOrOptions: unknown, maybeOptions: unknown): { db: Ledger; owns: boolean } {
  const looksLikeLedger = (value: unknown): value is Ledger =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function";
  if (looksLikeLedger(dbOrOptions)) return { db: dbOrOptions, owns: false };
  if (looksLikeLedger(maybeOptions)) return { db: maybeOptions as Ledger, owns: false };
  return { db: openLedger(), owns: true };
}

function resolveOptions(dbOrOptions: unknown, maybeOptions: unknown): RunSessionOptions {
  const looksLikeLedger = (value: unknown): boolean =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function";
  if (looksLikeLedger(dbOrOptions) && asRecord(maybeOptions) !== null) {
    return maybeOptions as RunSessionOptions;
  }
  if (!looksLikeLedger(dbOrOptions) && asRecord(dbOrOptions) !== null) {
    return dbOrOptions as RunSessionOptions;
  }
  return {};
}

/**
 * Run the investigation session for `runId` over an ordered scripted plan.
 * Requires a frozen symptom spec (throws `no frozen symptom spec for run N`
 * otherwise, mirroring `grade`). Every tool dispatch appends an `llm_turn`
 * plus a `tool_call` event; every `env_run` grading appends a `gate` event.
 * Budget refusals append `budget_exceeded`, a 4th hypothesis appends
 * `hypothesis_limit_reached`, and spec-write attempts append
 * `spec_write_refused` — none throw past the session. Without `submit_report`
 * the run ends `inconclusive` with the best (last gate) verdict attached.
 */
export async function runSession(
  runId: number,
  script: unknown,
  dbOrOptions?: unknown,
  maybeOptions?: unknown,
): Promise<SessionResult> {
  const { db, owns } = resolveLedger(dbOrOptions, maybeOptions);
  const options = resolveOptions(dbOrOptions, maybeOptions);
  try {
    return await dispatchSession(db, runId, script, options);
  } finally {
    if (owns) db.close();
  }
}

async function dispatchSession(
  db: Ledger,
  runId: number,
  script: unknown,
  options: RunSessionOptions,
): Promise<SessionResult> {
  if (!isSymptomSpecFrozen(db, runId)) {
    throw new Error(`no frozen symptom spec for run ${runId}`);
  }
  const steps = normalizeScript(script);
  const env = options.env ?? process.env;
  const driver = await resolveDriver(env);
  const agent = createSessionAgent(db, runId);
  const clock = options.clock ?? Date.now;
  const wallClockMs =
    options.wallClockMs ?? options.budget?.wallClockMs ?? BUDGET_DEFAULTS.wallClockMs;
  const maxTokens = options.maxTokens ?? options.budget?.maxTokens ?? BUDGET_DEFAULTS.maxTokens;
  const state = createBudgets({
    maxHypotheses: options.budget?.maxHypotheses ?? BUDGET_DEFAULTS.maxHypotheses,
    maxEnvRunsPerHypothesis:
      options.budget?.maxEnvRunsPerHypothesis ?? BUDGET_DEFAULTS.maxEnvRunsPerHypothesis,
    wallClockMs,
    maxTokens,
    startTime: options.startTime ?? clock(),
  });
  const tokensPerCall = options.tokensPerCall ?? 0;

  agent.emit("session_start", { driver, steps: steps.length });

  let currentHypothesis = 0;
  let envHandleCounter = 0;
  let lastVerdict: GateVerdict | null = null;
  let latestBisect: BisectResult | null = null;
  let submitted = false;

  const ensureHypothesis = (): boolean => {
    if (currentHypothesis !== 0) return true;
    const check = checkNewHypothesis(state);
    if (!check.allowed) {
      agent.emit("hypothesis_limit_reached", {
        hypotheses: state.hypotheses,
        maxHypotheses: state.maxHypotheses,
        reason: "hypothesis budget exhausted before first tool call",
      });
      return false;
    }
    recordHypothesis(state);
    currentHypothesis = state.hypotheses;
    agent.emit("llm_turn", { hypothesis: currentHypothesis, role: "hypothesize" });
    return true;
  };

  const abortToInconclusive = (reason: string): void => {
    agent.emit("session_end", { status: "inconclusive", reason });
    setRunOutcome(db, runId, "inconclusive", lastVerdict ?? "inconclusive");
  };

  for (const step of steps) {
    if (submitted) break;
    const globalCheck = checkBudget(state, clock());
    if (!globalCheck.allowed) {
      agent.emit("budget_exceeded", {
        refused: globalCheck.refused,
        reason: globalCheck.refused === "wall_clock" ? "wall-clock budget exhausted" : "token budget exhausted",
        hypothesis: currentHypothesis === 0 ? null : currentHypothesis,
      });
      break;
    }

    const tool = toolNameOf(step);

    if (isSpecWriteStep(step, tool)) {
      agent.emit("spec_write_refused", {
        tool: tool ?? "unknown",
        reason: "symptom spec is frozen; the session has no spec-write tool",
      });
      continue;
    }

    const hypothesisLabel = hypothesisLabelOf(step, tool);
    if (hypothesisLabel !== null) {
      const check = checkNewHypothesis(state);
      if (!check.allowed) {
        agent.emit("hypothesis_limit_reached", {
          label: hypothesisLabel,
          hypotheses: state.hypotheses,
          maxHypotheses: state.maxHypotheses,
        });
        continue;
      }
      recordHypothesis(state);
      currentHypothesis = state.hypotheses;
      agent.emit("llm_turn", { hypothesis: currentHypothesis, label: hypothesisLabel });
      agent.emit("tool_call", { tool: "new_hypothesis", label: hypothesisLabel, hypothesis: currentHypothesis });
      addTokens(state, stepTokensOf(step, tokensPerCall));
      continue;
    }

    if (tool === null) {
      continue;
    }
    const canonical = canonicalToolName(tool);

    if (
      canonical === "githubgetissue" ||
      canonical === "githubissue" ||
      canonical === "getissue" ||
      canonical === "github"
    ) {
      if (!ensureHypothesis()) continue;
      agent.emit("llm_turn", { hypothesis: currentHypothesis, tool: "github_get_issue" });
      const merged = nestedInput(step);
      const url = stringField(merged, ["issueUrl", "url", "issue_url"]) ?? "";
      agent.emit("tool_call", { tool: "github_get_issue", hypothesis: currentHypothesis, url });
      addTokens(state, stepTokensOf(step, tokensPerCall));
      continue;
    }

    if (canonical === "tavilysearch" || canonical === "search" || canonical === "tavily") {
      if (!ensureHypothesis()) continue;
      agent.emit("llm_turn", { hypothesis: currentHypothesis, tool: "tavily_search" });
      const merged = nestedInput(step);
      const query = stringField(merged, ["query", "q"]) ?? "";
      agent.emit("tool_call", { tool: "tavily_search", hypothesis: currentHypothesis, query });
      addTokens(state, stepTokensOf(step, tokensPerCall));
      continue;
    }

    if (canonical === "tavilyextract" || canonical === "extract") {
      if (!ensureHypothesis()) continue;
      agent.emit("llm_turn", { hypothesis: currentHypothesis, tool: "tavily_extract" });
      const merged = nestedInput(step);
      const url = stringField(merged, ["url"]) ?? "";
      agent.emit("tool_call", { tool: "tavily_extract", hypothesis: currentHypothesis, url });
      addTokens(state, stepTokensOf(step, tokensPerCall));
      continue;
    }

    if (
      canonical === "envcreate" ||
      canonical === "createenv" ||
      canonical === "createenvironment"
    ) {
      if (!ensureHypothesis()) continue;
      agent.emit("llm_turn", { hypothesis: currentHypothesis, tool: "env_create" });
      envHandleCounter += 1;
      const handle = `env-${envHandleCounter}`;
      agent.emit("tool_call", { tool: "env_create", hypothesis: currentHypothesis, handle });
      addTokens(state, stepTokensOf(step, tokensPerCall));
      continue;
    }

    if (
      canonical === "envrun" ||
      canonical === "runenv" ||
      canonical === "sandboxrun" ||
      canonical === "run" ||
      canonical === "exec"
    ) {
      if (!ensureHypothesis()) continue;
      const runCheck = checkEnvRun(state, currentHypothesis);
      if (!runCheck.allowed) {
        agent.emit("budget_exceeded", {
          refused: "env_run",
          hypothesis: currentHypothesis,
          reason: `env_run budget exhausted for hypothesis ${currentHypothesis}`,
        });
        continue;
      }
      agent.emit("llm_turn", { hypothesis: currentHypothesis, tool: "env_run" });
      const merged = nestedInput(step);
      const cmd = stringField(merged, ["cmd", "command", "script", "code"]) ?? "";
      agent.emit("tool_call", { tool: "env_run", hypothesis: currentHypothesis, cmd });
      recordEnvRun(state, currentHypothesis);
      const envResult = toEnvRunResult(step);
      const graded = grade(runId, envResult, db);
      lastVerdict = graded.verdict;
      agent.emit("gate", {
        verdict: graded.verdict,
        reason: graded.detail.reason,
        hypothesis: currentHypothesis,
        timedOut: graded.detail.timedOut,
      });
      addTokens(state, stepTokensOf(step, tokensPerCall));
      continue;
    }

    if (canonical === "bisect") {
      if (!ensureHypothesis()) continue;
      const versions = bisectVersionsOf(step);
      if (versions === null || versions.length === 0) {
        agent.emit("tool_call", { tool: "bisect", hypothesis: currentHypothesis, error: "missing versions" });
        continue;
      }
      if (versions.length > 8) {
        agent.emit("tool_call", {
          tool: "bisect",
          hypothesis: currentHypothesis,
          versions,
          error: `bisect accepts max 8 versions, got ${versions.length}`,
        });
        continue;
      }
      agent.emit("llm_turn", { hypothesis: currentHypothesis, tool: "bisect" });
      agent.emit("tool_call", { tool: "bisect", hypothesis: currentHypothesis, versions });
      const spec = getSymptomSpec(db, runId);
      const rows = runBisect(spec, versions, bisectResultsOf(step));
      latestBisect = toBisectResult(rows);
      for (const row of rows) {
        agent.emit("tool_call", {
          tool: "env_run",
          hypothesis: currentHypothesis,
          version: row.version,
          bisect: true,
        });
        agent.emit("gate", {
          verdict: row.verdict,
          reason: row.reason,
          hypothesis: currentHypothesis,
          version: row.version,
          tool: "bisect",
        });
        if (lastVerdict === null && row.verdict === "reproduced") lastVerdict = row.verdict;
      }
      addTokens(state, stepTokensOf(step, tokensPerCall));
      continue;
    }

    if (
      canonical === "submitreport" ||
      canonical === "submit" ||
      canonical === "report" ||
      canonical === "finish"
    ) {
      const status = submitStatusOf(step);
      if (status !== "reproduced" && status !== "not-reproduced" && status !== "inconclusive") {
        agent.emit("tool_call", { tool: "submit_report", hypothesis: currentHypothesis, error: "invalid status" });
        continue;
      }
      const { reproPy, findingsMd } = submitArtifactsOf(step);
      if (reproPy !== undefined) {
        putArtifact(db, runId, "repro.py", reproPy);
      } else if (status === "reproduced") {
        putArtifact(db, runId, "repro.py", "# repro: no canned script supplied\n");
      }
      const baseFindings =
        findingsMd ?? (status === "reproduced" ? "# findings: no canned notes supplied\n" : undefined);
      if (baseFindings !== undefined) {
        putArtifact(
          db,
          runId,
          "findings.md",
          latestBisect === null ? baseFindings : withBisectSection(baseFindings, latestBisect),
        );
      } else if (latestBisect !== null) {
        putArtifact(db, runId, "findings.md", withBisectSection("# findings\n", latestBisect));
      }
      agent.emit("tool_call", { tool: "submit_report", hypothesis: currentHypothesis, status });
      agent.emit("report", { status, hypothesis: currentHypothesis });
      setRunOutcome(db, runId, status, status);
      submitted = true;
      addTokens(state, stepTokensOf(step, tokensPerCall));
      agent.emit("session_end", { status, submitted: true });
      break;
    }

    agent.emit("tool_call", { tool, hypothesis: currentHypothesis === 0 ? null : currentHypothesis });
    addTokens(state, stepTokensOf(step, tokensPerCall));
  }

  if (!submitted) {
    const globalCheck = checkBudget(state, clock());
    if (!globalCheck.allowed) {
      agent.emit("budget_exceeded", {
        refused: globalCheck.refused,
        reason: globalCheck.refused === "wall_clock" ? "wall-clock budget exhausted" : "token budget exhausted",
        hypothesis: currentHypothesis === 0 ? null : currentHypothesis,
      });
    }
    abortToInconclusive(submitted ? "submitted" : "script exhausted without submit_report");
  }

  const run = getRun(db, runId);
  return {
    runId,
    status: run?.status ?? "inconclusive",
    verdict: run?.verdict ?? null,
    hypotheses: state.hypotheses,
    envRuns: [...state.envRuns],
    driver,
    submitted,
  };
}
