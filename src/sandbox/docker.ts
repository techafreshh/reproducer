/**
 * Docker-mode sandbox: every `envRun` spawns a locked-down container via
 * `docker run --rm --network none --memory 512m --cpus 1 --pids-limit 128`,
 * so untrusted commands run with no network and bounded resources. Only the
 * `envCreate` install step uses a networked run (to reach the package
 * index); installs do not persist across `envRun` calls — the networked run
 * only validates the pins and throws `pip install failed: ...` on error.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DEFAULT_TIMEOUT_MS } from "./local.js";
import type { EnvCreateSpec, EnvHandle, EnvRunOptions, EnvRunResult } from "./local.js";

export type { EnvCreateSpec, EnvHandle, EnvRunOptions, EnvRunResult };

/** Container image for docker-mode runs (any CPython 3 works). */
export const DOCKER_IMAGE = "python:3.12-slim";

/** Ceiling for the networked `pip install` validation run. */
const PIP_INSTALL_TIMEOUT_MS = 300000;

// Parent secrets that must never reach the child: mirrors local.ts.
const SECRET_KEYS = ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TINYFISH_API_KEY", "TAVILIS_API_KEY", "GITHUB_TOKEN"];

/** Copy of `process.env` minus the secret keys. */
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

/** Single-quote a shell word for the `sh -c` payload in the command string. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Full `docker run` command for an `envRun` payload, as a string. The
 * resource flags and `--network none` are part of the contract: untrusted
 * commands run with no network and bounded memory/CPU/PIDs.
 */
export function buildEnvRunCommand(cmd: string): string {
  return `docker run --rm --network none --memory 512m --cpus 1 --pids-limit 128 ${DOCKER_IMAGE} sh -c ${shellQuote(cmd)}`;
}

/** Locked-down `docker run` argv for an `envRun` payload. */
function envRunArgs(cmd: string): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    DOCKER_IMAGE,
    "sh",
    "-c",
    cmd,
  ];
}

/**
 * Mint an `env-<12hex>` handle and, when `installs` is non-empty, validate
 * the pins with one networked `docker run --rm <image> pip install ...`.
 * Throws `pip install failed: ...` (with the stderr tail) when installs fail.
 */
export function envCreate(spec: EnvCreateSpec): EnvHandle {
  // pythonVersion is advisory only: the container image fixes the interpreter.
  void spec.pythonVersion;
  const installs = spec.installs ?? [];
  const handle = `env-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  if (installs.length > 0) {
    const pip = spawnSync("docker", ["run", "--rm", DOCKER_IMAGE, "pip", "install", ...installs], {
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
  return { handle, pythonBin: "python", pipBin: "pip", venvDir: handle };
}

/**
 * Run a shell command in a locked-down container (`--network none`, bounded
 * memory/CPU/PIDs) with a hard timeout (SIGKILL) and captured
 * stdout/stderr/exit code. Handles are stateless: installs from `envCreate`
 * do not persist into the run container.
 */
export function envRun(handle: string | EnvHandle, cmd: string, opts: EnvRunOptions = {}): EnvRunResult {
  // Stateless mode: the handle only identifies the sandbox, not a filesystem.
  void handle;
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs);
  const start = Date.now();
  const result = spawnSync("docker", envRunArgs(cmd), {
    encoding: "utf-8",
    env: scrubbedEnv(),
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
