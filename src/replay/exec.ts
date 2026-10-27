/**
 * Shared python executor for offline replay paths.
 *
 * Runs a repro script with the real `python3`, graded exactly like the
 * delivered artifact: written to a temp file named `repro.py` so parsed
 * traceback frames carry the `repro.py` module basename the symptom specs
 * pin. `src/orchestrator/demo-run.ts` re-exports this helper so the legacy
 * `--scripted` path and the `--replay` runner share one implementation.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvRunResult } from "../gate/gate.js";

/** Hard timeout for each graded python execution (the `--scripted` default). */
export const PYTHON_TIMEOUT_MS = 60000;

/** Submitted `repro.py` must stay within this many total lines. */
export const MAX_ARTIFACT_LINES = 60;

/** The shrink target: minimal repro must fit this many non-empty lines. */
export const MAX_MINIMAL_NON_EMPTY_LINES = 20;

/** Lines carrying code or prose; blank lines never count toward the shrink budget. */
export function countNonEmptyLines(script: string): number {
  let count = 0;
  for (const line of script.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
}

/** Drop blank lines and full-line `#` comments for the shrink fallback. */
export function stripCommentsAndBlanks(script: string): string {
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
 * Run a repro script with the real `python3` (stdlib only, offline). A genuine
 * hang that outlives `timeoutMs` is killed and reported as `timedOut`, which
 * is exactly how the gate grades the `hang` symptom class.
 */
export function executePythonScript(script: string, timeoutMs: number = PYTHON_TIMEOUT_MS): EnvRunResult {
  const dir = mkdtempSync(join(tmpdir(), "reproducer-replay-"));
  try {
    const file = join(dir, "repro.py");
    writeFileSync(file, script);
    const result = spawnSync("python3", [file], {
      encoding: "utf-8",
      timeout: timeoutMs,
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
