/**
 * Parse a GitHub issue URL into its identifying parts.
 *
 * Grammar: https?://(www.)?github.com/<owner>/<repo>/issues/<number>[?#...]
 * Anything else is rejected as `invalid issue url`.
 */
const ISSUE_URL_RE =
  /^(?<url>https?:\/\/(?:www\.)?github\.com\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+)\/issues\/(?<number>[1-9]\d*))(?:[/?#].*)?$/;

export interface IssueRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

export function parseIssueUrl(raw: string): IssueRef {
  const { url, owner, repo, number } = ISSUE_URL_RE.exec(raw.trim())?.groups ?? {};
  if (!url || !owner || !repo || !number) {
    throw new Error("invalid issue url");
  }
  return { url, owner, repo, number: Number(number) };
}
