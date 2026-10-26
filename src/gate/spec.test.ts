import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSymptomSpec,
  isSymptomSpecFrozen,
  openLedger,
  type Ledger,
} from "../orchestrator/ledger.js";
import { freezeSymptomSpec, SymptomSpecSchema, validateSymptomSpec } from "./spec.js";

/** PRD §10 reference spec for library `lib`. */
const VALID = {
  library: "lib",
  versions: ["2.2.0"],
  symptomClass: "exception",
  errorStrings: ["boom"],
  frames: [{ module: "lib/core.js", function: "parse" }],
  trigger: "parse('')",
  expectedOutput: null,
};

describe("validateSymptomSpec", () => {
  it("accepts the PRD §10 spec and materializes default minMatchingFrames 2", () => {
    expect(validateSymptomSpec(VALID)).toEqual({ ...VALID, minMatchingFrames: 2 });
  });

  it("passes an explicit minMatchingFrames through", () => {
    expect(validateSymptomSpec({ ...VALID, minMatchingFrames: 3 }).minMatchingFrames).toBe(3);
  });

  it("accepts every legal symptomClass", () => {
    for (const symptomClass of ["exception", "wrong-output", "hang"]) {
      expect(validateSymptomSpec({ ...VALID, symptomClass }).symptomClass).toBe(symptomClass);
    }
  });

  it("rejects unknown symptomClass crash naming the field", () => {
    expect(() => validateSymptomSpec({ ...VALID, symptomClass: "crash" })).toThrow(/symptomClass/);
  });

  it("rejects a spec without frames naming the field", () => {
    const withoutFrames: Record<string, unknown> = { ...VALID };
    delete withoutFrames.frames;
    expect(() => validateSymptomSpec(withoutFrames)).toThrow(/frames/);
  });

  it("rejects a non-positive minMatchingFrames naming the field", () => {
    expect(() => validateSymptomSpec({ ...VALID, minMatchingFrames: 0 })).toThrow(/minMatchingFrames/);
  });

  it("accepts expectedOutput as object or null, rejecting other types", () => {
    expect(validateSymptomSpec({ ...VALID, expectedOutput: { exit: 1 } }).expectedOutput).toEqual({ exit: 1 });
    expect(validateSymptomSpec({ ...VALID, expectedOutput: null }).expectedOutput).toBeNull();
    expect(() => validateSymptomSpec({ ...VALID, expectedOutput: "null" })).toThrow(/expectedOutput/);
  });

  it("rejects a non-object spec", () => {
    expect(() => validateSymptomSpec("nope")).toThrow(/^invalid symptom spec: /);
  });

  it("exposes the schema for triage to reuse (issue #8)", () => {
    expect(SymptomSpecSchema.type).toBe("object");
  });
});

describe("freezeSymptomSpec", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("freezes a valid spec, readable with the materialized default", () => {
    freezeSymptomSpec(1, VALID, db);
    expect(isSymptomSpecFrozen(db, 1)).toBe(true);
    expect(getSymptomSpec(db, 1)).toEqual({ ...VALID, minMatchingFrames: 2 });
  });

  it("throws exactly the sentinel on a second freeze and keeps the stored spec", () => {
    freezeSymptomSpec(1, VALID, db);
    try {
      freezeSymptomSpec(1, { ...VALID, symptomClass: "hang", errorStrings: ["changed"] }, db);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("spec already frozen");
    }
    expect(getSymptomSpec(db, 1)).toEqual({ ...VALID, minMatchingFrames: 2 });
  });

  it("checks the latch before validating the payload", () => {
    freezeSymptomSpec(1, VALID, db);
    try {
      // The payload is invalid too — the freeze sentinel must win.
      freezeSymptomSpec(1, { nonsense: true }, db);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("spec already frozen");
    }
    expect(getSymptomSpec(db, 1)).toEqual({ ...VALID, minMatchingFrames: 2 });
  });

  it("rejects an invalid spec without latching", () => {
    expect(() => freezeSymptomSpec(1, { ...VALID, symptomClass: "crash" }, db)).toThrow(/symptomClass/);
    expect(isSymptomSpecFrozen(db, 1)).toBe(false);
    expect(getSymptomSpec(db, 1)).toBeNull();
  });

  it("freezes runs independently", () => {
    const other = { ...VALID, library: "other" };
    freezeSymptomSpec(1, VALID, db);
    freezeSymptomSpec(2, other, db);
    expect(isSymptomSpecFrozen(db, 1)).toBe(true);
    expect(isSymptomSpecFrozen(db, 2)).toBe(true);
    expect(getSymptomSpec(db, 2)).toEqual({ ...other, minMatchingFrames: 2 });
  });
});
