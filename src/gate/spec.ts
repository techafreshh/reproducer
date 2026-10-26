/**
 * Symptom-spec gate: the TypeBox schema plus the freeze/latch boundary.
 *
 * `SymptomSpecSchema` is the single source of truth for the symptom spec
 * contract (PRD §10) and is shared with triage (issue #8). `freezeSymptomSpec`
 * validates and latches the spec once per run; any later freeze for the same
 * run throws `spec already frozen` — enforced at the gate, the ledger, and
 * inside SQLite.
 */
import { Type, type Static } from "@sinclair/typebox/type";
import { Check, Default } from "@sinclair/typebox/value";
import { Errors } from "@sinclair/typebox/errors";
import {
  isSymptomSpecFrozen,
  latchSymptomSpec,
  openLedger,
  type Ledger,
} from "../orchestrator/ledger.js";

/** One stack frame as a module + function pair. */
const FrameSchema = Type.Object({
  module: Type.String(),
  function: Type.String(),
});

export const SymptomSpecSchema = Type.Object({
  library: Type.String(),
  versions: Type.Array(Type.String()),
  symptomClass: Type.Union([
    Type.Literal("exception"),
    Type.Literal("wrong-output"),
    Type.Literal("hang"),
  ]),
  errorStrings: Type.Array(Type.String()),
  frames: Type.Array(FrameSchema),
  trigger: Type.String(),
  expectedOutput: Type.Union([Type.Null(), Type.Record(Type.String(), Type.Unknown())]),
  minMatchingFrames: Type.Optional(Type.Integer({ minimum: 1, default: 2 })),
});

export type SymptomSpec = Static<typeof SymptomSpecSchema>;

/** Validate an untrusted value against the schema; materializes `minMatchingFrames` default 2. */
export function validateSymptomSpec(spec: unknown): SymptomSpec {
  if (!Check(SymptomSpecSchema, spec)) {
    const detail = [...Errors(SymptomSpecSchema, spec)]
      .map((error) => {
        const path = error.path.startsWith("/") ? error.path.slice(1) : error.path;
        return `${path || "spec"} ${error.message}`;
      })
      .join("; ");
    throw new Error(`invalid symptom spec: ${detail}`);
  }
  return Default(SymptomSpecSchema, spec) as SymptomSpec;
}

/**
 * Validate and freeze a run's symptom spec — the latch.
 *
 * The freeze check runs before validation so a re-freeze throws the sentinel
 * regardless of the payload. With the default `db`, the ledger is opened at
 * DEFAULT_DB_PATH relative to the cwd, exactly like `npm start` — a two-arg
 * call shares the running dashboard's ledger.
 */
export function freezeSymptomSpec(runId: number, spec: unknown, db: Ledger = openLedger()): void {
  if (isSymptomSpecFrozen(db, runId)) {
    throw new Error("spec already frozen");
  }
  latchSymptomSpec(db, runId, validateSymptomSpec(spec));
}
