import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("cli main()", () => {
  let dbDir: string;
  let dbPath: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "reproducer-cli-"));
    dbPath = join(dbDir, "ledger.db");
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    vi.unstubAllEnvs();
  });

  it("creates a run, prints `run 1 created` to stdout, exits 0", () => {
    const code = main(["run", "https://github.com/octocat/hello-world/issues/1", "--db", dbPath]);
    expect(code).toBe(0);
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("run 1 created");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT issue_url FROM runs").all() as Array<{ issue_url: string }>;
    db.close();
    expect(rows.map((r) => r.issue_url)).toEqual(["https://github.com/octocat/hello-world/issues/1"]);
  });

  it("rejects a bad URL with exit 2 and `invalid issue url` on stdout", () => {
    const code = main(["run", "not-a-url", "--db", dbPath]);
    expect(code).toBe(2);
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("invalid issue url");
  });

  it("rejects unknown subcommands and missing args with exit 2", () => {
    expect(main(["serve", "--db", dbPath])).toBe(2);
    expect(main([])).toBe(2);
    expect(main(["run", "--db", dbPath])).toBe(2);
  });

  it("runs the scripted demo fixture end-to-end with no API keys", () => {
    const scriptedDb = join(dbDir, "scripted-ledger.db");
    const savedEnv = { ...process.env };
    for (const key of ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TINYFISH_API_KEY", "TAVILIS_API_KEY", "GITHUB_TOKEN", "MODEL_REASON"]) {
      delete process.env[key];
    }
    try {
      const code = main([
        "run",
        "https://github.com/demo/ducklings/issues/1",
        "--scripted",
        "fixtures/demo-1",
        "--db",
        scriptedDb,
      ]);
      expect(code).toBe(0);
      const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(output).toContain("verdict: reproduced");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
    const db = new Database(scriptedDb, { readonly: true });
    const rows = db.prepare("SELECT status, verdict FROM runs WHERE id = 1").all() as Array<{
      status: string;
      verdict: string | null;
    }>;
    db.close();
    expect(rows).toEqual([{ status: "reproduced", verdict: "reproduced" }]);
  });

  it("accepts bare --scripted and --scripted=<dir> forms", () => {
    const bareDb = join(dbDir, "bare-ledger.db");
    expect(main(["run", "https://github.com/demo/ducklings/issues/1", "--scripted", "--db", bareDb])).toBe(0);
    expect(log.mock.calls.map((args) => args.join(" ")).join("\n")).toContain("verdict: reproduced");

    log.mockClear();
    const eqDb = join(dbDir, "eq-ledger.db");
    expect(
      main(["run", "https://github.com/demo/ducklings/issues/1", "--scripted=fixtures/demo-1", "--db", eqDb]),
    ).toBe(0);
    expect(log.mock.calls.map((args) => args.join(" ")).join("\n")).toContain("verdict: reproduced");
  });

  it("exits 2 with usage on stdout for a missing fixture dir", () => {
    const code = main([
      "run",
      "https://github.com/demo/ducklings/issues/1",
      "--scripted",
      join(dbDir, "no-such-fixture"),
      "--db",
      join(dbDir, "missing-ledger.db"),
    ]);
    expect(code).toBe(2);
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("missing fixture");
    expect(output).toContain("usage:");
  });
});

describe("cli replay mode", () => {
  let dbDir: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "reproducer-cli-replay-"));
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    vi.unstubAllEnvs();
  });

  function stdout(): string {
    return log.mock.calls.map((args) => args.join(" ")).join("\n");
  }

  function runStatus(dbPath: string, id: number): string | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT status FROM runs WHERE id = ?").all(id) as Array<{ status: string }>;
      return rows[0]?.status ?? null;
    } finally {
      db.close();
    }
  }

  it("replays demo-1 to reproduced with no API keys", async () => {
    const dbPath = join(dbDir, "replay-ledger.db");
    const code = await main([
      "run",
      "https://github.com/demo/ducklings/issues/1",
      "--replay",
      "fixtures/demo-1",
      "--db",
      dbPath,
    ]);
    expect(code).toBe(0);
    expect(stdout()).toContain("verdict: reproduced");
    expect(runStatus(dbPath, 1)).toBe("reproduced");
  });

  it("accepts bare --replay and --replay=<dir> forms", async () => {
    const bareDb = join(dbDir, "bare-ledger.db");
    expect(await main(["run", "https://github.com/demo/ducklings/issues/1", "--replay", "--db", bareDb])).toBe(0);
    expect(stdout()).toContain("verdict: reproduced");

    log.mockClear();
    const eqDb = join(dbDir, "eq-ledger.db");
    expect(
      await main(["run", "https://github.com/demo/ducklings/issues/1", "--replay=fixtures/demo-1", "--db", eqDb]),
    ).toBe(0);
    expect(stdout()).toContain("verdict: reproduced");
  });

  it("replays demo-2 and demo-3 to their expected.json statuses", async () => {
    for (const bundle of ["demo-2", "demo-3"]) {
      const expected = JSON.parse(
        readFileSync(join("fixtures", bundle, "expected.json"), "utf8"),
      ) as { url: string; expectedStatus: string };
      const dbPath = join(dbDir, `${bundle}-ledger.db`);
      log.mockClear();
      const code = await main(["run", expected.url, "--replay", join("fixtures", bundle), "--db", dbPath]);
      expect(code).toBe(0);
      expect(stdout()).toContain(`verdict: ${expected.expectedStatus}`);
      expect(runStatus(dbPath, 1)).toBe(expected.expectedStatus);
    }
  });

  it("honors REPLAY=1 with no --replay flag", async () => {
    vi.stubEnv("REPLAY", "1");
    const dbPath = join(dbDir, "env-ledger.db");
    const code = await main(["run", "https://github.com/demo/ducklings/issues/1", "--db", dbPath]);
    expect(code).toBe(0);
    expect(stdout()).toContain("verdict: reproduced");
    expect(runStatus(dbPath, 1)).toBe("reproduced");
  });

  it("prefers an explicit --replay flag over the REPLAY env toggle", async () => {
    vi.stubEnv("REPLAY", "1");
    const dbPath = join(dbDir, "flag-wins-ledger.db");
    const code = await main([
      "run",
      "https://github.com/demo/calcbox/issues/2",
      "--replay",
      "fixtures/demo-2",
      "--db",
      dbPath,
    ]);
    expect(code).toBe(0);
    expect(stdout()).toContain("verdict: reproduced");
    expect(runStatus(dbPath, 1)).toBe("reproduced");
  });

  it("exits 2 with `missing fixture: issue.json` for a fixture dir without one", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "reproducer-replay-noissue-"));
    const code = await main([
      "run",
      "https://github.com/demo/ducklings/issues/1",
      "--replay",
      emptyDir,
      "--db",
      join(dbDir, "nofixture-ledger.db"),
    ]);
    expect(code).toBe(2);
    expect(stdout()).toContain("missing fixture: issue.json");
    expect(stdout()).toContain("usage:");
  });
});

describe("cli --post with repo allowlist", () => {
  let dbDir: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "reproducer-cli-post-"));
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stdout(): string {
    return log.mock.calls.map((args) => args.join(" ")).join("\n");
  }

  function writeAllowlistConfig(allowlist: string[], dashboardBase?: string): string {
    const path = join(dbDir, `post-config-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
    writeFileSync(
      path,
      JSON.stringify({ reproducer: { post: { allowlist }, dashboardBase } }),
    );
    return path;
  }

  function commentCalls(fetchStub: ReturnType<typeof vi.fn>): Array<{ url: string; init: Record<string, unknown> }> {
    return fetchStub.mock.calls
      .filter(([url]) => typeof url === "string" && /\/issues\/\d+\/comments$/.test(url))
      .map(([url, init]) => ({ url: url as string, init: (init ?? {}) as Record<string, unknown> }));
  }

  function eventKinds(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT kind FROM events").all() as Array<{ kind: string }>;
      return rows.map((row) => row.kind);
    } finally {
      db.close();
    }
  }

  it("run without --post makes zero comment calls and records no post_comment event", () => {
    const fetchStub = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
    vi.stubGlobal("fetch", fetchStub);
    const dbPath = join(dbDir, "nopost-ledger.db");
    const code = main([
      "run",
      "https://github.com/demo/ducklings/issues/1",
      "--scripted",
      "fixtures/demo-1",
      "--db",
      dbPath,
    ]);
    expect(code).toBe(0);
    expect(stdout()).toContain("verdict: reproduced");
    expect(commentCalls(fetchStub)).toHaveLength(0);
    expect(eventKinds(dbPath)).not.toContain("post_comment");
  });

  it("--post with a non-allowlisted repo exits 3 with the sentinel and posts nothing", () => {
    const fetchStub = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
    vi.stubGlobal("fetch", fetchStub);
    const config = writeAllowlistConfig(["techafreshh/reproducer"]);
    const code = main([
      "run",
      "https://github.com/stranger/other/issues/9",
      "--scripted",
      "fixtures/demo-1",
      "--post",
      "--config",
      config,
      "--db",
      join(dbDir, "denied-ledger.db"),
    ]);
    expect(code).toBe(3);
    expect(stdout()).toContain("repo not in post allowlist");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("--post with an allowlisted repo posts findings.md and records a github_comment event", async () => {
    const fetchStub = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
    vi.stubGlobal("fetch", fetchStub);
    const config = writeAllowlistConfig(["techafreshh/reproducer"], "https://dash.example");
    const dbPath = join(dbDir, "posted-ledger.db");
    const code = await main([
      "run",
      "https://github.com/techafreshh/reproducer/issues/17",
      "--scripted",
      "fixtures/demo-1",
      "--post",
      "--config",
      config,
      "--db",
      dbPath,
    ]);
    expect(code).toBe(0);
    expect(stdout()).toContain("verdict: reproduced");

    const comments = commentCalls(fetchStub);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.url).toBe("https://api.github.com/repos/techafreshh/reproducer/issues/17/comments");
    const sent = JSON.parse(String((comments[0]?.init as { body: string }).body)) as { body: string };
    expect(sent.body).toContain("Trace: https://dash.example/runs/1");

    const db = new Database(dbPath, { readonly: true });
    try {
      const findings = (
        db.prepare("SELECT content FROM artifacts WHERE run_id = 1 AND name = 'findings.md'").get() as {
          content: string;
        }
      ).content;
      expect(sent.body).toContain(findings);
      const events = db
        .prepare("SELECT payload_json FROM events WHERE kind = 'post_comment'")
        .all() as Array<{ payload_json: string }>;
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]?.payload_json ?? "{}") as { kind: string; body: string };
      expect(payload.kind).toBe("github_comment");
      expect(payload.body).toContain(findings);
    } finally {
      db.close();
    }
  });
});
