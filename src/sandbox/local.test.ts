import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envCreate, envRun } from "./local.js";

describe("local sandbox", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_VENVS_DIR", mkdtempSync(join(tmpdir(), "reproducer-sandbox-")));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("installs a pinned package and runs its interpreter", () => {
    const env = envCreate({ installs: ["six==1.16.0"] });
    const result = envRun(env.handle, `python -c "import six; print(six.__version__)"`);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("1.16.0");
  }, 180000);

  it("hard-times-out a sleeping command", () => {
    const env = envCreate({});
    const result = envRun(env.handle, `python -c "import time; time.sleep(30)"`, { timeoutMs: 2000 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10000);
  }, 60000);

  it("hides parent secrets from the child env", () => {
    const saved = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      TINYFISH_API_KEY: process.env.TINYFISH_API_KEY,
      TAVILIS_API_KEY: process.env.TAVILIS_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.OPENROUTER_API_KEY = "secret";
    process.env.DEEPSEEK_API_KEY = "secret";
    process.env.TINYFISH_API_KEY = "secret";
    process.env.TAVILIS_API_KEY = "secret";
    process.env.GITHUB_TOKEN = "secret";
    try {
      const env = envCreate({});
      const leaked = envRun(
        env.handle,
        `python -c "import os; print(any(k in os.environ for k in ['OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'TINYFISH_API_KEY', 'TAVILIS_API_KEY', 'GITHUB_TOKEN']))"`,
      );
      expect(leaked.exitCode).toBe(0);
      expect(leaked.stdout.trim()).toBe("False");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60000);

  it("throws `pip install failed` for an unknown package", () => {
    expect(() => envCreate({ installs: ["definitely-not-a-real-pkg-xyz"] })).toThrow("pip install failed");
  }, 180000);

  it("captures stderr and non-zero exit codes", () => {
    const env = envCreate({});
    const result = envRun(env.handle, `python -c "import sys; print('oops', file=sys.stderr); sys.exit(3)"`);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.stderr.trim()).toBe("oops");
  }, 60000);
});
