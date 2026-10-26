/**
 * Ported sanitizer pattern lists per PRD §9 — invisible codepoints, confusable
 * homoglyph maps, and instruction-shaped-line patterns. Data only: the matching
 * algorithm lives in `sanitizer.ts`.
 */

/**
 * Single invisible codepoints stripped by the sanitizer, by class:
 *
 * - 0x00AD soft hyphen
 * - 0x061C Arabic letter mark
 * - 0x115F, 0x1160 Hangul Jamo filler lookalikes
 * - 0x180E Mongolian vowel separator
 * - 0x200B zero-width space, 0x200C ZWNJ, 0x200D ZWJ (zero-width joiners)
 * - 0x200E left-to-right mark, 0x200F right-to-left mark
 * - 0x3164 Hangul filler, 0xFFA0 halfwidth Hangul filler
 * - 0xFEFF BOM / zero-width no-break space
 */
export const INVISIBLE_CHARS: readonly number[] = [
  0x00ad,
  0x061c,
  0x115f,
  0x1160,
  0x180e,
  0x200b,
  0x200c,
  0x200d,
  0x200e,
  0x200f,
  0x3164,
  0xfeff,
  0xffa0,
];

/**
 * Inclusive invisible codepoint ranges (lo, hi), by class:
 * bidi separators/marks 0x2028–0x202E, word joiner + invisible operators +
 * bidi isolates 0x2060–0x206F, variation selectors VS1–16 and VS17–256,
 * Unicode tag block 0xE0000–0xE007F.
 */
export const INVISIBLE_CHAR_RANGES: readonly (readonly [number, number])[] = [
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
  [0xe0000, 0xe007f],
];

/** Cyrillic homoglyphs mapped to their Latin lookalikes (case preserved). */
export const CYRILLIC_CONFUSABLES: Readonly<Record<string, string>> = {
  "\u0430": "a", // а CYRILLIC SMALL LETTER A
  "\u0435": "e", // е CYRILLIC SMALL LETTER IE
  "\u043e": "o", // о CYRILLIC SMALL LETTER O
  "\u0440": "p", // р CYRILLIC SMALL LETTER ER
  "\u0441": "c", // с CYRILLIC SMALL LETTER ES
  "\u0443": "y", // у CYRILLIC SMALL LETTER U
  "\u0445": "x", // х CYRILLIC SMALL LETTER HA
  "\u0456": "i", // і CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  "\u0458": "j", // ј CYRILLIC SMALL LETTER JE
  "\u0455": "s", // ѕ CYRILLIC SMALL LETTER DZE
  "\u0501": "d", // ԁ CYRILLIC SMALL LETTER KOMI DE
  "\u04bb": "h", // һ CYRILLIC SMALL LETTER SHHA
  "\u0410": "A", // А CYRILLIC CAPITAL LETTER A
  "\u0412": "B", // В CYRILLIC CAPITAL LETTER VE
  "\u0415": "E", // Е CYRILLIC CAPITAL LETTER IE
  "\u041a": "K", // К CYRILLIC CAPITAL LETTER KA
  "\u041c": "M", // М CYRILLIC CAPITAL LETTER EM
  "\u041d": "H", // Н CYRILLIC CAPITAL LETTER EN
  "\u041e": "O", // О CYRILLIC CAPITAL LETTER O
  "\u0420": "P", // Р CYRILLIC CAPITAL LETTER ER
  "\u0421": "C", // С CYRILLIC CAPITAL LETTER ES
  "\u0422": "T", // Т CYRILLIC CAPITAL LETTER TE
  "\u0423": "Y", // У CYRILLIC CAPITAL LETTER U
  "\u0425": "X", // Х CYRILLIC CAPITAL LETTER HA
};

/** Greek homoglyphs mapped to their Latin lookalikes (case preserved). */
export const GREEK_CONFUSABLES: Readonly<Record<string, string>> = {
  "\u03b1": "a", // α GREEK SMALL LETTER ALPHA
  "\u03b5": "e", // ε GREEK SMALL LETTER EPSILON
  "\u03b9": "i", // ι GREEK SMALL LETTER IOTA
  "\u03ba": "k", // κ GREEK SMALL LETTER KAPPA
  "\u03bd": "v", // ν GREEK SMALL LETTER NU
  "\u03bf": "o", // ο GREEK SMALL LETTER OMICRON
  "\u03c1": "p", // ρ GREEK SMALL LETTER RHO
  "\u03c5": "u", // υ GREEK SMALL LETTER UPSILON
  "\u03c7": "x", // χ GREEK SMALL LETTER CHI
  "\u0391": "A", // Α GREEK CAPITAL LETTER ALPHA
  "\u0392": "B", // Β GREEK CAPITAL LETTER BETA
  "\u0395": "E", // Ε GREEK CAPITAL LETTER EPSILON
  "\u0396": "Z", // Ζ GREEK CAPITAL LETTER ZETA
  "\u0397": "H", // Η GREEK CAPITAL LETTER ETA
  "\u0399": "I", // Ι GREEK CAPITAL LETTER IOTA
  "\u039a": "K", // Κ GREEK CAPITAL LETTER KAPPA
  "\u039c": "M", // Μ GREEK CAPITAL LETTER MU
  "\u039d": "N", // Ν GREEK CAPITAL LETTER NU
  "\u039f": "O", // Ο GREEK CAPITAL LETTER OMICRON
  "\u03a1": "P", // Ρ GREEK CAPITAL LETTER RHO
  "\u03a4": "T", // Τ GREEK CAPITAL LETTER TAU
  "\u03a5": "Y", // Υ GREEK CAPITAL LETTER UPSILON
  "\u03a7": "X", // Χ GREEK CAPITAL LETTER CHI
};

/** Roman numeral codepoints (U+2160–217F) expanded to their Latin letters. */
export const ROMAN_NUMERAL_CONFUSABLES: Readonly<Record<string, string>> = {
  "\u2160": "I", // Ⅰ ROMAN NUMERAL ONE
  "\u2161": "II", // Ⅱ ROMAN NUMERAL TWO
  "\u2162": "III", // Ⅲ ROMAN NUMERAL THREE
  "\u2163": "IV", // Ⅳ ROMAN NUMERAL FOUR
  "\u2164": "V", // Ⅴ ROMAN NUMERAL FIVE
  "\u2165": "VI", // Ⅵ ROMAN NUMERAL SIX
  "\u2166": "VII", // Ⅶ ROMAN NUMERAL SEVEN
  "\u2167": "VIII", // Ⅷ ROMAN NUMERAL EIGHT
  "\u2168": "IX", // Ⅸ ROMAN NUMERAL NINE
  "\u2169": "X", // Ⅹ ROMAN NUMERAL TEN
  "\u216a": "XI", // Ⅺ ROMAN NUMERAL ELEVEN
  "\u216b": "XII", // Ⅻ ROMAN NUMERAL TWELVE
  "\u216c": "L", // Ⅼ ROMAN NUMERAL FIFTY
  "\u216d": "C", // Ⅽ ROMAN NUMERAL ONE HUNDRED
  "\u216e": "D", // Ⅾ ROMAN NUMERAL FIVE HUNDRED
  "\u216f": "M", // Ⅿ ROMAN NUMERAL ONE THOUSAND
  "\u2170": "i", // ⅰ SMALL ROMAN NUMERAL ONE
  "\u2171": "ii", // ⅱ SMALL ROMAN NUMERAL TWO
  "\u2172": "iii", // ⅲ SMALL ROMAN NUMERAL THREE
  "\u2173": "iv", // ⅳ SMALL ROMAN NUMERAL FOUR
  "\u2174": "v", // ⅴ SMALL ROMAN NUMERAL FIVE
  "\u2175": "vi", // ⅵ SMALL ROMAN NUMERAL SIX
  "\u2176": "vii", // ⅶ SMALL ROMAN NUMERAL SEVEN
  "\u2177": "viii", // ⅷ SMALL ROMAN NUMERAL EIGHT
  "\u2178": "ix", // ⅸ SMALL ROMAN NUMERAL NINE
  "\u2179": "x", // ⅹ SMALL ROMAN NUMERAL TEN
  "\u217a": "xi", // ⅺ SMALL ROMAN NUMERAL ELEVEN
  "\u217b": "xii", // ⅻ SMALL ROMAN NUMERAL TWELVE
  "\u217c": "l", // ⅼ SMALL ROMAN NUMERAL FIFTY
  "\u217d": "c", // ⅽ SMALL ROMAN NUMERAL ONE HUNDRED
  "\u217e": "d", // ⅾ SMALL ROMAN NUMERAL FIVE HUNDRED
  "\u217f": "m", // ⅿ SMALL ROMAN NUMERAL ONE THOUSAND
};

/** Dash and Unicode space lookalikes normalized to ASCII "-" and " ". */
export const DASH_SPACE_CONFUSABLES: Readonly<Record<string, string>> = {
  "\u2010": "-", // ‐ HYPHEN
  "\u2011": "-", // ‑ NON-BREAKING HYPHEN
  "\u2012": "-", // ‒ FIGURE DASH
  "\u2013": "-", // – EN DASH
  "\u2014": "-", // — EM DASH
  "\u2015": "-", // ― HORIZONTAL BAR
  "\u2212": "-", // − MINUS SIGN
  "\uff0d": "-", // － FULLWIDTH HYPHEN-MINUS
  "\u2027": "-", // ‧ HYPHENATION POINT
  "\u00a0": " ", //   NO-BREAK SPACE
  "\u2000": " ", //   EN QUAD
  "\u2001": " ", //   EM QUAD
  "\u2002": " ", //   EN SPACE
  "\u2003": " ", //   EM SPACE
  "\u2004": " ", //   THREE-PER-EM SPACE
  "\u2005": " ", //   FOUR-PER-EM SPACE
  "\u2006": " ", //   SIX-PER-EM SPACE
  "\u2007": " ", //   FIGURE SPACE
  "\u2008": " ", //   PUNCTUATION SPACE
  "\u2009": " ", //   THIN SPACE
  "\u200a": " ", //   HAIR SPACE
  "\u202f": " ", //   NARROW NO-BREAK SPACE
  "\u205f": " ", //   MEDIUM MATHEMATICAL SPACE
  "\u3000": " ", //   IDEOGRAPHIC SPACE
};

/** Fullwidth, superscript, and subscript digit lookalikes mapped to ASCII digits. */
export const DIGIT_CONFUSABLES: Readonly<Record<string, string>> = {
  "\uff10": "0", // ０ FULLWIDTH DIGIT ZERO
  "\uff11": "1", // １ FULLWIDTH DIGIT ONE
  "\uff12": "2", // ２ FULLWIDTH DIGIT TWO
  "\uff13": "3", // ３ FULLWIDTH DIGIT THREE
  "\uff14": "4", // ４ FULLWIDTH DIGIT FOUR
  "\uff15": "5", // ５ FULLWIDTH DIGIT FIVE
  "\uff16": "6", // ６ FULLWIDTH DIGIT SIX
  "\uff17": "7", // ７ FULLWIDTH DIGIT SEVEN
  "\uff18": "8", // ８ FULLWIDTH DIGIT EIGHT
  "\uff19": "9", // ９ FULLWIDTH DIGIT NINE
  "\u2070": "0", // ⁰ SUPERSCRIPT ZERO
  "\u00b9": "1", // ¹ SUPERSCRIPT ONE
  "\u00b2": "2", // ² SUPERSCRIPT TWO
  "\u00b3": "3", // ³ SUPERSCRIPT THREE
  "\u2074": "4", // ⁴ SUPERSCRIPT FOUR
  "\u2075": "5", // ⁵ SUPERSCRIPT FIVE
  "\u2076": "6", // ⁶ SUPERSCRIPT SIX
  "\u2077": "7", // ⁷ SUPERSCRIPT SEVEN
  "\u2078": "8", // ⁸ SUPERSCRIPT EIGHT
  "\u2079": "9", // ⁹ SUPERSCRIPT NINE
  "\u2080": "0", // ₀ SUBSCRIPT ZERO
  "\u2081": "1", // ₁ SUBSCRIPT ONE
  "\u2082": "2", // ₂ SUBSCRIPT TWO
  "\u2083": "3", // ₃ SUBSCRIPT THREE
  "\u2084": "4", // ₄ SUBSCRIPT FOUR
  "\u2085": "5", // ₅ SUBSCRIPT FIVE
  "\u2086": "6", // ₆ SUBSCRIPT SIX
  "\u2087": "7", // ₇ SUBSCRIPT SEVEN
  "\u2088": "8", // ₈ SUBSCRIPT EIGHT
  "\u2089": "9", // ₉ SUBSCRIPT NINE
};

const CONFUSABLE_CLASSES: readonly (readonly [
  string,
  Readonly<Record<string, string>>,
])[] = [
  ["cyrillic", CYRILLIC_CONFUSABLES],
  ["greek", GREEK_CONFUSABLES],
  ["roman-numeral", ROMAN_NUMERAL_CONFUSABLES],
  ["dash-space", DASH_SPACE_CONFUSABLES],
  ["digit", DIGIT_CONFUSABLES],
];

/** All confusable classes merged into one lookup; class blocks are disjoint. */
export const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_CLASSES.flatMap(([, record]) => Object.entries(record)),
);

/**
 * Instruction-shaped line patterns, each with a stable pattern name emitted in
 * flags alongside "instruction-shaped-line". Non-global so `.test()` stays
 * stateless; tested per line, so `\s` cannot match across lines.
 */
export const INSTRUCTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "ignore-previous", re: /ignore\s+(all\s+)?previous/i },
  { name: "system-prompt", re: /system\s+prompt/i },
  { name: "you-are-now", re: /you\s+are\s+now/i },
  { name: "disregard-all", re: /disregard\s+all/i },
];
