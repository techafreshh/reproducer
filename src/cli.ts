import { pathToFileURL } from "node:url";
import { parseIssueUrl } from "./issue-url.js";
import { insertRun, openLedger } from "./orchestrator/ledger.js";

export interface CliOptions {
  dbPath?: string;
}

const USAGE = "usage: reproducer run <issue-url> [--db <path>]";

/**
 * Entry point for the `reproducer` CLI. Returns the process exit code.
 *
 * Error channel: the acceptance contract requires `invalid issue url` on
 * stdout, so usage errors are printed there — not stderr.
 */
export function main(argv: string[], options: CliOptions = {}): number {
  let dbPath = options.dbPath;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
    if (arg === "--db") {
      const value = argv[++i];
      if (value === undefined) {
        console.log(USAGE);
        return 2;
      }
      dbPath = value;
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    } else {
      positionals.push(arg);
    }
  }

  const [subcommand, issueUrl] = positionals;
  if (subcommand !== "run" || !issueUrl) {
    console.log(USAGE);
    return 2;
  }

  try {
    const issue = parseIssueUrl(issueUrl);
    const db = openLedger(dbPath);
    try {
      const id = insertRun(db, issue.url);
      console.log(`run ${id} created`);
    } finally {
      db.close();
    }
    return 0;
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    console.log(USAGE);
    return 2;
  }
}

/** Run main() only when this module is the process entry, so tests can import it. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
