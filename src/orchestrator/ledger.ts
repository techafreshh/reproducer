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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  return db;
}

/** Insert a run in status `created`; returns the new ledger id (starts at 1). */
export function createRun(db: Ledger, issueUrl: string): number {
  const info = db.prepare("INSERT INTO runs (issue_url, status) VALUES (?, 'created')").run(issueUrl);
  // lastInsertRowid may be bigint; the contract prints plain decimal ids.
  return Number(info.lastInsertRowid);
}
