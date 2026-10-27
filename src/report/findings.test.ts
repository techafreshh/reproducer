/**
 * Issue-14 report builders: six sections, research verdict literal plus a
 * cached citation URL, bisect row shape, standalone `repro.py` header, and
 * honest-inconclusive behavior — all without the harness runtime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BisectRow } from "../agent/tools/bisect.js";
import {
  buildFindingsMd,
  buildReproPy,
  collectCitationUrls,
} from "./findings.js";

const ROW_RE = /^\| [^|]+ \| (reproduced|not-reproduced|inconclusive) \|$/m;

function demoCitations(): string[] {
  const tavily = JSON.parse(readFileSync(join("fixtures/demo-1", "tavily.json"), "utf8")) as unknown;
  return collectCitationUrls(tavily);
}

function sampleRows(): BisectRow[] {
  return [{ version: "0.1.0", verdict: "reproduced", reason: "crashed with expected ValueError" }];
}

const SAMPLE_BODY = [
  "import traceback",
  "",
  "def brood(count):",
  "    if count < 0:",
  '        raise ValueError(\"duckling count must be non-negative\")',
  "    return []",
  "",
  "def hatch():",
  "    try:",
  "        return brood(-1)",
  "    except ValueError:",
  "        traceback.print_exc()",
  "        raise",
  "",
  'if __name__ == \"__main__\":',
  "    hatch()",
  "",
].join("\n");

describe("collectCitationUrls", () => {
  it("reads the demo-1 cached searches plus extract url, deduped", () => {
    const urls = demoCitations();
    expect(urls).toContain("https://example.com/docs/ducklings-brood");
    expect(urls).toContain("https://github.com/demo/ducklings/issues/1");
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(url.startsWith("https://")).toBe(true);
  });

  it("drops non-https, non-string, and duplicate urls", () => {
    const urls = collectCitationUrls({
      searches: [
        { results: [{ url: "http://insecure.example/x" }, { url: "https://a.example/1" }, { url: 42 }] },
        { results: [{ url: "https://a.example/1" }, { url: "https://b.example/2" }] },
      ],
      extract: { url: "https://a.example/1" },
    });
    expect(urls).toEqual(["https://a.example/1", "https://b.example/2"]);
  });
});

describe("buildReproPy", () => {
  it("emits a standalone script with shebang and pinned-install guard", () => {
    for (const inconclusive of [false, true]) {
      const repro = buildReproPy({
        library: "ducklings",
        version: "0.1.0",
        body: SAMPLE_BODY,
        inconclusive,
      });
      expect(repro).toContain("#!/usr/bin/env python3");
      expect(repro).toContain("pip install");
      expect(repro).toContain("ducklings==0.1.0");
      expect(repro).toContain('if __name__ == \"__main__\"');
      expect(repro).not.toContain("reproducer");
      expect(repro).not.toMatch(/reproducer/);
    }
  });

  it("prepends the honest-failure header only for inconclusive runs", () => {
    const ok = buildReproPy({ library: "ducklings", version: "0.1.0", body: SAMPLE_BODY, inconclusive: false });
    expect(ok.startsWith("# INCONCLUSIVE")).toBe(false);
    const inconclusive = buildReproPy({
      library: "ducklings",
      version: "0.1.0",
      body: SAMPLE_BODY,
      inconclusive: true,
    });
    expect(inconclusive.startsWith("# INCONCLUSIVE — best evidence attached")).toBe(true);
  });
});

describe("buildFindingsMd", () => {
  it("emits all six sections with a verdict literal and a citation url", () => {
    const findings = buildFindingsMd({
      hypothesis: "- hatch() defaults to brood(-1)",
      evidence: "- Gate (final): reproduced",
      researchVerdict: "likely-misconfiguration",
      citations: demoCitations(),
      bisectRows: sampleRows(),
      fixSketch: "Use brood(0) for an empty flock.",
      reportedEnv: "Environment: ducklings 0.1.0, stock python3, no dependencies.",
      status: "reproduced",
    });
    for (const section of [
      "## Hypothesis",
      "## Evidence",
      "## Research",
      "## Bisect",
      "## Fix sketch",
      "## Environment",
    ]) {
      expect(findings).toContain(section);
    }
    expect(findings).toContain("verdict: likely-misconfiguration");
    expect(findings).toContain("https://");
    expect(findings).toContain("Linux container");
  });

  it("renders one pipe row per bisect row matching the contract pattern", () => {
    const rows: BisectRow[] = [
      { version: "0.1.0", verdict: "reproduced", reason: "boom" },
      { version: "0.2.0", verdict: "not-reproduced", reason: "fixed" },
    ];
    const findings = buildFindingsMd({
      hypothesis: "h",
      evidence: "e",
      researchVerdict: "likely-regression",
      citations: ["https://example.com/x"],
      bisectRows: rows,
      reportedEnv: "Environment: x",
      status: "reproduced",
    });
    expect(findings).toContain("verdict: likely-regression");
    const pipeLines = findings
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.includes("---") && line !== "| version | verdict |");
    expect(pipeLines).toHaveLength(2);
    for (const line of pipeLines) {
      expect(line).toMatch(/^\| [^|]+ \| (reproduced|not-reproduced|inconclusive) \|$/);
    }
    expect(ROW_RE.test(findings)).toBe(true);
  });

  it("accepts every research verdict literal", () => {
    for (const verdict of ["known-bug-fixed-later", "likely-regression", "likely-misconfiguration"] as const) {
      const findings = buildFindingsMd({
        hypothesis: "h",
        evidence: "e",
        researchVerdict: verdict,
        citations: ["https://example.com/x"],
        bisectRows: sampleRows(),
        reportedEnv: "Environment: x",
        status: "inconclusive",
      });
      expect(findings).toContain(`verdict: ${verdict}`);
    }
  });
});
