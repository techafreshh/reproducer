import { pathToFileURL } from "node:url";
import { parseIssueUrl } from "./issue-url.js";
import { DEMO_FIXTURE_DIR, runScriptedDemo } from "./orchestrator/demo-run.js";
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
  let scriptedDir: string | undefined;
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
    } else if (arg === "--scripted") {
      // Bare `--scripted` means the default fixture dir; a following
      // non-flag token is the fixture dir (`--scripted <dir>`).
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        scriptedDir = next;
        i++;
      } else {
        scriptedDir = DEMO_FIXTURE_DIR;
      }
    } else if (arg.startsWith("--scripted=")) {
      const value = arg.slice("--scripted=".length);
      scriptedDir = value === "" ? DEMO_FIXTURE_DIR : value;
    } else {
      positionals.push(arg);
    }
  }

  const [subcommand, issueUrl] = positionals;
  if (subcommand !== "run" || !issueUrl) {
    console.log(USAGE);
    return 2;
  }

  // Scripted validation path: the whole engine on one canned fixture.
  // Any gate verdict (even non-`reproduced`) still exits 0; only bad URLs
  // and unreadable fixtures exit 2 with usage on stdout.
  if (scriptedDir !== undefined) {
    try {
      const { verdict } = runScriptedDemo(issueUrl, scriptedDir, dbPath);
      console.log(`verdict: ${verdict}`);
      return 0;
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      console.log(USAGE);
      return 2;
    }
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
