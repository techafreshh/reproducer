import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Ledger = Database.Database;

export const DEFAULT_DB_PATH = "data/ledger.db";

/** Open (creating if needed) the SQLite ledger at `dbPath`. Parent dirs are created. */
export function openLedger(dbPath: string = DEFAULT_DB_PATH): Ledger {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL keeps concurrent dashboard reads from blocking CLI writes.
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_url TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT,
      budget TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      run_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (run_id, name)
    );
    CREATE TABLE IF NOT EXISTS symptom_specs (
      run_id INTEGER PRIMARY KEY,
      spec_json TEXT NOT NULL,
      frozen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  // Migrate pre-issue-2 ledgers whose `runs` table has no verdict/budget columns:
  // both are nullable TEXT, so ALTER TABLE ADD COLUMN is legal without a rebuild.
  const columns = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((col) => col.name),
  );
  for (const column of ["verdict", "budget"]) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
    }
  }
  return db;
}

/** Contract shape served by `GET /api/runs` and `GET /api/runs/:id`. */
export interface RunRecord {
  id: number;
  issue_url: string;
  status: string;
  verdict: string | null;
  created_at: string;
  budget: unknown;
}

/** Contract shape served by `GET /api/runs/:id/events`. */
export interface LedgerEvent {
  id: number;
  run_id: number;
  seq: number;
  kind: string;
  payload_json: string;
  created_at: string;
}

/** Summary embedded in the `GET /api/runs/:id` response. */
export interface RunSummary {
  events: number;
  artifacts: string[];
}

/** Parse a serialized-JSON column; absent or unparseable text reads as null, never throws. */
function safeJsonParse(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

interface RunRow {
  id: number;
  issue_url: string;
  status: string;
  verdict: string | null;
  created_at: string;
  budget: string | null;
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    issue_url: row.issue_url,
    status: row.status,
    verdict: row.verdict ?? null,
    created_at: row.created_at,
    budget: safeJsonParse(row.budget),
  };
}

const RUN_COLUMNS = "id, issue_url, status, verdict, created_at, budget";

/** Insert a run in status `created`; returns the new ledger id (starts at 1). */
export function insertRun(db: Ledger, issueUrl: string): number {
  const info = db.prepare("INSERT INTO runs (issue_url, status) VALUES (?, 'created')").run(issueUrl);
  // lastInsertRowid may be bigint; the contract prints plain decimal ids.
  return Number(info.lastInsertRowid);
}

/** Append an event with the next per-run sequence number; returns the event id. */
export function appendEvent(db: Ledger, runId: number, kind: string, payload: unknown): number {
  const append = db.transaction((): number => {
    const row = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE run_id = ?")
      .get(runId) as { next: number };
    const info = db
      .prepare("INSERT INTO events (run_id, seq, kind, payload_json) VALUES (?, ?, ?, ?)")
      .run(runId, row.next, kind, JSON.stringify(payload ?? null));
    return Number(info.lastInsertRowid);
  });
  return append();
}

/** Store or overwrite a named artifact for a run; last write wins. */
export function putArtifact(db: Ledger, runId: number, name: string, content: string): void {
  db.prepare(
    `INSERT INTO artifacts (run_id, name, content) VALUES (?, ?, ?)
     ON CONFLICT (run_id, name) DO UPDATE SET content = excluded.content`,
  ).run(runId, name, content);
}

/** Store or replace a run's frozen symptom spec; last write wins. */
export function putSymptomSpec(db: Ledger, runId: number, spec: unknown): void {
  db.prepare(
    `INSERT INTO symptom_specs (run_id, spec_json) VALUES (?, ?)
     ON CONFLICT (run_id) DO UPDATE SET spec_json = excluded.spec_json,
       frozen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(runId, JSON.stringify(spec ?? null));
}

/** Fetch one run as its contract record; null for unknown or non-integer ids. */
export function getRun(db: Ledger, runId: number): RunRecord | null {
  if (!Number.isInteger(runId)) return null;
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)
    .get(runId) as RunRow | undefined;
  return row ? toRunRecord(row) : null;
}

/** List all runs as contract records, ordered by id. */
export function listRuns(db: Ledger): RunRecord[] {
  return (db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY id`).all() as RunRow[]).map(toRunRecord);
}

/** List a run's events ordered by sequence; empty for runs without events. */
export function getEvents(db: Ledger, runId: number): LedgerEvent[] {
  return db
    .prepare("SELECT id, run_id, seq, kind, payload_json, created_at FROM events WHERE run_id = ? ORDER BY seq, id")
    .all(runId) as LedgerEvent[];
}

/** Fetch a stored artifact by run id and name; null when absent. */
export function getArtifact(
  db: Ledger,
  runId: number,
  name: string,
): { name: string; content: string; created_at: string } | null {
  const row = db
    .prepare("SELECT name, content, created_at FROM artifacts WHERE run_id = ? AND name = ?")
    .get(runId, name) as { name: string; content: string; created_at: string } | undefined;
  return row ?? null;
}

/** Fetch a run's parsed symptom spec; null when not frozen. */
export function getSymptomSpec(db: Ledger, runId: number): unknown {
  const row = db
    .prepare("SELECT spec_json FROM symptom_specs WHERE run_id = ?")
    .get(runId) as { spec_json: string } | undefined;
  return row ? safeJsonParse(row.spec_json) : null;
}

/** Summarize a run: event count and artifact names ordered by creation. */
export function getRunSummary(db: Ledger, runId: number): RunSummary {
  const events = db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ?")
    .get(runId) as { count: number };
  const artifacts = db
    .prepare("SELECT name FROM artifacts WHERE run_id = ? ORDER BY created_at, rowid")
    .all(runId) as Array<{ name: string }>;
  return { events: events.count, artifacts: artifacts.map((row) => row.name) };
}
