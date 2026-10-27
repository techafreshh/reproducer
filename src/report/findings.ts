/**
 * Report builders: standalone `repro.py` plus the six-section `findings.md`.
 *
 * Pure string assembly — no ledger, no network, no runtime imports. The
 * scripted demo (`src/orchestrator/demo-run.ts`) calls these builders at
 * every submit site so ledger artifacts always satisfy the report contract;
 * `src/agent/session.ts` keeps its own canned-notes path and only reuses the
 * bisect helpers below.
 */
import {
  renderBisectTable,
  toBisectResult,
  type BisectResult,
  type BisectRow,
} from "../agent/tools/bisect.js";
import type { GateVerdict } from "../gate/gate.js";

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

/** Per-branch research verdict rendered in `## Research`. */
export type ResearchVerdict =
  | "known-bug-fixed-later"
  | "likely-regression"
  | "likely-misconfiguration";

/**
 * Collect deduplicated `https://` citation URLs from canned Tavily results.
 * Reads `searches[].results[].url` plus the top-level `extract.url`; anything
 * missing, non-string, or non-`https://` is skipped. Order is first-seen.
 */
export function collectCitationUrls(cannedTavily: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("https://") && !seen.has(value)) {
      seen.add(value);
      urls.push(value);
    }
  };
  if (typeof cannedTavily !== "object" || cannedTavily === null) return urls;
  const root = cannedTavily as Record<string, unknown>;
  const searches = root.searches;
  if (Array.isArray(searches)) {
    for (const search of searches) {
      if (typeof search !== "object" || search === null) continue;
      const results = (search as Record<string, unknown>).results;
      if (!Array.isArray(results)) continue;
      for (const entry of results) {
        if (typeof entry !== "object" || entry === null) continue;
        push((entry as Record<string, unknown>).url);
      }
    }
  }
  const extract = root.extract;
  if (typeof extract === "object" && extract !== null) {
    push((extract as Record<string, unknown>).url);
  }
  return urls;
}

export interface BuildReproPyInput {
  library: string;
  version: string;
  /** Shrunk python body, verbatim (already graded by the gate). */
  body: string;
  /** Honest-failure mode: prepend the inconclusive header, never mark reproduced. */
  inconclusive: boolean;
}

const INCONCLUSIVE_HEADER = "# INCONCLUSIVE — best evidence attached";

/**
 * Build a standalone `repro.py`: shebang plus a pinned-install comment guard,
 * then the shrunk body verbatim. Header lines are `#` comments only, so the
 * file stays stdlib-only with no network side effects at import; the body's
 * own `if __name__ == "__main__"` trigger drives the deterministic crash and
 * the process exits nonzero while the symptom is present. Throws when the
 * output would reference the harness runtime.
 */
export function buildReproPy({ library, version, body, inconclusive }: BuildReproPyInput): string {
  const lines: string[] = [];
  if (inconclusive) lines.push(INCONCLUSIVE_HEADER);
  lines.push("#!/usr/bin/env python3");
  lines.push(`# Standalone repro for ${library}==${version} (stdlib only, no harness required).`);
  lines.push(`# To reproduce against the installed library: pip install ${library}==${version}`);
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  const out = `${lines.join("\n")}\n${normalized}`;
  if (out.includes("reproducer")) {
    throw new Error("repro.py must not reference the harness runtime");
  }
  return out;
}

export interface BuildFindingsMdInput {
  hypothesis: string;
  evidence: string;
  researchVerdict: ResearchVerdict;
  citations: string[];
  bisectRows: BisectRow[];
  fixSketch?: string;
  reportedEnv: string;
  status: GateVerdict;
}

/**
 * Assemble the six-section `findings.md`: `## Hypothesis` / `## Evidence` /
 * `## Research` / `## Bisect` / `## Fix sketch` / `## Environment`. `## Research`
 * prints `verdict: <one-of-three>` plus one `- <url>` bullet per citation;
 * `## Bisect` prints the `| version | verdict |` table plus one
 * `| <version> | <verdict> |` row per bisect row.
 */
export function buildFindingsMd({
  hypothesis,
  evidence,
  researchVerdict,
  citations,
  bisectRows,
  fixSketch,
  reportedEnv,
  status,
}: BuildFindingsMdInput): string {
  const boundary = toBisectResult(bisectRows);
  const table = renderBisectTable(boundary);
  const citationLines =
    citations.length > 0 ? citations.map((url) => `- ${url}`).join("\n") : "- none";
  const sketch =
    fixSketch !== undefined && fixSketch.length > 0
      ? fixSketch
      : "No fix sketch — run did not reproduce conclusively.";
  const lines = [
    "# Findings",
    "",
    `Status: ${status}`,
    "",
    "## Hypothesis",
    "",
    hypothesis.length > 0 ? hypothesis : "No hypothesis recorded.",
    "",
    "## Evidence",
    "",
    evidence.length > 0 ? evidence : "No evidence recorded.",
    "",
    "## Research",
    "",
    `verdict: ${researchVerdict}`,
    citationLines,
    "",
    "## Bisect",
    "",
    table,
    "",
    `lastGood: ${boundary.lastGood ?? "none"}`,
    `firstBad: ${boundary.firstBad ?? "none"}`,
    "",
    "## Fix sketch",
    "",
    sketch,
    "",
    "## Environment",
    "",
    "- Execution: Linux container (this run executed in a Linux container).",
    `- Reported environment (from issue report): ${reportedEnv}`,
    "",
  ];
  return lines.join("\n");
}
