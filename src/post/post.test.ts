import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DASHBOARD_BASE, isRepoAllowlisted, loadPostConfig } from "./config.js";
import { postGithubComment } from "./github-comment.js";

describe("loadPostConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function writeConfig(body: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "reproducer-post-"));
    const path = join(dir, "reproducer.config.json");
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  }

  it("reads reproducer.post.allowlist and reproducer.dashboardBase", () => {
    const path = writeConfig({
      reproducer: { post: { allowlist: ["techafreshh/reproducer"] }, dashboardBase: "https://dash.example" },
    });
    expect(loadPostConfig(path)).toEqual({
      allowlist: ["techafreshh/reproducer"],
      dashboardBase: "https://dash.example",
    });
  });

  it("drops non-string entries and trims whitespace", () => {
    const path = writeConfig({
      reproducer: { post: { allowlist: [" techafreshh/reproducer ", 42, null, "no-slash"] } },
    });
    expect(loadPostConfig(path).allowlist).toEqual(["techafreshh/reproducer"]);
  });

  it("returns empty allowlist and localhost default for a missing file", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "reproducer-post-")), "nope.json");
    expect(loadPostConfig(missing)).toEqual({ allowlist: [], dashboardBase: DEFAULT_DASHBOARD_BASE });
  });

  it("returns defaults when no path is given, honoring DASHBOARD_BASE_URL", () => {
    expect(loadPostConfig()).toEqual({ allowlist: [], dashboardBase: DEFAULT_DASHBOARD_BASE });
    vi.stubEnv("DASHBOARD_BASE_URL", "https://dash.example/base/");
    expect(loadPostConfig()).toEqual({ allowlist: [], dashboardBase: "https://dash.example/base" });
  });

  it("throws `invalid config` on malformed JSON", () => {
    const path = writeConfig("{not json");
    expect(() => loadPostConfig(path)).toThrow(/^invalid config: /);
  });
});

describe("isRepoAllowlisted", () => {
  it("matches case-insensitively after trimming", () => {
    expect(isRepoAllowlisted("techafreshh", "reproducer", ["techafreshh/reproducer"])).toBe(true);
    expect(isRepoAllowlisted("TechAFreshh", "Reproducer", [" techafreshh/reproducer "])).toBe(true);
    expect(isRepoAllowlisted("stranger", "other", ["techafreshh/reproducer"])).toBe(false);
    expect(isRepoAllowlisted("techafreshh", "reproducer", [])).toBe(false);
  });
});

describe("postGithubComment", () => {
  it("POSTs the body to /repos/{owner}/{repo}/issues/{n}/comments", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const fetch = vi.fn(async (url: string, init: unknown) => {
      calls.push({ url, init });
      return { ok: true, status: 201 } as Response;
    });
    await postGithubComment("techafreshh", "reproducer", 7, "hello findings", {
      fetch: fetch as typeof globalThis.fetch,
      token: "sekret",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/techafreshh/reproducer/issues/7/comments");
    const init = calls[0]?.init as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ body: "hello findings" });
    expect(init.headers.Accept).toBe("application/vnd.github+json");
    expect(init.headers.Authorization).toBe("Bearer sekret");
  });

  it("throws on non-2xx without logging the token", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    await expect(
      postGithubComment("o", "r", 1, "body", { fetch: fetch as typeof globalThis.fetch, token: "sekret" }),
    ).rejects.toThrow("github comment post failed: 404");
  });
});
