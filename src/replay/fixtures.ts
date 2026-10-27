/**
 * Tool-layer drivers behind the `ToolClient` seam: `LiveClient` (real REST via
 * injected `fetch`, keys from env) and `FixturesClient` (canned JSON off disk,
 * keyless replay). Fixture loading reproduces the live sanitize+wrap path so
 * fixture and live outputs are shape-identical.
 *
 * Fixture layout (base dir = `fixtures/<case>`):
 * - `<base>/issue.json`
 * - `<base>/tavily/<sha256(query)>.json` (lowercase hex of the raw query)
 * - `<base>/tavily-extract/<sha256(url)>.json` (extract; falls back to
 *   `<base>/tavily/<sha256(url)>.json`)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { githubGetIssue, mapGitHubIssue, type FetchFn } from "../agent/tools/github.js";
import { mapTavilyExtract, mapTavilySearchResults } from "../agent/tools/tavily.js";
import { tavilyExtract, tavilySearch } from "../agent/tools/tavily.js";
import { parseIssueUrl } from "../issue-url.js";

export type {
  GitHubIssue,
  TavilyExtractResponse,
  TavilyResult,
  TavilySearchResponse,
  ToolClient,
} from "../agent/tools/types.js";
import type {
  GitHubIssue,
  TavilyExtractResponse,
  TavilySearchOptions,
  TavilySearchResponse,
  ToolClient,
} from "../agent/tools/types.js";

/** Default fixture directory for a bare `--replay` flag or a bare `REPLAY=1` toggle. */
export const DEFAULT_REPLAY_DIR = "fixtures/demo-1";

/** `REPLAY=1` (also `true`/`yes`, case-insensitive) opts into replay mode. */
export function isReplayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.REPLAY;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Resolve the replay fixture directory: an explicit `--replay <dir>` flag
 * wins; otherwise a truthy `REPLAY` env falls back to the default bundle.
 * Returns `undefined` when replay mode is off entirely.
 */
export function resolveFixtureDir(
  cliDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (cliDir !== undefined) return cliDir;
  if (isReplayEnabled(env)) return DEFAULT_REPLAY_DIR;
  return undefined;
}

/** Lowercase hex `sha256` of the raw string; no salting or normalization. */
export function fixtureHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Pull result payloads out of the legacy `tavily.json` shape
 * (`{searches: [{query, results}]}` or `{results}` or a bare array): the
 * query-matching entry when present, else the first entry. Returns `null`
 * when the legacy file carries nothing usable so the caller fails loudly.
 */
function legacySearchResults(canned: unknown, query: string): unknown | null {
  if (Array.isArray(canned)) return canned;
  if (typeof canned !== "object" || canned === null) return null;
  const root = canned as Record<string, unknown>;
  if (Array.isArray(root.results)) return root.results;
  const searches = root.searches;
  if (!Array.isArray(searches)) return null;
  for (const entry of searches) {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (record.query === query && Array.isArray(record.results)) return record.results;
    }
  }
  const first: unknown = searches[0];
  if (
    typeof first === "object" &&
    first !== null &&
    Array.isArray((first as Record<string, unknown>).results)
  ) {
    return (first as Record<string, unknown>).results;
  }
  return null;
}

function toCommentPayloads(value: unknown): Array<{ body?: unknown }> {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((entry) =>
    typeof entry === "string" ? { body: entry } : (entry as { body?: unknown }),
  );
}

/**
 * Live driver: real GitHub/Tavily REST. The only module allowed to read
 * `process.env` (here in the constructor); the tool functions themselves take
 * keys via options so tests stay hermetic.
 */
export class LiveClient implements ToolClient {
  private readonly tavilyApiKey: string | undefined;
  private readonly githubToken: string | undefined;
  private readonly fetchFn: FetchFn | undefined;

  constructor(env?: NodeJS.ProcessEnv, fetchFn?: FetchFn) {
    const source = env ?? process.env;
    const tavilyApiKey = source.TAVILY_API_KEY;
    this.tavilyApiKey = tavilyApiKey === "" ? undefined : tavilyApiKey;
    const githubToken = source.GITHUB_TOKEN;
    this.githubToken = githubToken === "" ? undefined : githubToken;
    this.fetchFn = fetchFn;
  }

  async githubGetIssue(url: string): Promise<GitHubIssue> {
    return githubGetIssue(url, { token: this.githubToken, fetch: this.fetchFn });
  }

  async tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<TavilySearchResponse> {
    return tavilySearch(query, { maxResults: opts.maxResults, apiKey: this.tavilyApiKey, fetch: this.fetchFn });
  }

  async tavilyExtract(url: string): Promise<TavilyExtractResponse> {
    return tavilyExtract(url, { apiKey: this.tavilyApiKey, fetch: this.fetchFn });
  }
}

/**
 * Fixture driver: canned JSON off disk for keyless CI/replay. Takes the case
 * base dir (`fixtures/<case>`); every load flows through the same pure mappers
 * as the live path so outputs are shape-identical.
 */
export class FixturesClient implements ToolClient {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private issueCandidates(): string[] {
    return [join(this.baseDir, "issue.json")];
  }

  private tavilyCandidates(queryOrUrl: string): string[] {
    const hash = fixtureHash(queryOrUrl);
    return [join(this.baseDir, "tavily", `${hash}.json`)];
  }

  private extractCandidates(url: string): string[] {
    const hash = fixtureHash(url);
    return [join(this.baseDir, "tavily-extract", `${hash}.json`), join(this.baseDir, "tavily", `${hash}.json`)];
  }

  async githubGetIssue(url: string): Promise<GitHubIssue> {
    // Validate through the shared grammar so the `invalid issue url` sentinel matches live.
    parseIssueUrl(url);
    const found = firstExisting(this.issueCandidates());
    if (found === null) {
      throw new Error(`missing fixture: ${basename(this.issueCandidates()[0] ?? "issue.json")}`);
    }
    const canned = readJsonFile(found) as Record<string, unknown>;
    const comments = toCommentPayloads(canned.comments);
    return mapGitHubIssue({ title: canned.title, body: canned.body }, comments);
  }

  async tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<TavilySearchResponse> {
    const hashed = this.tavilyCandidates(query)[0] ?? join(this.baseDir, "tavily", `${fixtureHash(query)}.json`);
    const found = firstExisting(this.tavilyCandidates(query));
    if (found !== null) {
      const canned = readJsonFile(found) as unknown;
      const rawResults = Array.isArray(canned)
        ? canned
        : (canned as { results?: unknown }).results ?? [];
      return mapTavilySearchResults(rawResults, opts.maxResults);
    }
    // Legacy fallback: the pre-hash `tavily.json` bundle still replays.
    const legacy = join(this.baseDir, "tavily.json");
    if (existsSync(legacy)) {
      const fallback = legacySearchResults(readJsonFile(legacy), query);
      if (fallback !== null) {
        return mapTavilySearchResults(fallback, opts.maxResults);
      }
    }
    throw new Error(`missing fixture: ${basename(hashed)}`);
  }

  async tavilyExtract(url: string): Promise<TavilyExtractResponse> {
    const found = firstExisting(this.extractCandidates(url));
    if (found === null) {
      throw new Error(`missing fixture: ${basename(this.extractCandidates(url)[0] ?? "tavily-extract")}`);
    }
    return mapTavilyExtract(readJsonFile(found), url);
  }
}
