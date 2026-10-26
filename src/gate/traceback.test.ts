import { describe, expect, it } from "vitest";
import { parseTraceback } from "./traceback.js";

// Fixtures copied from genuine CPython stderr shapes (with identifiers
// renamed); shared consts so acceptance tests and the fixture suite pin the
// same real output.
const SIMPLE_TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/x/pkg/mod.py", line 10, in do_thing',
  "ValueError: bad value",
].join("\n");

const DURING_HANDLING_CHAIN = [
  "Traceback (most recent call last):",
  '  File "/app/mean.py", line 9, in average',
  "    return total / count",
  "ZeroDivisionError: division by zero",
  "",
  "During handling of the above exception, another exception occurred:",
  "",
  "Traceback (most recent call last):",
  '  File "/app/cli.py", line 14, in <module>',
  "    print(average([]))",
  '  File "/app/mean.py", line 11, in average',
  '    raise ValueError("cannot average an empty sequence")',
  "ValueError: cannot average an empty sequence",
].join("\n");

const DIRECT_CAUSE_CHAIN = [
  "Traceback (most recent call last):",
  '  File "/opt/tool/config.py", line 33, in load',
  '    section = raw["timeouts"]',
  "KeyError: 'timeouts'",
  "",
  "The above exception was the direct cause of the following exception:",
  "",
  "Traceback (most recent call last):",
  '  File "/opt/tool/config.py", line 51, in bootstrap',
  "    cfg = load(path)",
  '  File "/opt/tool/config.py", line 35, in load',
  '    raise ConfigError(f"missing section {key!r}") from key',
  "config.ConfigError: missing section 'timeouts'",
].join("\n");

const MANGLED_INDENT = [
  "    Traceback (most recent call last):",
  '        File "lib/geom/area.py", line 4, in total_area',
  "            return sum(shape.area for shape in shapes)",
  '        File "lib/geom/area.py", line 7, in rect_area',
  "            return self.w * self.h",
  "    TypeError: unsupported operand type(s) for *: 'str' and 'NoneType'",
].join("\n");

describe("parseTraceback acceptance scenarios", () => {
  it("extracts exceptionType and module+function frames from a standard traceback", () => {
    expect(parseTraceback(SIMPLE_TRACEBACK)).toEqual({
      exceptionType: "ValueError",
      frames: [{ module: "mod.py", function: "do_thing" }],
    });
  });

  it("parses the last block of a chained zero-division-then-ValueError stderr", () => {
    // Exactly the two last-block frames: a leaked ZeroDivisionError block
    // frame would make this three instead of two.
    expect(parseTraceback(DURING_HANDLING_CHAIN)).toEqual({
      exceptionType: "ValueError",
      frames: [
        { module: "cli.py", function: "<module>" },
        { module: "mean.py", function: "average" },
      ],
    });
  });

  it("returns null/empty for plain output without a traceback", () => {
    expect(parseTraceback("done\n")).toEqual({ exceptionType: null, frames: [] });
  });

  it("survives an indentation-mangled bug-report traceback", () => {
    expect(() => parseTraceback(MANGLED_INDENT)).not.toThrow();
    expect(parseTraceback(MANGLED_INDENT)).toEqual({
      exceptionType: "TypeError",
      frames: [
        { module: "area.py", function: "total_area" },
        { module: "area.py", function: "rect_area" },
      ],
    });
  });
});

describe("parseTraceback real-python-output fixtures", () => {
  it("parses a three-frame traceback with source echoes and caret markers", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/srv/api/handler.py", line 88, in <module>',
      "    run()",
      '  File "/srv/api/handler.py", line 61, in run',
      "    totals[key] = combine(acc, piece)",
      "                  ^^^^^^^^^^^^^^^^^^^",
      '  File "/srv/api/combine.py", line 12, in combine',
      "    return left.total + right.total",
      "           ~~~~~~~~~~^^^^^^^",
      "AttributeError: 'NoneType' object has no attribute 'total'",
    ].join("\n");
    expect(parseTraceback(stderr)).toEqual({
      exceptionType: "AttributeError",
      frames: [
        { module: "handler.py", function: "<module>" },
        { module: "handler.py", function: "run" },
        { module: "combine.py", function: "combine" },
      ],
    });
  });

  it("keeps only the last block for a 'During handling' chained traceback", () => {
    const result = parseTraceback(DURING_HANDLING_CHAIN);
    expect(result.exceptionType).toBe("ValueError");
    expect(result.frames).toEqual([
      { module: "cli.py", function: "<module>" },
      { module: "mean.py", function: "average" },
    ]);
  });

  it("keeps only the last block and the dotted name for a 'direct cause' chained traceback", () => {
    const result = parseTraceback(DIRECT_CAUSE_CHAIN);
    expect(result.exceptionType).toBe("config.ConfigError");
    // KeyError block's single frame must not leak in.
    expect(result.frames).toEqual([
      { module: "config.py", function: "bootstrap" },
      { module: "config.py", function: "load" },
    ]);
  });

  it("derives module from Windows-style paths", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "C:\\proj\\pkg\\mod.py", line 10, in do_thing',
      "    validate(raw)",
      "ValueError: bad value",
    ].join("\n");
    expect(parseTraceback(stderr)).toEqual({
      exceptionType: "ValueError",
      frames: [{ module: "mod.py", function: "do_thing" }],
    });
  });

  it("parses a message-less KeyboardInterrupt exception line", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/home/dev/tools/watch.py", line 120, in <module>',
      "    event = queue.get(timeout=30)",
      '  File "/home/dev/tools/watch.py", line 45, in get',
      "    item = self._poll()",
      "KeyboardInterrupt",
    ].join("\n");
    expect(parseTraceback(stderr)).toEqual({
      exceptionType: "KeyboardInterrupt",
      frames: [
        { module: "watch.py", function: "<module>" },
        { module: "watch.py", function: "get" },
      ],
    });
  });

  it("returns partial frames with a null type for a stderr truncated mid-traceback", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "/app/main.py", line 5, in <module>',
      "    cli.run()",
    ].join("\n");
    expect(parseTraceback(stderr)).toEqual({
      exceptionType: null,
      frames: [{ module: "main.py", function: "<module>" }],
    });
  });
});

describe("parseTraceback edge cases", () => {
  it("yields a null/empty result for input without a traceback header", () => {
    const cases: Array<[string, string]> = [
      ["empty string", ""],
      ["exception-shaped line without header", "ValueError: bad value\n"],
      ["header-only traceback", "Traceback (most recent call last):\n"],
      ["frame lines without header", '  File "/a/b.py", line 1, in f\n'],
      ["bare name without header", "KeyboardInterrupt"],
    ];
    for (const [name, input] of cases) {
      expect(parseTraceback(input), name).toEqual({ exceptionType: null, frames: [] });
    }
  });

  it("parses CRLF and whitespace-padded output identically to the canonical form", () => {
    const canonical = parseTraceback(SIMPLE_TRACEBACK);
    const padded = parseTraceback(`\n  \n${SIMPLE_TRACEBACK.replace(/\n/g, "\r\n")}\n  \n`);
    expect(padded).toEqual(canonical);
  });

  it("accepts a header without the trailing colon", () => {
    const stderr = [
      "Traceback (most recent call last)",
      '  File "/x/pkg/mod.py", line 10, in do_thing',
      "ValueError: bad value",
    ].join("\n");
    expect(parseTraceback(stderr)).toEqual({
      exceptionType: "ValueError",
      frames: [{ module: "mod.py", function: "do_thing" }],
    });
  });

  it("returns null/empty for SyntaxError-style output without a header", () => {
    const stderr = [
      '  File "t.py", line 1',
      "    if x ==",
      "           ^",
      "SyntaxError: invalid syntax",
    ].join("\n");
    // No traceback header: SyntaxError-style output has its own format and
    // the contract returns null/empty rather than guessing.
    expect(parseTraceback(stderr)).toEqual({ exceptionType: null, frames: [] });
  });
});
