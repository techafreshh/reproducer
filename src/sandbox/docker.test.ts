import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvRunCommand, envCreate } from "./docker.js";
import { envCreate as dispatchEnvCreate, envRun as dispatchEnvRun } from "./index.js";

describe("docker sandbox", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_MODE", "docker");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a locked-down envRun command", () => {
    const cmd = buildEnvRunCommand(`python -c "print(1)"`);
    expect(cmd).toContain("--network none");
    expect(cmd).toContain("--memory 512m");
    expect(cmd).toContain("--cpus 1");
    expect(cmd).toContain("--pids-limit 128");
  });

  it("mints an env handle without installs (no Docker host needed)", () => {
    const env = dispatchEnvCreate({});
    expect(env.handle).toMatch(/^env-[0-9a-f]{12}$/);
  });

  // Live container probe; needs a Docker host, so CI without one stays green.
  it.runIf(process.env.DOCKER_LIVE === "1")("runs python in a container", () => {
    const env = envCreate({});
    const result = dispatchEnvRun(env.handle, `python -c "print(1)"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1");
  }, 120000);
});
