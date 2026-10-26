import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";

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
});
