/**
 * Live GitHub issue ingestion: public REST `GET /repos/{owner}/{repo}/issues/{n}`
 * plus first-page `GET .../comments`. Every text field is sanitized with
 * `sanitizeUntrusted` and the joined payload is wrapped with
 * `wrapDataBlock("issue", …)` at the tool boundary.
 */
import { parseIssueUrl } from "../../issue-url.js";
import { sanitizeUntrusted, wrapDataBlock } from "../../sanitize/sanitizer.js";
import type { GitHubIssue } from "./types.js";

export type FetchFn = typeof fetch;

export interface GitHubGetIssueOptions {
  fetch?: FetchFn;
  /** Optional Bearer token to raise rate limits; absent means anonymous. */
  token?: string;
}

interface IssuePayload {
  title?: unknown;
  body?: unknown;
}

interface CommentPayload {
  body?: unknown;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Pure response mapper: raw issue + comment payloads → sanitized `GitHubIssue`.
 * Separately testable from the `fetch`-doing `githubGetIssue` below.
 */
export function mapGitHubIssue(issue: IssuePayload, comments: CommentPayload[]): GitHubIssue {
  const rawTitle = toText(issue.title);
  const rawBody = toText(issue.body);
  const rawComments = comments.map((comment) => toText(comment.body));
  const title = sanitizeUntrusted(rawTitle);
  const body = sanitizeUntrusted(rawBody);
  const cleanedComments = rawComments.map((comment) => sanitizeUntrusted(comment));
  const seen = new Set<string>();
  const flags: string[] = [];
  for (const result of [title, body, ...cleanedComments]) {
    for (const flag of result.flags) {
      if (!seen.has(flag)) {
        seen.add(flag);
        flags.push(flag);
      }
    }
  }
  const clean = [title.clean, body.clean, ...cleanedComments.map((comment) => comment.clean)].join("\n\n");
  return {
    title: title.clean,
    body: body.clean,
    comments: cleanedComments.map((comment) => comment.clean),
    flags,
    wrapped: wrapDataBlock("issue", clean),
    clean,
  };
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (token !== undefined && token !== "") {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fetch a GitHub issue plus its comments. Validates via `parseIssueUrl`
 * (rethrown `invalid issue url` sentinel); throws on non-2xx REST responses.
 */
export async function githubGetIssue(url: string, opts: GitHubGetIssueOptions = {}): Promise<GitHubIssue> {
  const ref = parseIssueUrl(url);
  const doFetch: FetchFn = opts.fetch ?? globalThis.fetch;
  const headers = authHeaders(opts.token);
  const issueRes = await doFetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
    { headers },
  );
  if (!issueRes.ok) {
    throw new Error(`github issue fetch failed: ${issueRes.status}`);
  }
  const commentsRes = await doFetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
    { headers },
  );
  if (!commentsRes.ok) {
    throw new Error(`github comments fetch failed: ${commentsRes.status}`);
  }
  const issue = (await issueRes.json()) as IssuePayload;
  const commentsRaw = (await commentsRes.json()) as unknown;
  const comments: CommentPayload[] = Array.isArray(commentsRaw) ? (commentsRaw as CommentPayload[]) : [];
  return mapGitHubIssue(issue, comments);
}
