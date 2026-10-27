/**
 * Minimal `bisect` tool: a version-matrix runner over the verified repro.
 *
 * Full PyPI enumeration lands with the bisect issue; here the tool accepts an
 * explicit version list (at most 8, mirroring the per-hypothesis sandbox
 * budget) and grades one canned `env_run` result per version through the
 * frozen-spec gate. The session re-exports this as its `bisect` tool so the
 * full logic can land later without changing the session dispatch.
 */
import { Type, type Static } from "@sinclair/typebox/type";
import { gradeAgainstSpec, type EnvRunResult, type GateVerdict } from "../../gate/gate.js";
import { validateSymptomSpec } from "../../gate/spec.js";

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

/**
 * Grade one canned result per version against an already-validated spec.
 * `results` may be shorter than `versions`; missing entries grade as
 * `inconclusive` (trigger never reached) rather than throwing. Throws when
 * `versions` is empty or longer than 8.
 */
export function runBisect(
  spec: unknown,
  versions: string[],
  results: EnvRunResult[] = [],
): BisectRow[] {
  if (versions.length === 0) {
    throw new Error("bisect requires at least one version");
  }
  if (versions.length > 8) {
    throw new Error("bisect versions exceed 8");
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
