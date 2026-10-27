/**
 * `bisect` tool: a version-matrix runner over the verified repro.
 *
 * The frozen symptom spec stands in for the verified repro script: `runBisect`
 * grades one canned `env_run` result per version through the frozen-spec gate,
 * `bisect` wraps the rows into a `{lastGood, firstBad, rows}` boundary, and
 * `chooseBisectVersions` slices the reported→latest PyPI window down to ≤8
 * evenly spanning entries. No network, no pip installs — version listing stays
 * behind the `PypiClient` seam so keyless CI proves the orchestration.
 */
import { Type, type Static } from "@sinclair/typebox/type";
import { gradeAgainstSpec, type EnvRunResult, type GateVerdict } from "../../gate/gate.js";
import { validateSymptomSpec } from "../../gate/spec.js";
import { comparePep440, listVersions } from "../../sandbox/pypi.js";
import type { PypiClient } from "../../sandbox/pypi-client.js";

export const BisectInputSchema = Type.Object({
  versions: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
  package: Type.Optional(Type.String()),
});

export type BisectInput = Static<typeof BisectInputSchema>;

/** One graded row of the bisect table. */
export interface BisectRow {
  version: string;
  verdict: GateVerdict;
  reason: string;
}

/** Regression boundary over a graded version matrix. */
export interface BisectResult {
  rows: BisectRow[];
  /** Nearest non-`reproduced` version before `firstBad`, else null. */
  lastGood: string | null;
  /** First version in input order grading `reproduced`, else null. */
  firstBad: string | null;
}

/**
 * Fold graded rows into a regression boundary: `firstBad` is the first row
 * in input order grading `reproduced`; `lastGood` is the nearest preceding
 * non-`reproduced` row, else null. With no `reproduced` row, `firstBad` is
 * null and `lastGood` is the last row's version (null when empty).
 */
export function toBisectResult(rows: BisectRow[]): BisectResult {
  const firstBadIndex = rows.findIndex((row) => row.verdict === "reproduced");
  if (firstBadIndex === -1) {
    return {
      rows,
      lastGood: rows.length > 0 ? (rows[rows.length - 1]?.version ?? null) : null,
      firstBad: null,
    };
  }
  const firstBad = rows[firstBadIndex]?.version ?? null;
  let lastGood: string | null = null;
  for (let i = firstBadIndex - 1; i >= 0; i--) {
    const row = rows[i];
    if (row !== undefined && row.verdict !== "reproduced") {
      lastGood = row.version;
      break;
    }
  }
  return { rows, lastGood, firstBad };
}

/**
 * Grade one canned result per version against an already-validated spec.
 * `results` may be shorter than `versions`; missing entries grade as
 * `inconclusive` (trigger never reached) rather than throwing. Throws
 * `bisect accepts max 8 versions, got N` when `versions` is empty or longer
 * than 8 — the message always carries the `max 8 versions` sentinel the
 * session surfaces without running any sandbox command.
 */
export function runBisect(
  spec: unknown,
  versions: string[],
  results: EnvRunResult[] = [],
): BisectRow[] {
  if (versions.length === 0 || versions.length > 8) {
    throw new Error(`bisect accepts max 8 versions, got ${versions.length}`);
  }
  const validated = validateSymptomSpec(spec);
  return versions.map((version, index) => {
    const envResult: EnvRunResult = results[index] ?? {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
    };
    const graded = gradeAgainstSpec(validated, {
      exitCode: envResult.exitCode,
      stdout: envResult.stdout ?? "",
      stderr: envResult.stderr ?? "",
      timedOut: envResult.timedOut === true,
    });
    return { version, verdict: graded.verdict, reason: graded.detail.reason };
  });
}

/**
 * Issue entry point: grade the verified repro (its frozen spec) across
 * `versions` and return the `{lastGood, firstBad, rows}` boundary. The spec
 * stands in for the `reproScript` — the session already holds the frozen
 * spec, so callers pass it directly plus one canned `EnvRunResult` per
 * version.
 */
export function bisect(
  spec: unknown,
  versions: string[],
  results: EnvRunResult[] = [],
): BisectResult {
  return toBisectResult(runBisect(spec, versions, results));
}

/**
 * Slice the reported→latest installable window down to ≤8 evenly spanning
 * versions: lists pure-Python versions via `listVersions`, keeps the window
 * where `reported <= v <= latest` (or from `reported` to the newest when
 * `latest` is absent), and evenly samples `max` entries including both
 * endpoints when the window is longer. Pure — network stays behind `client`.
 */
export async function chooseBisectVersions(
  client: PypiClient,
  pkg: string,
  reported: string,
  latest?: string,
  max = 8,
): Promise<string[]> {
  const all = await listVersions(client, pkg);
  const window = all.filter(
    (version) =>
      comparePep440(version, reported) >= 0 &&
      (latest === undefined || comparePep440(version, latest) <= 0),
  );
  if (window.length <= max) return window;
  if (max <= 0) return [];
  if (max === 1) return window.slice(0, 1);
  const picked: string[] = [];
  for (let i = 0; i < max; i++) {
    const index = Math.round((i * (window.length - 1)) / (max - 1));
    const version = window[index];
    if (version !== undefined && !picked.includes(version)) picked.push(version);
  }
  return picked;
}

/** Markdown rows for a bisect result: header plus one `| version | verdict |` row each. */
export function renderBisectTable(result: BisectResult): string {
  const lines = ["| version | verdict |", "| --- | --- |"];
  for (const row of result.rows) {
    lines.push(`| ${row.version} | ${row.verdict} |`);
  }
  return lines.join("\n");
}
