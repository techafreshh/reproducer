/**
 * Bisect boundary unit tests: pure gate-graded matrix, exact budget error,
 * and markdown table rendering — no ledger, no network.
 */
import { describe, expect, it } from "vitest";
import {
  bisect,
  chooseBisectVersions,
  renderBisectTable,
  runBisect,
  toBisectResult,
} from "./bisect.js";
import type { PypiClient } from "../../sandbox/pypi-client.js";

const SPEC = {
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
} as const;

const REPRODUCED_STDERR = [
  "Traceback (most recent call last):",
  '  File "/app/cli.py", line 14, in <module>',
  "    run()",
  '  File "/app/core.py", line 7, in parse',
  '    raise ValueError("bad value")',
  "ValueError: bad value",
].join("\n");

const NOT_REPRODUCED_STDERR = [
  "Traceback (most recent call last):",
  '  File "/app/cli.py", line 14, in <module>',
  "    run()",
  '  File "/app/core.py", line 7, in parse',
  '    raise TypeError("bad type")',
  "TypeError: bad type",
].join("\n");

function reproducedResult() {
  return { exitCode: 1, stdout: "", stderr: REPRODUCED_STDERR, timedOut: false };
}

function goodResult() {
  return { exitCode: 1, stdout: "", stderr: NOT_REPRODUCED_STDERR, timedOut: false };
}

describe("bisect boundary", () => {
  it("reports firstBad 2.2.0 and lastGood 2.1.0 for a 3-version matrix", () => {
    const result = bisect(SPEC, ["2.0.0", "2.1.0", "2.2.0"], [goodResult(), goodResult(), reproducedResult()]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((row) => row.version)).toEqual(["2.0.0", "2.1.0", "2.2.0"]);
    expect(result.rows[2]?.verdict).toBe("reproduced");
    expect(result.firstBad).toBe("2.2.0");
    expect(result.lastGood).toBe("2.1.0");
  });

  it("rejects 12 versions with a max 8 versions error before grading", () => {
    const versions = Array.from({ length: 12 }, (_, i) => `1.0.${i}`);
    expect(() => runBisect(SPEC, versions, [])).toThrow(/max 8 versions/);
    expect(() => bisect(SPEC, versions, [])).toThrow(/max 8 versions/);
    expect(() => runBisect(SPEC, [], [])).toThrow(/max 8 versions/);
  });

  it("renders table headers even for an empty result", () => {
    const table = renderBisectTable(toBisectResult([]));
    expect(table).toContain("| version | verdict |");
  });

  it("spans the reported to latest window down to at most 8 versions", async () => {
    const releases: Record<string, Array<{ filename: string }>> = {};
    for (let i = 0; i < 10; i++) {
      releases[`1.0.${i}`] = [{ filename: `pkg-1.0.${i}-py3-none-any.whl` }];
    }
    const client: PypiClient = {
      fetchReleases: async () => releases,
    };
    const picked = await chooseBisectVersions(client, "pkg", "1.0.0", "1.0.9", 8);
    expect(picked).toHaveLength(8);
    expect(picked[0]).toBe("1.0.0");
    expect(picked[picked.length - 1]).toBe("1.0.9");
  });
});
