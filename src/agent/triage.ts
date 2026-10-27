/**
 * Triage session: untrusted issue text → validated, frozen symptom spec.
 *
 * Flow: sanitize body + comments (`sanitizeUntrusted`), wrap the clean text
 * with `wrapDataBlock("issue", ...)`, run one fast-model call, validate the
 * returned JSON against `SymptomSpecSchema`, freeze it via
 * `freezeSymptomSpec`, then derive research queries from the frozen spec.
 * The `spec already frozen` sentinel from the gate is never caught here.
 */
import { freezeSymptomSpec, validateSymptomSpec, type SymptomSpec } from "../gate/spec.js";
import { createProvider, type TriageProvider } from "../llm/provider.js";
import { appendEvent, openLedger, putArtifact, type Ledger } from "../orchestrator/ledger.js";
import { sanitizeUntrusted, wrapDataBlock } from "../sanitize/sanitizer.js";

/** Triage input: GitHub issue body plus comment bodies, all untrusted. */
export interface TriageIssue {
  body: string;
  comments?: string[];
}

/**
 * Derive 2–4 research queries from a frozen spec: one `<library>
 * <errorString>` query per error string (truncated to 200 chars), clamped
 * into range by splitting multi-part error strings and joining with
 * trigger/symptomClass fallbacks.
 */
export function deriveResearchQueries(spec: SymptomSpec): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  const push = (query: string): void => {
    const clipped = query.slice(0, 200);
    if (clipped.length > 0 && !seen.has(clipped)) {
      seen.add(clipped);
      queries.push(clipped);
    }
  };
  for (const errorString of spec.errorStrings) {
    const trimmed = errorString.trim();
    if (trimmed.length > 0) {
      push(`${spec.library} ${trimmed}`);
    }
  }
  if (queries.length < 2) {
    for (const errorString of spec.errorStrings) {
      for (const part of errorString.split(/[:\n;|]+/)) {
        const trimmed = part.trim();
        if (trimmed.length > 0) {
          push(`${spec.library} ${trimmed}`);
        }
        if (queries.length >= 2) {
          break;
        }
      }
      if (queries.length >= 2) {
        break;
      }
    }
  }
  if (queries.length < 2) {
    push(`${spec.library} ${spec.trigger}`);
  }
  if (queries.length < 2) {
    push(`${spec.library} ${spec.symptomClass}`);
  }
  const capped = queries.slice(0, 4);
  while (capped.length < 2) {
    capped.push(capped[0] ?? (spec.library.length > 0 ? spec.library : "lib"));
  }
  return capped;
}

/**
 * Run triage for `runId`: sanitize → prompt → complete → validate → freeze →
 * research queries. Returns the frozen spec and the stored queries. Throws
 * `spec validation failed: <detail>` on bad JSON or schema violations without
 * freezing; a re-freeze throws the gate's `spec already frozen` sentinel.
 */
export async function runTriage(
  runId: number,
  issue: TriageIssue,
  provider: TriageProvider = createProvider(),
  db: Ledger = openLedger(),
): Promise<{ spec: SymptomSpec; queries: string[] }> {
  const texts = [issue.body, ...(issue.comments ?? [])];
  const cleans: string[] = [];
  const flagSet = new Set<string>();
  for (const text of texts) {
    const result = sanitizeUntrusted(text);
    cleans.push(result.clean);
    for (const flag of result.flags) {
      flagSet.add(flag);
    }
  }
  const flags = [...flagSet];
  if (flags.length > 0) {
    appendEvent(db, runId, "sanitize_flag", { flags, source: "issue" });
  }
  const prompt = [
    "Summarize the bug report below as a symptom spec.",
    "Return spec JSON only: an object with library, versions, symptomClass, errorStrings, frames, trigger, expectedOutput.",
    wrapDataBlock("issue", cleans.join("\n\n")),
  ].join("\n\n");
  const raw = await provider.completeTriage(prompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`spec validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let spec: SymptomSpec;
  try {
    spec = validateSymptomSpec(parsed);
  } catch (error) {
    throw new Error(`spec validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  freezeSymptomSpec(runId, spec, db);
  const queries = deriveResearchQueries(spec);
  putArtifact(db, runId, "research_queries", JSON.stringify(queries));
  return { spec, queries };
}
