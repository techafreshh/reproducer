import { mkdtempSync, readFileSync } from "node:fs";
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
    for (const key of ["NEBIUS_API_KEY", "TAVILY_API_KEY", "TAVILIS_API_KEY", "GITHUB_TOKEN", "MODEL_REASON"]) {
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
