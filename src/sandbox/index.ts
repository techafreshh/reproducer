/**
 * Sandbox mode switch: local venvs by default, locked-down `docker run`
 * containers when `SANDBOX_MODE=docker`.
 * Anything but `"docker"` resolves to the local default.
 */
import { envCreate as dockerEnvCreate, envRun as dockerEnvRun } from "./docker.js";
import { envCreate as localEnvCreate, envRun as localEnvRun } from "./local.js";
import type { EnvCreateSpec, EnvHandle, EnvRunOptions, EnvRunResult } from "./local.js";

export type SandboxMode = "local" | "docker";

export type { EnvCreateSpec, EnvHandle, EnvRunOptions, EnvRunResult };

/** Active sandbox mode; defaults to local. */
export function getSandboxMode(): SandboxMode {
  return process.env.SANDBOX_MODE === "docker" ? "docker" : "local";
}

/** Create a sandboxed env; dispatches to the docker implementation in docker mode. */
export function envCreate(spec: EnvCreateSpec): EnvHandle {
  if (getSandboxMode() === "docker") return dockerEnvCreate(spec);
  return localEnvCreate(spec);
}

/** Run a command in a sandboxed env; dispatches to the docker implementation in docker mode. */
export function envRun(handle: string | EnvHandle, cmd: string, opts: EnvRunOptions = {}): EnvRunResult {
  if (getSandboxMode() === "docker") return dockerEnvRun(handle, cmd, opts);
  return localEnvRun(handle, cmd, opts);
}
