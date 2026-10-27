/**
 * `findings.md` bisect section: the `## Bisect` markdown table appended at
 * `submit_report` once the session has graded the verified repro across the
 * bisect window. Pure string assembly — no ledger, no network.
 */
import { renderBisectTable, type BisectResult } from "../agent/tools/bisect.js";

/** `## Bisect` section: version/verdict table plus the boundary lines. */
export function renderBisectSection(result: BisectResult): string {
  const lines = ["## Bisect", "", renderBisectTable(result), ""];
  lines.push(`lastGood: ${result.lastGood ?? "none"}`);
  lines.push(`firstBad: ${result.firstBad ?? "none"}`);
  return lines.join("\n") + "\n";
}

/**
 * Append the `## Bisect` section to `findingsMd`; a null result is a no-op
 * so runs without a bisect keep their canned notes byte-identical.
 */
export function withBisectSection(findingsMd: string, result: BisectResult | null): string {
  if (result === null) return findingsMd;
  const base = findingsMd.endsWith("\n") ? findingsMd : `${findingsMd}\n`;
  return `${base}\n${renderBisectSection(result)}`;
}
