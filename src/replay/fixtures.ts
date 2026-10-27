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
import { join } from "node:path";
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
      throw new Error(`missing fixture: ${this.issueCandidates()[0]}`);
    }
    const canned = readJsonFile(found) as Record<string, unknown>;
    const comments = toCommentPayloads(canned.comments);
    return mapGitHubIssue({ title: canned.title, body: canned.body }, comments);
  }

  async tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<TavilySearchResponse> {
    const found = firstExisting(this.tavilyCandidates(query));
    if (found === null) {
      throw new Error(`missing fixture: ${this.tavilyCandidates(query)[0]}`);
    }
    const canned = readJsonFile(found) as unknown;
    const rawResults = Array.isArray(canned)
      ? canned
      : (canned as { results?: unknown }).results ?? [];
    return mapTavilySearchResults(rawResults, opts.maxResults);
  }

  async tavilyExtract(url: string): Promise<TavilyExtractResponse> {
    const found = firstExisting(this.extractCandidates(url));
    if (found === null) {
      throw new Error(`missing fixture: ${this.extractCandidates(url)[0]}`);
    }
    return mapTavilyExtract(readJsonFile(found), url);
  }
}
