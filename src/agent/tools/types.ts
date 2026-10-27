/**
 * Shared seam for read-only ingestion (GitHub REST) and research (Tavily REST).
 *
 * `ToolClient` is the single swappable interface: the orchestrator talks only
 * to this seam, while `LiveClient` (real REST, needs keys) and
 * `FixturesClient` (canned JSON off disk, keyless) implement it. Every text
 * field in the resolved result types below is already sanitized
 * (`sanitizeUntrusted` clean text) with the union of sanitize flags surfaced
 * alongside and the joined payload wrapped via `wrapDataBlock`.
 */

/** One sanitized GitHub issue: clean strings plus flags and the data-block envelope. */
export interface GitHubIssue {
  title: string;
  body: string;
  comments: string[];
  /** Deduplicated `sanitizeUntrusted` flags across title, body, and comments. */
  flags: string[];
  /** `wrapDataBlock("issue", <joined clean text>)` envelope. */
  wrapped: string;
  /** Joined clean text backing `wrapped` (title + body + comments). */
  clean: string;
}

/** One sanitized Tavily search hit. `content` and `clean` are identical clean text. */
export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  clean: string;
  flags: string[];
}

/** Sanitized Tavily search response; `results.length` never exceeds 5. */
export interface TavilySearchResponse {
  results: TavilyResult[];
  /** Union of per-result flags, deduplicated preserving first-occurrence order. */
  flags: string[];
  /** `wrapDataBlock("tavily-search", <joined clean contents>)` envelope. */
  wrapped: string;
  /** Joined clean contents backing `wrapped`. */
  clean: string;
}

/** Sanitized Tavily extract response for a single URL. */
export interface TavilyExtractResponse {
  url: string;
  content: string;
  clean: string;
  flags: string[];
  /** `wrapDataBlock("tavily-extract", <clean content>)` envelope. */
  wrapped: string;
}

/** Options shared by `tavilySearch` across live and fixture drivers. */
export interface TavilySearchOptions {
  maxResults?: number;
}

/**
 * The single tool seam: read-only GitHub ingestion plus Tavily research.
 * All three methods sanitize through `sanitizeUntrusted` and wrap via
 * `wrapDataBlock` before returning.
 */
export interface ToolClient {
  githubGetIssue(url: string): Promise<GitHubIssue>;
  tavilySearch(query: string, opts?: TavilySearchOptions): Promise<TavilySearchResponse>;
  tavilyExtract(url: string): Promise<TavilyExtractResponse>;
}
