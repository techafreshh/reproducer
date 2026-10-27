/**
 * Budget latches for the investigation session: hard caps that abort honestly
 * to `inconclusive` instead of burning tokens or hosts.
 *
 * The state is a plain in-memory object (no ledger I/O): hypothesis count,
 * per-hypothesis `env_run` counts, a wall-clock deadline, and a token
 * counter. Checkers are pure — they never mutate — while `record*` mutators
 * advance the counters after an allowed dispatch. Refusals never throw past
 * the session; the session appends a ledger event and refuses the call.
 */

export const BUDGET_DEFAULTS = {
  maxHypotheses: 3,
  maxEnvRunsPerHypothesis: 8,
  wallClockMs: 20 * 60 * 1000,
  maxTokens: 100000,
} as const;

/** Tunable limits; every field falls back to `BUDGET_DEFAULTS`. */
export interface BudgetLimits {
  maxHypotheses: number;
  maxEnvRunsPerHypothesis: number;
  wallClockMs: number;
  maxTokens: number;
}

/** Live latch state: limits plus counters and the wall-clock deadline. */
export interface BudgetState extends BudgetLimits {
  hypotheses: number;
  envRuns: number[];
  startTime: number;
  tokensUsed: number;
}

export type BudgetRefusal = "hypothesis" | "env_run" | "wall_clock" | "tokens";

export type BudgetCheck = { allowed: true } | { allowed: false; refused: BudgetRefusal };

/** Overrides for `createBudgets`: any limit plus an explicit start/token seed (tests). */
export interface BudgetOverrides extends Partial<BudgetLimits> {
  startTime?: number;
  tokensUsed?: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Fresh latch state; `startTime` defaults to `Date.now()`. */
export function createBudgets(overrides: BudgetOverrides = {}): BudgetState {
  return {
    maxHypotheses: finiteOr(overrides.maxHypotheses, BUDGET_DEFAULTS.maxHypotheses),
    maxEnvRunsPerHypothesis: finiteOr(
      overrides.maxEnvRunsPerHypothesis,
      BUDGET_DEFAULTS.maxEnvRunsPerHypothesis,
    ),
    wallClockMs: finiteOr(overrides.wallClockMs, BUDGET_DEFAULTS.wallClockMs),
    maxTokens: finiteOr(overrides.maxTokens, BUDGET_DEFAULTS.maxTokens),
    hypotheses: 0,
    envRuns: [],
    startTime: finiteOr(overrides.startTime, Date.now()),
    tokensUsed: finiteOr(overrides.tokensUsed, 0),
  };
}

/** Whether `tokensUsed` has reached the cap. */
function tokensExhausted(state: BudgetState): boolean {
  return state.tokensUsed >= state.maxTokens;
}

/** Whether the wall-clock deadline has passed at `now`. */
function deadlinePassed(state: BudgetState, now: number): boolean {
  return now - state.startTime >= state.wallClockMs;
}

/**
 * Global latch: wall-clock then token cap. Checked before every tool
 * dispatch; a refusal aborts the session to `inconclusive`.
 */
export function checkBudget(state: BudgetState, now: number = Date.now()): BudgetCheck {
  if (deadlinePassed(state, now)) {
    return { allowed: false, refused: "wall_clock" };
  }
  if (tokensExhausted(state)) {
    return { allowed: false, refused: "tokens" };
  }
  return { allowed: true };
}

/** Hypothesis latch: at most `maxHypotheses` per run; the 4th is refused. */
export function checkNewHypothesis(state: BudgetState): BudgetCheck {
  if (state.hypotheses >= state.maxHypotheses) {
    return { allowed: false, refused: "hypothesis" };
  }
  return { allowed: true };
}

/**
 * Per-hypothesis `env_run` latch: at most `maxEnvRunsPerHypothesis` runs
 * under one hypothesis; the 9th call for that hypothesis is refused.
 * `hypothesis` is 1-indexed; unknown indexes read as 0 recorded runs.
 */
export function checkEnvRun(state: BudgetState, hypothesis: number): BudgetCheck {
  const recorded = state.envRuns[hypothesis - 1] ?? 0;
  if (recorded >= state.maxEnvRunsPerHypothesis) {
    return { allowed: false, refused: "env_run" };
  }
  return { allowed: true };
}

/** Record an allowed hypothesis; no-op when already at the cap. */
export function recordHypothesis(state: BudgetState): void {
  if (state.hypotheses >= state.maxHypotheses) return;
  state.hypotheses += 1;
  state.envRuns.push(0);
}

/** Record an allowed `env_run` under 1-indexed `hypothesis`. */
export function recordEnvRun(state: BudgetState, hypothesis: number): void {
  const index = hypothesis - 1;
  if (index < 0 || index >= state.envRuns.length) return;
  state.envRuns[index] = (state.envRuns[index] ?? 0) + 1;
}

/** Add consumed tokens (live LLM accounting; scripted runs stay at 0). */
export function addTokens(state: BudgetState, count: number): void {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return;
  state.tokensUsed += Math.floor(count);
}

/** Snapshot for the ledger `budget` column / dashboard burn display. */
export function snapshotBudget(state: BudgetState): Record<string, unknown> {
  return {
    maxHypotheses: state.maxHypotheses,
    maxEnvRunsPerHypothesis: state.maxEnvRunsPerHypothesis,
    hypotheses: state.hypotheses,
    envRuns: [...state.envRuns],
    tokensUsed: state.tokensUsed,
    maxTokens: state.maxTokens,
  };
}
