import { describe, expect, it } from "vitest";
import { parseIssueUrl } from "./issue-url.ts";

describe("parseIssueUrl", () => {
  it("parses the acceptance URL", () => {
    expect(parseIssueUrl("https://github.com/octocat/hello-world/issues/1")).toEqual({
      url: "https://github.com/octocat/hello-world/issues/1",
      owner: "octocat",
      repo: "hello-world",
      number: 1,
    });
  });

  it("tolerates trailing slash, query, and fragment", () => {
    const cases = [
      "https://github.com/octocat/hello-world/issues/1/",
      "https://github.com/octocat/hello-world/issues/1?q=2",
      "https://github.com/octocat/hello-world/issues/1#issuecomment-1",
    ];
    for (const c of cases) {
      expect(parseIssueUrl(c).number).toBe(1);
      expect(parseIssueUrl(c).owner).toBe("octocat");
    }
  });

  it("accepts http and www variants", () => {
    expect(parseIssueUrl("http://www.github.com/a/b/issues/42").number).toBe(42);
  });

  it("rejects non-URLs", () => {
    expect(() => parseIssueUrl("not-a-url")).toThrow("invalid issue url");
    expect(() => parseIssueUrl("")).toThrow("invalid issue url");
  });

  it("rejects wrong host, path kind, or malformed number", () => {
    const cases = [
      "https://github.com/octocat",
      "https://github.com/octocat/hello-world",
      "https://github.com/octocat/hello-world/pulls/1",
      "https://gitlab.com/octocat/hello-world/issues/1",
      "https://github.com/octocat/hello-world/issues/0",
      "https://github.com/octocat/hello-world/issues/abc",
      "https://github.com/octocat/hello-world/issues/",
    ];
    for (const c of cases) {
      expect(() => parseIssueUrl(c), c).toThrow("invalid issue url");
    }
  });
});
