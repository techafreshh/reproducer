import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  getArtifact,
  getEvents,
  getRun,
  getRunSummary,
  getSymptomSpec,
  insertRun,
  isSymptomSpecFrozen,
  latchSymptomSpec,
  listRuns,
  openLedger,
  putArtifact,
  putSymptomSpec,
  type Ledger,
} from "./ledger.js";

describe("ledger", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("inserts runs starting at id 1 with status created", () => {
    expect(insertRun(db, "https://github.com/octocat/hello-world/issues/1")).toBe(1);
    const row = db.prepare("SELECT issue_url, status FROM runs WHERE id = 1").get() as {
      issue_url: string;
      status: string;
    };
    expect(row.issue_url).toBe("https://github.com/octocat/hello-world/issues/1");
    expect(row.status).toBe("created");
  });

  it("increments ids across inserts", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    expect(insertRun(db, "https://github.com/a/b/issues/2")).toBe(2);
  });

  it("defaults verdict and budget to null", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    const run = getRun(db, 1);
    expect(run?.verdict).toBeNull();
    expect(run?.budget).toBeNull();
  });
});

describe("ledger events", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("assigns sequence numbers starting at 1", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    expect(appendEvent(db, 1, "note", { step: 1 })).toBe(1);
    expect(appendEvent(db, 1, "gate", { step: 2 })).toBe(2);
    expect(getEvents(db, 1).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("keeps sequence numbers independent per run", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    insertRun(db, "https://github.com/a/b/issues/2");
    appendEvent(db, 1, "note", {});
    appendEvent(db, 2, "note", {});
    expect(getEvents(db, 2).map((e) => e.seq)).toEqual([1]);
  });

  it("stores payload_json as the exact serialized string", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    appendEvent(db, 1, "gate", { verdict: "reproduced", attempts: 2 });
    const [event] = getEvents(db, 1);
    expect(event?.run_id).toBe(1);
    expect(event?.kind).toBe("gate");
    expect(event?.payload_json).toBe('{"verdict":"reproduced","attempts":2}');
  });

  it("returns events in insertion order and none for unknown runs", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    appendEvent(db, 1, "note", { n: 2 });
    appendEvent(db, 1, "note", { n: 1 });
    expect(getEvents(db, 1).map((e) => e.seq)).toEqual([1, 2]);
    expect(getEvents(db, 999)).toEqual([]);
  });
});

describe("ledger artifacts", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("stores and returns artifact content", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    putArtifact(db, 1, "repro.py", "print('hi')\n");
    const artifact = getArtifact(db, 1, "repro.py");
    expect(artifact?.name).toBe("repro.py");
    expect(artifact?.content).toBe("print('hi')\n");
    expect(typeof artifact?.created_at).toBe("string");
  });

  it("overwrites content on re-put, keeping a single row", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    putArtifact(db, 1, "findings.md", "v1");
    putArtifact(db, 1, "findings.md", "v2");
    const rows = db
      .prepare("SELECT content FROM artifacts WHERE run_id = 1 AND name = 'findings.md'")
      .all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("v2");
  });

  it("returns null for unknown names and runs", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    putArtifact(db, 1, "repro.py", "print('hi')");
    expect(getArtifact(db, 1, "nope.md")).toBeNull();
    expect(getArtifact(db, 999, "repro.py")).toBeNull();
  });
});

describe("ledger symptom specs", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips a nested-object spec", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    const spec = { symptom: { line: 7, message: "boom" }, hypothesis: "off-by-one" };
    putSymptomSpec(db, 1, spec);
    expect(getSymptomSpec(db, 1)).toEqual(spec);
  });

  it("replaces the spec on re-put, keeping one row", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    putSymptomSpec(db, 1, { a: 1 });
    putSymptomSpec(db, 1, { b: 2 });
    expect(getSymptomSpec(db, 1)).toEqual({ b: 2 });
    expect((db.prepare("SELECT COUNT(*) AS c FROM symptom_specs").get() as { c: number }).c).toBe(1);
  });

  it("returns null when no spec is frozen", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    expect(getSymptomSpec(db, 1)).toBeNull();
  });

  it("stays overwritable by re-put while unfrozen", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    putSymptomSpec(db, 1, { a: 1 });
    putSymptomSpec(db, 1, { b: 2 });
    expect(getSymptomSpec(db, 1)).toEqual({ b: 2 });
    expect(isSymptomSpecFrozen(db, 1)).toBe(false);
  });

  it("rejects putSymptomSpec with the exact sentinel once latched", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    latchSymptomSpec(db, 1, { final: true });
    try {
      putSymptomSpec(db, 1, { final: false });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("spec already frozen");
    }
    expect(getSymptomSpec(db, 1)).toEqual({ final: true });
  });

  it("latches a draft spec in place", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    putSymptomSpec(db, 1, { draft: 1 });
    latchSymptomSpec(db, 1, { draft: 2 });
    expect(isSymptomSpecFrozen(db, 1)).toBe(true);
    expect(getSymptomSpec(db, 1)).toEqual({ draft: 2 });
    expect((db.prepare("SELECT COUNT(*) AS c FROM symptom_specs").get() as { c: number }).c).toBe(1);
  });

  it("refuses raw SQL writes on a latched spec via the SQLite triggers", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    latchSymptomSpec(db, 1, { ok: 1 });
    try {
      db.prepare("UPDATE symptom_specs SET spec_json = '{}' WHERE run_id = 1").run();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("spec already frozen");
    }
    try {
      db.prepare("INSERT INTO symptom_specs (run_id, spec_json) VALUES (1, '{}')").run();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("spec already frozen");
    }
    try {
      db.prepare("DELETE FROM symptom_specs WHERE run_id = 1").run();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("spec already frozen");
    }
    expect(getSymptomSpec(db, 1)).toEqual({ ok: 1 });
  });

  it("tracks frozen state per run, false for unknown runs", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    insertRun(db, "https://github.com/a/b/issues/2");
    latchSymptomSpec(db, 1, { ok: 1 });
    expect(isSymptomSpecFrozen(db, 1)).toBe(true);
    expect(isSymptomSpecFrozen(db, 2)).toBe(false);
    expect(isSymptomSpecFrozen(db, 999)).toBe(false);
  });
});

describe("ledger run detail queries", () => {
  let db: Ledger;

  beforeEach(() => {
    db = openLedger(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for unknown, NaN, and non-integer ids", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    expect(getRun(db, 999)).toBeNull();
    expect(getRun(db, Number.NaN)).toBeNull();
    expect(getRun(db, Number("abc"))).toBeNull();
  });

  it("lists runs ordered by id, empty when fresh", () => {
    expect(listRuns(db)).toEqual([]);
    insertRun(db, "https://github.com/a/b/issues/1");
    insertRun(db, "https://github.com/a/b/issues/2");
    expect(listRuns(db).map((r) => r.id)).toEqual([1, 2]);
  });

  it("reads verdict and parsed budget after raw column updates", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    db.prepare("UPDATE runs SET verdict = ?, budget = ? WHERE id = 1").run("reproduced", '{"sandbox_runs":3}');
    const run = getRun(db, 1);
    expect(run?.verdict).toBe("reproduced");
    expect(run?.budget).toEqual({ sandbox_runs: 3 });
    expect(listRuns(db)[0]?.budget).toEqual({ sandbox_runs: 3 });
  });

  it("reads an unparseable budget as null without throwing", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    db.prepare("UPDATE runs SET budget = ? WHERE id = 1").run("not json");
    expect(getRun(db, 1)?.budget).toBeNull();
  });

  it("summarizes event count and artifact names in creation order", () => {
    insertRun(db, "https://github.com/a/b/issues/1");
    expect(getRunSummary(db, 1)).toEqual({ events: 0, artifacts: [] });
    appendEvent(db, 1, "note", {});
    putArtifact(db, 1, "repro.py", "print(1)");
    putArtifact(db, 1, "findings.md", "nothing");
    expect(getRunSummary(db, 1)).toEqual({ events: 1, artifacts: ["repro.py", "findings.md"] });
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
    insertRun(db, "https://github.com/octocat/hello-world/issues/1");
    db.close();
    db = openLedger(dbPath);
    const urls = db.prepare("SELECT issue_url FROM runs").all() as Array<{ issue_url: string }>;
    expect(urls.map((r) => r.issue_url)).toEqual(["https://github.com/octocat/hello-world/issues/1"]);
  });

  it("migrates a pre-issue-2 runs table in place", () => {
    const dbPath = join(dir, "old-ledger.db");
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_url TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    old.prepare("INSERT INTO runs (issue_url, status) VALUES (?, 'created')").run("https://github.com/a/b/issues/1");
    old.close();

    db = openLedger(dbPath);
    const columns = (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["verdict", "budget"]));
    const migrated = getRun(db, 1);
    expect(migrated?.verdict).toBeNull();
    expect(migrated?.budget).toBeNull();
    expect(insertRun(db, "https://github.com/a/b/issues/2")).toBe(2);
  });

  it("migrates a pre-issue-4 symptom_specs table in place", () => {
    const dbPath = join(dir, "old-specs.db");
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE symptom_specs (
        run_id INTEGER PRIMARY KEY,
        spec_json TEXT NOT NULL,
        frozen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    old.prepare("INSERT INTO symptom_specs (run_id, spec_json) VALUES (7, '{\"draft\":true}')").run();
    old.close();

    db = openLedger(dbPath);
    const columns = (db.prepare("PRAGMA table_info(symptom_specs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["frozen"]));
    // Pre-existing drafts migrate unfrozen with their spec intact.
    expect(getSymptomSpec(db, 7)).toEqual({ draft: true });
    expect(isSymptomSpecFrozen(db, 7)).toBe(false);
    // The latch works on the migrated table.
    latchSymptomSpec(db, 7, { draft: false });
    expect(isSymptomSpecFrozen(db, 7)).toBe(true);
  });
});
