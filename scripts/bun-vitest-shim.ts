/**
 * Test-only vitest compatibility patch for bare `bun test`.
 *
 * Under `bun test`, `import ... from "vitest"` resolves to the real vitest
 * package, but its runner is absent: `vi.stubEnv`, `vi.unstubAllEnvs`,
 * `vi.stubGlobal`, `vi.unstubAllGlobals`, and `it.runIf`/`describe.runIf`
 * are all undefined (the suites use every one of these). Bun's test runner
 * bypasses `Bun.plugin` module redirects for the `vitest` specifier, so
 * instead of swapping the module we patch the missing members onto the
 * shared module objects in place — `expect`, `describe`/`it`, `vi.fn`,
 * and `vi.spyOn` stay the real vitest implementations, which already work
 * under Bun. Applied by `scripts/bun-test-preload.ts` (wired via
 * `bunfig.toml [test] preload`); real vitest runs never see this file.
 */

type TestBlock = (...args: never[]) => unknown;

const savedEnv = new Map<string, string | undefined>();
const savedGlobals = new Map<string, unknown>();

export function stubEnv(name: string, value: string): string {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
  return value;
}

export function unstubAllEnvs(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

export function stubGlobal(name: string, value: unknown): unknown {
  if (!savedGlobals.has(name)) savedGlobals.set(name, (globalThis as Record<string, unknown>)[name]);
  (globalThis as Record<string, unknown>)[name] = value;
  return value;
}

export function unstubAllGlobals(): void {
  for (const [name, value] of savedGlobals) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = value;
  }
  savedGlobals.clear();
}

export function runIf<TBlock extends TestBlock>(base: TBlock, condition: boolean): TBlock {
  return condition ? base : ((base as unknown as { skip: TBlock }).skip as TBlock);
}

interface VitestModuleShape {
  describe: TestBlock & { runIf?: (condition: boolean) => unknown };
  it: TestBlock & { runIf?: (condition: boolean) => unknown };
  vi: {
    stubEnv?: typeof stubEnv;
    unstubAllEnvs?: typeof unstubAllEnvs;
    stubGlobal?: typeof stubGlobal;
    unstubAllGlobals?: typeof unstubAllGlobals;
    [key: string]: unknown;
  };
}

/** Install the missing runner-bound members onto the real vitest module. Idempotent. */
export function patchVitestForBunTest(vitest: VitestModuleShape): void {
  if (typeof vitest.vi.stubEnv !== "function") vitest.vi.stubEnv = stubEnv;
  if (typeof vitest.vi.unstubAllEnvs !== "function") vitest.vi.unstubAllEnvs = unstubAllEnvs;
  if (typeof vitest.vi.stubGlobal !== "function") vitest.vi.stubGlobal = stubGlobal;
  if (typeof vitest.vi.unstubAllGlobals !== "function") vitest.vi.unstubAllGlobals = unstubAllGlobals;
  if (typeof vitest.it.runIf !== "function") {
    vitest.it.runIf = (condition: boolean) => runIf(vitest.it as TestBlock, condition);
  }
  if (typeof vitest.describe.runIf !== "function") {
    vitest.describe.runIf = (condition: boolean) => runIf(vitest.describe as TestBlock, condition);
  }
}
