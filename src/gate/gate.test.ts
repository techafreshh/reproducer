import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRun, putSymptomSpec, openLedger, type Ledger } from "../orchestrator/ledger.js";
import { freezeSymptomSpec, validateSymptomSpec } from "./spec.js";
import { grade, gradeAgainstSpec, type EnvRunResult } from "./gate.js";

/** Acceptance exception spec: ValueError, two pinned frames, minMatchingFrames 2. */
const EXCEPTION_RAW = {
  library: "lib",
  versions: ["2.2.0"],
  symptomClass: "exception",
  errorStrings: ["ValueError: bad value"],
  frames: [
    { module: "cli.py", function: "<module>" },
    { module: "core.py", function: "parse" },
  ],
  trigger: "parse('')",
  expectedOutput: null,
  minMatchingFrames: 2,
};

const EXCEPTION_SPEC = validateSymptomSpec(EXCEPTION_RAW);

/** Real CPython stderr for the acceptance spec: ValueError plus both pinned frames. */
const VALUE_ERROR_STDERR = [
  "Traceback (most recent call last):",
  '  File "/app/cli.py", line 14, in <module>',
  "    run()",
  '  File "/app/core.py", line 7, in parse',
  '    raise ValueError("bad value")',
  "ValueError: bad value",
].join("\n");

const CRASH: EnvRunResult = { exitCode: 1, stdout: "", stderr: VALUE_ERROR_STDERR, timedOut: false };

const KEY_ERROR_STDERR = [
  "Traceback (most recent call last):",
  '  File "/app/cli.py", line 14, in <module>',
  "    run()",
  "KeyError: x",
].join("\n");

// No traceback header: exactly the kind of stderr a broken env produces.
const IMPORT_FAILURE_STDERR = "ModuleNotFoundError: No module named 'pkg'";

const ONE_MATCHING_FRAME_STDERR = [
  "Traceback (most recent call last):",
  '  File "/app/cli.py", line 14, in <module>',
  '  File "/app/util.py", line 3, in helper',
  "ValueError: bad value",
].join("\n");

const DOTTED_CLASS_STDERR = [
  "Traceback (most recent call last):",
  '  File "/app/config.py", line 51, in bootstrap',
  "    cfg = load(path)",
  '  File "/app/config.py", line 35, in load',
  '    raise ConfigError(f"missing section {key!r}") from key',
  "config.ConfigError: missing section 'timeouts'",
].join("\n");

const DOTTED_CLASS_SPEC = validateSymptomSpec({
  library: "lib",
  versions: ["2.2.0"],
  symptomClass: "exception",
  errorStrings: ["config.ConfigError: missing section 'timeouts'"],
  frames: [
    { module: "config.py", function: "bootstrap" },
    { module: "config.py", function: "load" },
  ],
  trigger: "load(path)",
  expectedOutput: null,
});

const TYPE_ERROR_STDERR = [
  "Traceback (most recent call last):",
  '  File "/app/core.py", line 7, in parse',
  '  File "/app/geom.py", line 2, in unit',
  "TypeError: unsupported operand",
].join("\n");

/** Lowercase-only errorStrings: message fragments, never class candidates. */
const LOWERCASE_FRAMES_SPEC = validateSymptomSpec({
  library: "lib",
  versions: ["2.2.0"],
  symptomClass: "exception",
  errorStrings: ["boom"],
  frames: [
    { module: "core.py", function: "parse" },
    { module: "geom.py", function: "unit" },
  ],
  trigger: "parse('')",
  expectedOutput: null,
});

const WRONG_OUTPUT_SPEC = validateSymptomSpec({
  library: "lib",
  versions: ["2.2.0"],
  symptomClass: "wrong-output",
  errorStrings: [],
  frames: [],
  trigger: "render()",
  // Symptom entries a buggy run emits: strings verbatim, numbers as JSON.
  expectedOutput: { line: "total = 42", footer: "DONE", exit: 42 },
});

const HANG_SPEC = validateSymptomSpec({
  library: "lib",
  versions: ["2.2.0"],
  symptomClass: "hang",
  errorStrings: [],
  frames: [],
  trigger: "poll()",
  expectedOutput: null,
});

describe("grade (frozen-ledger path)", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("grades a ValueError run reproduced against the frozen spec (acceptance)", () => {
    freezeSymptomSpec(1, EXCEPTION_RAW, db);
    const result = grade(1, CRASH, db);
    expect(result.verdict).toBe("reproduced");
    expect(result.detail).toMatchObject({
      symptomClass: "exception",
      parsedExceptionType: "ValueError",
      expectedExceptionType: "ValueError",
      matchingFrames: 2,
      requiredFrames: 2,
    });
  });

  it("throws exactly the sentinel for an unknown run id", () => {
    expect(() => grade(999, CRASH, db)).toThrow(/^no frozen symptom spec for run 999$/);
  });

  it("throws when the run exists but its spec was never frozen", () => {
    insertRun(db, "https://example.com/issues/6");
    expect(() => grade(1, CRASH, db)).toThrow(/^no frozen symptom spec for run 1$/);
  });

  it("never grades against an unfrozen draft spec", () => {
    insertRun(db, "https://example.com/issues/6");
    putSymptomSpec(db, 1, EXCEPTION_RAW);
    expect(() => grade(1, CRASH, db)).toThrow(/^no frozen symptom spec for run 1$/);
    freezeSymptomSpec(1, EXCEPTION_RAW, db);
    expect(grade(1, CRASH, db).verdict).toBe("reproduced");
  });
});

describe("gradeAgainstSpec exception class", () => {
  it("grades a different exception type not-reproduced (acceptance)", () => {
    const result = gradeAgainstSpec(EXCEPTION_SPEC, {
      exitCode: 1,
      stdout: "",
      stderr: KEY_ERROR_STDERR,
      timedOut: false,
    });
    expect(result.verdict).toBe("not-reproduced");
    expect(result.detail).toMatchObject({
      parsedExceptionType: "KeyError",
      expectedExceptionType: "ValueError",
    });
  });

  it("grades an import/module-not-found failure inconclusive (acceptance)", () => {
    const result = gradeAgainstSpec(EXCEPTION_SPEC, {
      exitCode: 1,
      stdout: "",
      stderr: IMPORT_FAILURE_STDERR,
      timedOut: false,
    });
    expect(result.verdict).toBe("inconclusive");
    expect(result.detail.reason).toContain("trigger never reached");
    expect(result.detail.parsedExceptionType).toBeNull();
  });

  it("grades an exit-0 run inconclusive even with a traceback printed", () => {
    const result = gradeAgainstSpec(EXCEPTION_SPEC, { exitCode: 0, stdout: "", stderr: VALUE_ERROR_STDERR, timedOut: false });
    expect(result.verdict).toBe("inconclusive");
    expect(result.detail.reason).toContain("exited 0");
  });

  it("grades a stderr without a recognizable traceback not-reproduced", () => {
    const result = gradeAgainstSpec(EXCEPTION_SPEC, {
      exitCode: 1,
      stdout: "",
      stderr: "Segmentation fault (core dumped)",
      timedOut: false,
    });
    expect(result.verdict).toBe("not-reproduced");
  });

  it("requires minMatchingFrames: one matching frame of two grades not-reproduced", () => {
    const result = gradeAgainstSpec(EXCEPTION_SPEC, {
      exitCode: 1,
      stdout: "",
      stderr: ONE_MATCHING_FRAME_STDERR,
      timedOut: false,
    });
    expect(result.verdict).toBe("not-reproduced");
    expect(result.detail.matchingFrames).toBe(1);
    expect(result.detail.requiredFrames).toBe(2);
  });

  it("matches a dotted exception class by its last segment", () => {
    const result = gradeAgainstSpec(DOTTED_CLASS_SPEC, {
      exitCode: 1,
      stdout: "",
      stderr: DOTTED_CLASS_STDERR,
      timedOut: false,
    });
    expect(result.verdict).toBe("reproduced");
    expect(result.detail.parsedExceptionType).toBe("config.ConfigError");
    expect(result.detail.expectedExceptionType).toBe("ConfigError");
  });

  it("never lets a word mention of the parsed class override the derived expected class", () => {
    // "ConfigError" is the derivable expected class; ValueError only appears
    // in the message prose and must not count as the expected class.
    const spec = validateSymptomSpec({
      ...EXCEPTION_RAW,
      errorStrings: ["ConfigError: want ConfigError, got ValueError"],
    });
    const result = gradeAgainstSpec(spec, { exitCode: 1, stdout: "", stderr: VALUE_ERROR_STDERR, timedOut: false });
    expect(result.verdict).toBe("not-reproduced");
    expect(result.detail).toMatchObject({
      parsedExceptionType: "ValueError",
      expectedExceptionType: "ConfigError",
    });
  });

  it("still pins the class by word mention when no leading token derives one", () => {
    const spec = validateSymptomSpec({
      ...EXCEPTION_RAW,
      errorStrings: ["raises ValueError on empty input"],
    });
    const result = gradeAgainstSpec(spec, { exitCode: 1, stdout: "", stderr: VALUE_ERROR_STDERR, timedOut: false });
    expect(result.verdict).toBe("reproduced");
    expect(result.detail.expectedExceptionType).toBeNull();
  });

  it("counts every parsed frame landing on a pinned pair, recursion included", () => {
    const spec = validateSymptomSpec({
      ...EXCEPTION_RAW,
      frames: [{ module: "core.py", function: "parse" }],
      minMatchingFrames: 2,
    });
    const recursionStderr = [
      "Traceback (most recent call last):",
      '  File "/app/cli.py", line 14, in <module>',
      '  File "/app/core.py", line 7, in parse',
      '  File "/app/core.py", line 7, in parse',
      "ValueError: bad value",
    ].join("\n");
    const result = gradeAgainstSpec(spec, { exitCode: 1, stdout: "", stderr: recursionStderr, timedOut: false });
    expect(result.verdict).toBe("reproduced");
    expect(result.detail).toMatchObject({ matchingFrames: 2, requiredFrames: 2 });
  });

  it("never double-credits a parsed frame against duplicated spec entries", () => {
    const spec = validateSymptomSpec({
      ...EXCEPTION_RAW,
      frames: [
        { module: "core.py", function: "parse" },
        { module: "core.py", function: "parse" },
      ],
      minMatchingFrames: 2,
    });
    const singleHitStderr = [
      "Traceback (most recent call last):",
      '  File "/app/core.py", line 7, in parse',
      "ValueError: bad value",
    ].join("\n");
    const result = gradeAgainstSpec(spec, { exitCode: 1, stdout: "", stderr: singleHitStderr, timedOut: false });
    expect(result.verdict).toBe("not-reproduced");
    expect(result.detail.matchingFrames).toBe(1);
  });

  it("falls back to frames-only grading when no class is derivable from errorStrings", () => {
    const result = gradeAgainstSpec(LOWERCASE_FRAMES_SPEC, {
      exitCode: 1,
      stdout: "",
      stderr: TYPE_ERROR_STDERR,
      timedOut: false,
    });
    expect(result.verdict).toBe("reproduced");
    expect(result.detail.expectedExceptionType).toBeNull();
    expect(result.detail.matchingFrames).toBe(2);
  });

  it("grades inconclusive when the spec pins no class and no frames", () => {
    const spec = validateSymptomSpec({ ...LOWERCASE_FRAMES_SPEC, frames: [] });
    const result = gradeAgainstSpec(spec, {
      exitCode: 1,
      stdout: "",
      stderr: TYPE_ERROR_STDERR,
      timedOut: false,
    });
    expect(result.verdict).toBe("inconclusive");
  });

  it("grades class-only when spec.frames is empty and the class matches", () => {
    const spec = validateSymptomSpec({ ...EXCEPTION_RAW, frames: [] });
    const result = gradeAgainstSpec(spec, {
      exitCode: 1,
      stdout: "",
      stderr: ONE_MATCHING_FRAME_STDERR,
      timedOut: false,
    });
    expect(result.verdict).toBe("reproduced");
    expect(result.detail).toMatchObject({ matchingFrames: 0, requiredFrames: 0 });
  });
});

describe("gradeAgainstSpec wrong-output", () => {
  it("grades reproduced when stdout contains every expected symptom entry", () => {
    const result = gradeAgainstSpec(WRONG_OUTPUT_SPEC, {
      exitCode: 0,
      stdout: "  total =  42\nDONE\ncode 42\n",
      stderr: "",
      timedOut: false,
    });
    expect(result.verdict).toBe("reproduced");
    expect(result.detail).toMatchObject({ outputMatched: 3, outputRequired: 3 });
  });

  it("grades not-reproduced when an expected entry is missing from stdout", () => {
    const result = gradeAgainstSpec(WRONG_OUTPUT_SPEC, {
      exitCode: 0,
      stdout: "DONE\n",
      stderr: "",
      timedOut: false,
    });
    expect(result.verdict).toBe("not-reproduced");
    expect(result.detail).toMatchObject({ outputMatched: 1, outputRequired: 3 });
  });

  it("grades inconclusive when the spec pins no expected output", () => {
    const nullSpec = validateSymptomSpec({ ...WRONG_OUTPUT_SPEC, expectedOutput: null });
    const emptySpec = validateSymptomSpec({ ...WRONG_OUTPUT_SPEC, expectedOutput: {} });
    for (const spec of [nullSpec, emptySpec]) {
      const result = gradeAgainstSpec(spec, { exitCode: 0, stdout: "anything", stderr: "", timedOut: false });
      expect(result.verdict, JSON.stringify(spec.expectedOutput)).toBe("inconclusive");
    }
  });

  it("grades a non-zero exit inconclusive: the crash short-circuits the output", () => {
    const result = gradeAgainstSpec(WRONG_OUTPUT_SPEC, {
      exitCode: 1,
      stdout: "total = 42\nDONE\ncode 42\n",
      stderr: "",
      timedOut: false,
    });
    expect(result.verdict).toBe("inconclusive");
  });
});

describe("gradeAgainstSpec hang", () => {
  it("grades timedOut true reproduced (acceptance)", () => {
    const result = gradeAgainstSpec(HANG_SPEC, { exitCode: 0, stdout: "", stderr: "", timedOut: true });
    expect(result.verdict).toBe("reproduced");
    expect(result.detail.timedOut).toBe(true);
  });

  it("grades a completed run not-reproduced", () => {
    const result = gradeAgainstSpec(HANG_SPEC, { exitCode: 0, stdout: "done", stderr: "", timedOut: false });
    expect(result.verdict).toBe("not-reproduced");
  });

  it("grades a real hang reproduced even when stderr logged import noise", () => {
    const result = gradeAgainstSpec(HANG_SPEC, {
      exitCode: 0,
      stdout: "",
      stderr: IMPORT_FAILURE_STDERR,
      timedOut: true,
    });
    expect(result.verdict).toBe("reproduced");
  });

  it("grades an import failure without a hang inconclusive", () => {
    const result = gradeAgainstSpec(HANG_SPEC, {
      exitCode: 1,
      stdout: "",
      stderr: IMPORT_FAILURE_STDERR,
      timedOut: false,
    });
    expect(result.verdict).toBe("inconclusive");
  });
});

describe("gate purity", () => {
  it("keeps every gate source free of model-provider references", () => {
    // The pattern is assembled from fragments so this very test file never
    // trips the grep it enforces over src/gate/.
    const pattern = new RegExp(["l" + "lm", "open" + "ai", "pi-" + "ai"].join("|"), "i");
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(pattern.test(text), `${name} mentions a model provider`).toBe(false);
    }
  });
});
