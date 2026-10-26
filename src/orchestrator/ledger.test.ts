import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRun, openLedger, type Ledger } from "./ledger.ts";

describe("ledger", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates runs starting at id 1 with status created", () => {
    expect(createRun(db, "https://github.com/octocat/hello-world/issues/1")).toBe(1);
    const row = db.prepare("SELECT issue_url, status FROM runs WHERE id = 1").get() as {
      issue_url: string;
      status: string;
    };
    expect(row.issue_url).toBe("https://github.com/octocat/hello-world/issues/1");
    expect(row.status).toBe("created");
  });

  it("increments ids across inserts", () => {
    createRun(db, "https://github.com/a/b/issues/1");
    expect(createRun(db, "https://github.com/a/b/issues/2")).toBe(2);
  });
});

describe("openLedger on a file path", () => {
  let dir: string;
  let db: Ledger | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reproducer-ledger-"));
  });

  afterEach(() => {
    db?.close();
  });

  it("creates the parent directory and persists rows", () => {
    const dbPath = join(dir, "nested", "ledger.db");
    db = openLedger(dbPath);
    createRun(db, "https://github.com/octocat/hello-world/issues/1");
    db.close();
    db = openLedger(dbPath);
    const urls = db.prepare("SELECT issue_url FROM runs").all() as Array<{ issue_url: string }>;
    expect(urls.map((r) => r.issue_url)).toEqual(["https://github.com/octocat/hello-world/issues/1"]);
  });
});
