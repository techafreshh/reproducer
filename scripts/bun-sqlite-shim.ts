import { Database as BunDatabase } from "bun:sqlite";

/**
 * Test-only better-sqlite3 API shim over `bun:sqlite`.
 *
 * Bare `bun test` cannot load the native better-sqlite3 binding
 * (`'better-sqlite3' is not yet supported in Bun`), so the Bun preload
 * (`scripts/bun-test-preload.ts`, wired via `bunfig.toml [test] preload`)
 * redirects `better-sqlite3` imports to this module. It covers exactly the
 * surface `src/orchestrator/ledger.ts` and its tests use — constructor
 * (including `:memory:`), `pragma`, multi-statement `exec`, `prepare` with
 * `?` params returning `{ run, get, all }`, `transaction` with
 * BEGIN/COMMIT/ROLLBACK, and `close` — including triggers and
 * `ON CONFLICT` upserts, which the underlying SQLite engine handles.
 * Real vitest runs never see this file; production code is untouched.
 */

type RunResult = { changes: number; lastInsertRowid: number | bigint };

class Statement {
  private readonly inner: ReturnType<BunDatabase["query"]>;

  constructor(db: BunDatabase, sql: string) {
    this.inner = db.query(sql);
  }

  run(...params: Array<string | number | bigint | null | Uint8Array>): RunResult {
    const info = this.inner.run(...(params as []));
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  get(...params: Array<string | number | bigint | null | Uint8Array>): unknown {
    return this.inner.get(...(params as []));
  }

  all(...params: Array<string | number | bigint | null | Uint8Array>): Array<unknown> {
    return this.inner.all(...(params as [])) as Array<unknown>;
  }
}

class Database {
  private readonly inner: BunDatabase;

  constructor(path: string, options?: { readonly?: boolean }) {
    this.inner = new BunDatabase(path, options as never);
  }

  pragma(stmt: string): Array<unknown> {
    return this.inner.query(`PRAGMA ${stmt}`).all() as Array<unknown>;
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  prepare(sql: string): Statement {
    return new Statement(this.inner, sql);
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return this.inner.transaction(fn) as T;
  }

  close(): void {
    this.inner.close();
  }
}

export { Database };
export default Database;
