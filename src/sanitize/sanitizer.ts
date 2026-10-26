/**
 * Sanitizer boundary: untrusted text is stripped of invisible codepoints,
 * confusable homoglyphs are normalized to ASCII, and instruction-shaped lines
 * are flagged — before any LLM context entry.
 */
import {
  CONFUSABLES,
  INSTRUCTION_PATTERNS,
  INVISIBLE_CHARS,
  INVISIBLE_CHAR_RANGES,
} from "./patterns.js";

export interface SanitizeResult {
  clean: string;
  flags: string[];
}

const INVISIBLE_SINGLE = new Set<number>(INVISIBLE_CHARS);

function isInvisible(cp: number): boolean {
  if (INVISIBLE_SINGLE.has(cp)) return true;
  return INVISIBLE_CHAR_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/**
 * Sanitize untrusted text before it enters any LLM context.
 *
 * Pipeline: strip invisible codepoints, map confusable homoglyphs to ASCII
 * (flagging "homoglyph-run" if any were seen), then flag instruction-shaped
 * lines with "instruction-shaped-line" plus the matched pattern name. Flags are
 * deduplicated preserving first-occurrence order.
 */
export function sanitizeUntrusted(text: string): SanitizeResult {
  const flags: string[] = [];
  let clean = "";
  let sawHomoglyph = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue; // unreachable: for...of yields non-empty strings
    if (isInvisible(cp)) continue;
    const mapped = CONFUSABLES.get(ch);
    if (mapped === undefined) {
      clean += ch;
    } else {
      clean += mapped;
      sawHomoglyph = true;
    }
  }
  if (sawHomoglyph) flags.push("homoglyph-run");

  // Instructions are matched per sanitized line: the cleaned text is strictly
  // safer to match against, since zero-width-joined "ig[nop]nore" survives no more.
  const lines = clean.split(/\r?\n/);
  for (const { name, re } of INSTRUCTION_PATTERNS) {
    if (lines.some((line) => re.test(line))) {
      flags.push("instruction-shaped-line", name);
    }
  }
  return { clean, flags: [...new Set(flags)] };
}

/**
 * Wrap untrusted content in a delimited block `<<<UNTRUSTED:<label>>>...<<<END>>>`
 * so downstream prompts can treat the payload as data.
 */
export function wrapDataBlock(label: string, text: string): string {
  return `<<<UNTRUSTED:${label}>>>\n${text}\n<<<END>>>`;
}
