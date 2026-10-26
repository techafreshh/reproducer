import { describe, expect, it } from "vitest";
import {
  CONFUSABLES,
  CYRILLIC_CONFUSABLES,
  DIGIT_CONFUSABLES,
  DASH_SPACE_CONFUSABLES,
  GREEK_CONFUSABLES,
  INSTRUCTION_PATTERNS,
  INVISIBLE_CHARS,
  INVISIBLE_CHAR_RANGES,
  ROMAN_NUMERAL_CONFUSABLES,
} from "./patterns.js";

describe("invisible codepoint lists", () => {
  it("contains every named single codepoint", () => {
    const cases: Array<[string, number]> = [
      ["soft hyphen", 0x00ad],
      ["Arabic letter mark", 0x061c],
      ["Hangul Jamo filler", 0x115f],
      ["Hangul Jamo filler", 0x1160],
      ["Mongolian vowel separator", 0x180e],
      ["zero-width space", 0x200b],
      ["zero-width non-joiner", 0x200c],
      ["zero-width joiner", 0x200d],
      ["left-to-right mark", 0x200e],
      ["right-to-left mark", 0x200f],
      ["Hangul filler", 0x3164],
      ["BOM / zero-width no-break space", 0xfeff],
      ["halfwidth Hangul filler", 0xffa0],
    ];
    for (const [name, cp] of cases) {
      expect(INVISIBLE_CHARS, name).toContain(cp);
    }
    expect(INVISIBLE_CHARS).toHaveLength(cases.length);
    expect(new Set(INVISIBLE_CHARS).size).toBe(cases.length);
  });

  it("contains exactly the five documented ranges", () => {
    expect(INVISIBLE_CHAR_RANGES).toEqual([
      [0x2028, 0x202e], // bidi separators and marks
      [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
      [0xfe00, 0xfe0f], // variation selectors 1-16
      [0xe0100, 0xe01ef], // variation selectors 17-256
      [0xe0000, 0xe007f], // Unicode tag block
    ]);
  });
});

describe("confusable maps", () => {
  it("normalizes one canonical entry per class", () => {
    const cases: Array<[string, string, string]> = [
      // [class, input char, expected ASCII]
      ["cyrillic", "\u0430", "a"],
      ["greek", "\u03bf", "o"],
      ["roman-numeral", "\u2173", "iv"],
      ["dash", "\u2013", "-"],
      ["space", "\u00a0", " "],
      ["digit", "\uff13", "3"],
    ];
    for (const [klass, input, expected] of cases) {
      expect(CONFUSABLES.get(input), klass).toBe(expected);
    }
  });

  it("maps every class record to the documented size", () => {
    // Pinned sizes guard the port: a dropped entry is lost normalization forever.
    expect(Object.keys(CYRILLIC_CONFUSABLES)).toHaveLength(24);
    expect(Object.keys(GREEK_CONFUSABLES)).toHaveLength(23);
    expect(Object.keys(ROMAN_NUMERAL_CONFUSABLES)).toHaveLength(32);
    expect(Object.keys(DASH_SPACE_CONFUSABLES)).toHaveLength(24);
    expect(Object.keys(DIGIT_CONFUSABLES)).toHaveLength(30);
  });

  it("merges all classes without key loss", () => {
    const sizes = [
      CYRILLIC_CONFUSABLES,
      GREEK_CONFUSABLES,
      ROMAN_NUMERAL_CONFUSABLES,
      DASH_SPACE_CONFUSABLES,
      DIGIT_CONFUSABLES,
    ].reduce((sum, record) => sum + Object.keys(record).length, 0);
    expect(CONFUSABLES.size).toBe(sizes);
  });

  it("maps lookalike keys to plain ASCII letter-and-space values", () => {
    expect(CONFUSABLES.size).toBeGreaterThan(0);
    for (const [key, value] of CONFUSABLES) {
      expect(value, `U+${key.codePointAt(0)?.toString(16)}`).toMatch(/^[A-Za-z0-9 -]+$/);
      // Keys are the lookalikes themselves: at least one non-ASCII codepoint.
      expect([...key].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f), key).toBe(true);
    }
  });
});

describe("instruction patterns", () => {
  it("carries the four named patterns, non-global and case-insensitive", () => {
    expect(INSTRUCTION_PATTERNS.map((p) => p.name)).toEqual([
      "ignore-previous",
      "system-prompt",
      "you-are-now",
      "disregard-all",
    ]);
    for (const { re } of INSTRUCTION_PATTERNS) {
      expect(re.global).toBe(false);
      expect(re.flags).toContain("i");
    }
  });
});
