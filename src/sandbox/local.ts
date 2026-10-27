/**
 * Local-mode sandbox: isolated Python venvs under `data/venvs/<handle>` with
 * pinned pip installs (`envCreate`), and command execution inside them with a
 * hard timeout, resource limits, output capture, and a secret-free
 * environment (`envRun`).
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** Default venv root, relative to the repo working directory. */
export const DEFAULT_VENVS_DIR = "data/venvs";

/** Venv root; `SANDBOX_VENVS_DIR` overrides the default (tests use a temp dir). */
export function venvsDir(): string {
  return process.env.SANDBOX_VENVS_DIR ?? DEFAULT_VENVS_DIR;
}

/** Handle to a created venv: its id plus the interpreter paths inside it. */
export interface EnvHandle {
  handle: string;
  pythonBin: string;
  pipBin: string;
  venvDir: string;
}

export interface EnvCreateSpec {
  /** Advisory only: every venv is built with `python3` from `PATH`. */
  pythonVersion?: string;
  /** Pinned packages for `<venv>/bin/pip install`; empty (or omitted) skips pip. */
  installs?: string[];
}

export interface EnvRunOptions {
  /** Hard timeout in ms; non-positive/non-finite values fall back to the default. */
  timeoutMs?: number;
}

/** Captured outcome of one sandboxed command. */
export interface EnvRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/** Default hard timeout for `envRun` when the caller passes none (or garbage). */
export const DEFAULT_TIMEOUT_MS = 60000;

/** Generous ceiling for `pip install` so a slow index cannot hang the caller forever. */
const PIP_INSTALL_TIMEOUT_MS = 300000;

/** Filesize rlimit for sandboxed commands, in 512-byte blocks (1 GiB). */
const FSIZE_LIMIT_BLOCKS = 2097152;

// Parent secrets that must never reach the child: the issue's literal
// `TAVILIS_API_KEY` plus the real `TAVILY_API_KEY` from `.env.example`.
const SECRET_KEYS = ["NEBIUS_API_KEY", "TAVILIS_API_KEY", "TAVILY_API_KEY", "GITHUB_TOKEN"];

/** Copy of `process.env` minus the secret keys; proxy/PyPI vars pass through for pip. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SECRET_KEYS) delete env[key];
  return env;
}

/** Clamp a caller timeout to a finite positive integer, defaulting when unusable. */
function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(value);
}

/** Whitespace-trimmed tail of subprocess output for error messages. */
function tail(output: unknown, max = 2000): string {
  const text = typeof output === "string" ? output : String(output ?? "");
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}

/** Spawn output as a string; non-string output (should not happen with `encoding`) reads as "". */
function asString(output: unknown): string {
  return typeof output === "string" ? output : "";
}

/**
 * Create a fresh `python3 -m venv` under `data/venvs/<handle>` and
 * pip-install the pinned packages. Throws `venv creation failed: ...` when
 * the venv build fails, `pip install failed: ...` (with the stderr tail) when
 * installs fail. Handles resolve from the venv root on each call, so they
 * survive process restarts with no in-memory registry.
 */
export function envCreate(spec: EnvCreateSpec): EnvHandle {
  // pythonVersion is advisory only: the host `python3` builds every venv.
  void spec.pythonVersion;
  const installs = spec.installs ?? [];
  const handle = `env-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const venvDir = join(venvsDir(), handle);
  mkdirSync(dirname(venvDir), { recursive: true });
  const venv = spawnSync("python3", ["-m", "venv", venvDir], { encoding: "utf-8" });
  if (venv.error !== undefined || venv.status !== 0) {
    throw new Error(`venv creation failed: ${tail(venv.error ?? venv.stderr) || "unknown error"}`);
  }
  const pythonBin = join(venvDir, "bin", "python");
  const pipBin = join(venvDir, "bin", "pip");
  if (installs.length > 0) {
    const pip = spawnSync(pipBin, ["install", ...installs], {
      encoding: "utf-8",
      env: scrubbedEnv(),
      timeout: PIP_INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (pip.error !== undefined || pip.status !== 0) {
      const timedOut = (pip.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT";
      const reason = timedOut ? "timed out" : tail(pip.stderr) || tail(pip.stdout);
      throw new Error(`pip install failed: ${reason || "unknown error"}`);
    }
  }
  return { handle, pythonBin, pipBin, venvDir };
}

/**
 * Run a shell command inside the venv with a hard timeout (SIGKILL), CPU and
 * filesize rlimits, captured stdout/stderr/exit code, and an env scrubbed of
 * API keys. The venv `bin/` dir is prepended to `PATH`, so bare `python`
 * resolves to the venv interpreter. Rlimit failures never fail the run.
 */
export function envRun(handle: string | EnvHandle, cmd: string, opts: EnvRunOptions = {}): EnvRunResult {
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs);
  const venvDir = typeof handle === "string" ? join(venvsDir(), handle) : handle.venvDir;
  const env = scrubbedEnv();
  env.PATH = `${join(venvDir, "bin")}${delimiter}${env.PATH ?? "/usr/bin:/bin"}`;
  const cpuSec = Math.ceil(timeoutMs / 1000) + 5;
  const script = `ulimit -t ${cpuSec} 2>/dev/null || true; ulimit -f ${FSIZE_LIMIT_BLOCKS} 2>/dev/null || true; ${cmd}`;
  const start = Date.now();
  const result = spawnSync("sh", ["-c", script], {
    encoding: "utf-8",
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const durationMs = Date.now() - start;
  const code = (result.error as { code?: unknown } | undefined)?.code;
  return {
    stdout: asString(result.stdout),
    stderr: asString(result.stderr),
    exitCode: typeof result.status === "number" ? result.status : -1,
    timedOut: code === "ETIMEDOUT" || result.signal === "SIGKILL",
    durationMs,
  };
}
