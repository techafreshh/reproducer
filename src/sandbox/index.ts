/**
 * Sandbox mode switch: local venvs now; docker arrives in a later issue.
 * Anything but `"docker"` resolves to the local default.
 */
import { envCreate as localEnvCreate, envRun as localEnvRun } from "./local.js";
import type { EnvCreateSpec, EnvHandle, EnvRunOptions, EnvRunResult } from "./local.js";

export type SandboxMode = "local" | "docker";

export type { EnvCreateSpec, EnvHandle, EnvRunOptions, EnvRunResult };

/** Active sandbox mode; defaults to local. */
export function getSandboxMode(): SandboxMode {
  return process.env.SANDBOX_MODE === "docker" ? "docker" : "local";
}

/** Throw the docker sentinel; local mode runs the wrapped local implementation. */
function requireLocal(): void {
  if (getSandboxMode() === "docker") {
    throw new Error("docker sandbox not implemented");
  }
}

/** Create a sandboxed venv; dispatches to the local implementation. */
export function envCreate(spec: EnvCreateSpec): EnvHandle {
  requireLocal();
  return localEnvCreate(spec);
}

/** Run a command in a sandboxed venv; dispatches to the local implementation. */
export function envRun(handle: string | EnvHandle, cmd: string, opts: EnvRunOptions = {}): EnvRunResult {
  requireLocal();
  return localEnvRun(handle, cmd, opts);
}
