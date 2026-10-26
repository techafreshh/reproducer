/**
 * Traceback parser for the deterministic symptom gate: turns the stderr of a
 * failed env_run into the raised exception type and module+function stack
 * frames, with no model call.
 *
 * Leniency contract: mangled bug-report text must never throw. Only the last
 * `Traceback (most recent call last)` block is parsed — chained exceptions
 * ("During handling of the above exception, another exception occurred:" and
 * "The above exception was the direct cause of the following exception:")
 * always precede a fresh header, so "last header wins" handles both. A stderr
 * with no traceback header yields a null/empty result, even when it ends in
 * an exception-shaped line.
 */

export interface TracebackParseResult {
  exceptionType: string | null;
  frames: { module: string; function: string }[];
}

// Colon optional: bug-report formatting is exactly where headers degrade.
const TRACEBACK_HEADER_RE = /^\s*Traceback \(most recent call last\)/;
// Straight quotes only — that is what CPython emits; `(.+)` keeps `<module>` verbatim.
const FRAME_RE = /^\s*File "(.*)", line \d+, in (.+)$/;
// Dotted name kept verbatim (e.g. `requests.exceptions.HTTPError`); leading
// whitespace tolerated so pasted, re-indented reports still yield the type.
const EXCEPTION_RE = /^\s*([A-Za-z_]\w*(?:\.\w+)*)(?::\s?.*)?$/;

/** Last path segment after `/` or `\`, extension kept — the issue pins `module: "mod.py"` for `/x/pkg/mod.py`. */
function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep === -1 ? path : path.slice(sep + 1);
}

/**
 * Parse a Python traceback from stderr. Never throws on any input.
 *
 * Frame lines are `File "path", line N, in fn` pairs with the file part of the
 * path as `module`; the exception line is the bottom-most non-frame line
 * shaped `Type: message` (CPython prints it last, so source echoes and caret
 * lines are naturally skipped). Truncated stderr returns the frames it has
 * with `exceptionType: null` — never fabricates.
 */
export function parseTraceback(stderr: string): TracebackParseResult {
  const lines = stderr.split(/\r?\n/);

  let headerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && TRACEBACK_HEADER_RE.test(line)) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) {
    return { exceptionType: null, frames: [] };
  }
  const block = lines.slice(headerIndex + 1);

  const frames: { module: string; function: string }[] = [];
  for (const line of block) {
    const match = FRAME_RE.exec(line);
    if (match) {
      const path = match[1];
      const fn = match[2];
      if (path !== undefined && fn !== undefined) {
        frames.push({ module: basename(path), function: fn });
      }
    }
  }

  let exceptionType: string | null = null;
  for (let i = block.length - 1; i >= 0; i--) {
    const line = block[i];
    if (line === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
    const frame = FRAME_RE.exec(line);
    if (frame) continue;
    if (line.trim() === "") continue;
    const match = EXCEPTION_RE.exec(line);
    if (match) {
      const name = match[1];
      if (name !== undefined) exceptionType = name;
      break;
    }
  }

  return { exceptionType, frames };
}
