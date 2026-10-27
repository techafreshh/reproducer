import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTokens,
  BUDGET_DEFAULTS,
  checkBudget,
  checkEnvRun,
  checkNewHypothesis,
  createBudgets,
  recordEnvRun,
  recordHypothesis,
} from "./budgets.js";

describe("budgets", () => {
  it("exposes the pinned defaults (3 hypotheses, 8 runs, 20 min, 100k tokens)", () => {
    expect(BUDGET_DEFAULTS.maxHypotheses).toBe(3);
    expect(BUDGET_DEFAULTS.maxEnvRunsPerHypothesis).toBe(8);
    expect(BUDGET_DEFAULTS.wallClockMs).toBe(20 * 60 * 1000);
    expect(BUDGET_DEFAULTS.maxTokens).toBe(100000);
  });

  it("allows exactly 8 env_runs per hypothesis and refuses the 9th", () => {
    const state = createBudgets();
    recordHypothesis(state);
    for (let i = 0; i < 8; i++) {
      expect(checkEnvRun(state, 1)).toEqual({ allowed: true });
      recordEnvRun(state, 1);
    }
    expect(checkEnvRun(state, 1)).toEqual({ allowed: false, refused: "env_run" });
  });

  it("scopes env_run counts per hypothesis", () => {
    const state = createBudgets();
    recordHypothesis(state);
    recordHypothesis(state);
    for (let i = 0; i < 8; i++) recordEnvRun(state, 1);
    expect(checkEnvRun(state, 1)).toEqual({ allowed: false, refused: "env_run" });
    expect(checkEnvRun(state, 2)).toEqual({ allowed: true });
  });

  it("allows 3 hypotheses and refuses the 4th", () => {
    const state = createBudgets();
    for (let i = 0; i < 3; i++) {
      expect(checkNewHypothesis(state)).toEqual({ allowed: true });
      recordHypothesis(state);
    }
    expect(checkNewHypothesis(state)).toEqual({ allowed: false, refused: "hypothesis" });
  });

  it("refuses on an expired wall-clock deadline", () => {
    const state = createBudgets({ startTime: Date.now() - BUDGET_DEFAULTS.wallClockMs - 1 });
    expect(checkBudget(state)).toEqual({ allowed: false, refused: "wall_clock" });
  });

  it("allows before the deadline and honors an overridden wallClockMs", () => {
    const state = createBudgets({ wallClockMs: 60_000 });
    expect(checkBudget(state)).toEqual({ allowed: true });
    const expired = createBudgets({ wallClockMs: 0 });
    expect(checkBudget(expired, expired.startTime)).toEqual({ allowed: false, refused: "wall_clock" });
  });

  it("refuses once token usage reaches the cap", () => {
    const state = createBudgets({ maxTokens: 10 });
    expect(checkBudget(state)).toEqual({ allowed: true });
    addTokens(state, 10);
    expect(checkBudget(state)).toEqual({ allowed: false, refused: "tokens" });
  });

  it("ignores non-positive token additions", () => {
    const state = createBudgets({ maxTokens: 1 });
    addTokens(state, 0);
    addTokens(state, -5);
    expect(checkBudget(state)).toEqual({ allowed: true });
  });
});
