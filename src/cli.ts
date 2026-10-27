import { pathToFileURL } from "node:url";
import { parseIssueUrl } from "./issue-url.js";
import { DEMO_FIXTURE_DIR, runScriptedDemo } from "./orchestrator/demo-run.js";
import { appendEvent, getArtifact, insertRun, openLedger } from "./orchestrator/ledger.js";
import { isRepoAllowlisted, loadPostConfig } from "./post/config.js";
import { postGithubComment } from "./post/github-comment.js";
import { DEFAULT_REPLAY_DIR, resolveFixtureDir } from "./replay/fixtures.js";
import { runReplay } from "./replay/run.js";

export interface CliOptions {
  dbPath?: string;
}

const USAGE = "usage: reproducer run <issue-url> [--db <path>] [--post] [--config <path>]";

/**
 * Entry point for the `reproducer` CLI. Returns the process exit code — or a
 * promise of it on the replay path, whose triage/session stages are async.
 *
 * Error channel: the acceptance contract requires `invalid issue url` on
 * stdout, so usage errors are printed there — not stderr.
 */
export function main(argv: string[], options: CliOptions = {}): number | Promise<number> {
  let dbPath = options.dbPath;
  let scriptedDir: string | undefined;
  let replayFlagDir: string | undefined;
  let postEnabled = false;
  let configPath: string | undefined;
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
    } else if (arg === "--replay") {
      // Bare `--replay` means the default bundle; a following non-flag
      // token is the fixture dir (`--replay <dir>`), mirroring `--scripted`.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        replayFlagDir = next;
        i++;
      } else {
        replayFlagDir = DEFAULT_REPLAY_DIR;
      }
    } else if (arg.startsWith("--replay=")) {
      const value = arg.slice("--replay=".length);
      replayFlagDir = value === "" ? DEFAULT_REPLAY_DIR : value;
    } else if (arg === "--post") {
      postEnabled = true;
    } else if (arg === "--config") {
      const value = argv[++i];
      if (value === undefined) {
        console.log(USAGE);
        return 2;
      }
      configPath = value;
    } else if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      configPath = value === "" ? undefined : value;
    } else {
      positionals.push(arg);
    }
  }

  const [subcommand, issueUrl] = positionals;
  if (subcommand !== "run" || !issueUrl) {
    console.log(USAGE);
    return 2;
  }

  // Posting stays off unless `--post` is passed, and then only for repos in
  // the configured allowlist. Without `--post`, `--config` is accepted and
  // ignored (artifacts only, exit 0, no comment fetch, no `post_comment`).
  // With `--post` and a non-allowlisted target, exit 3 before any run or
  // network post. Error channel stays stdout, like `invalid issue url`.
  let allowlist: string[] = [];
  let dashboardBase = "http://localhost:8080";
  if (postEnabled) {
    try {
      const ref = parseIssueUrl(issueUrl);
      const cfg = loadPostConfig(configPath);
      allowlist = cfg.allowlist;
      dashboardBase = cfg.dashboardBase;
      if (!isRepoAllowlisted(ref.owner, ref.repo, allowlist)) {
        console.log("repo not in post allowlist");
        return 3;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "repo not in post allowlist") {
        console.log(message);
        return 3;
      }
      console.log(message);
      console.log(USAGE);
      return 2;
    }
  }

  // Scripted validation path: the whole engine on one canned fixture.
  // Any gate verdict (even non-`reproduced`) still exits 0; only bad URLs
  // and unreadable fixtures exit 2 with usage on stdout.
  if (scriptedDir !== undefined) {
    if (postEnabled) {
      const postOptions = { postEnabled: true as const, allowlist, dashboardBase };
      try {
        return runScriptedDemo(issueUrl, scriptedDir, dbPath, postOptions).then(
          ({ verdict }) => {
            console.log(`verdict: ${verdict}`);
            return 0;
          },
          (error: unknown) => {
            console.log(error instanceof Error ? error.message : String(error));
            console.log(USAGE);
            return 2;
          },
        );
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        console.log(USAGE);
        return 2;
      }
    }
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

  // Replay path: the whole engine on a fixture bundle, keyless and offline.
  // Any terminal gate status (even non-`reproduced`) still exits 0; only
  // bad URLs and unreadable fixtures exit 2 with usage on stdout.
  const replayDir = resolveFixtureDir(replayFlagDir, process.env);
  if (replayDir !== undefined) {
    const postOptions = postEnabled ? { postEnabled: true as const, allowlist, dashboardBase } : undefined;
    return runReplay(issueUrl, replayDir, dbPath, postOptions).then(
      ({ status }) => {
        console.log(`verdict: ${status}`);
        return 0;
      },
      (error: unknown) => {
        console.log(error instanceof Error ? error.message : String(error));
        console.log(USAGE);
        return 2;
      },
    );
  }

  try {
    const issue = parseIssueUrl(issueUrl);
    const db = openLedger(dbPath);
    if (postEnabled) {
      const id = insertRun(db, issue.url);
      const base = dashboardBase.replace(/\/+$/, "");
      const stored = getArtifact(db, id, "findings.md")?.content;
      const body =
        stored !== undefined
          ? `${stored}\n\nTrace: ${base}/runs/${id}`
          : `Repro run ${id} for ${issue.url}\n\nTrace: ${base}/runs/${id}`;
      return postGithubComment(issue.owner, issue.repo, issue.number, body, {}).then(
        () => {
          try {
            appendEvent(db, id, "post_comment", { kind: "github_comment", body });
          } finally {
            db.close();
          }
          console.log(`run ${id} created`);
          return 0;
        },
        (error: unknown) => {
          db.close();
          console.log(error instanceof Error ? error.message : String(error));
          console.log(USAGE);
          return 2;
        },
      );
    }
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
  const code = main(process.argv.slice(2));
  if (code instanceof Promise) {
    code.then(
      (exitCode) => process.exit(exitCode),
      (error: unknown) => {
        console.log(error instanceof Error ? error.message : String(error));
        process.exit(2);
      },
    );
  } else {
    process.exit(code);
  }
}
