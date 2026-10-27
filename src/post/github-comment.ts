export type FetchFn = typeof fetch;

export interface PostCommentOptions {
  /** Optional Bearer token (defaults to `GITHUB_TOKEN` env); absent means anonymous. */
  token?: string;
  /** Injectable fetch; defaults to `globalThis.fetch` at call time. */
  fetch?: FetchFn;
  /** API base override for stub servers; defaults to `https://api.github.com`. */
  baseUrl?: string;
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  if (token !== undefined && token !== "") {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function resolveBase(explicit?: string): string {
  const raw =
    explicit ??
    (typeof process.env.GITHUB_API_BASE_URL === "string" &&
    process.env.GITHUB_API_BASE_URL.trim().length > 0
      ? process.env.GITHUB_API_BASE_URL
      : "https://api.github.com");
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Post a GitHub issue comment via REST
 * (`POST /repos/{owner}/{repo}/issues/{number}/comments`).
 * Mirrors `githubGetIssue` in `src/agent/tools/github.ts`: dependency-free
 * `fetch` with an injectable seam for scripted clients. Throws
 * `github comment post failed: <status>` on non-2xx. The token is never
 * logged.
 */
export async function postGithubComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  opts: PostCommentOptions = {},
): Promise<void> {
  const doFetch: FetchFn = opts.fetch ?? globalThis.fetch;
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const url = `${resolveBase(opts.baseUrl)}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const res = await doFetch(url, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`github comment post failed: ${res.status}`);
  }
}
