import { plugin } from "bun";
import * as vitest from "vitest";
import { patchResponseForBunTest } from "./bun-response-shim.js";
import { patchVitestForBunTest } from "./bun-vitest-shim.js";

/**
 * Bun-only test preload (wired via `bunfig.toml [test] preload`).
 *
 * Bare `bun test` cannot run two things the suites rely on:
 *
 * - the native better-sqlite3 binding (`'better-sqlite3' is not yet
 *   supported in Bun`), so the `build.module` redirect below swaps
 *   `better-sqlite3` imports for the test-only `bun:sqlite` shim in
 *   `scripts/bun-sqlite-shim.ts`;
 * - vitest's runner-bound helpers (`vi.stubEnv`/`vi.unstubAllEnvs`,
 *   `vi.stubGlobal`/`vi.unstubAllGlobals`, `it.runIf`/`describe.runIf`),
 *   which are undefined outside the vitest runner. Bun's test runner
 *   bypasses plugin redirects for the `vitest` specifier, so instead we
 *   patch the missing members onto the shared module objects in place.
 * - the fetch spec default (`new Response("string")` carries
 *   `content-type: text/plain;charset=UTF-8`), which Bun omits and hono's
 *   `c.text()` relies on; patched only when the runtime is non-conformant.
 *
 * Production code and real vitest runs are unaffected (vitest never reads
 * Bun preloads).
 */

patchVitestForBunTest(vitest as Parameters<typeof patchVitestForBunTest>[0]);
patchResponseForBunTest();

const sqliteShim = JSON.stringify(new URL("./bun-sqlite-shim.ts", import.meta.url).pathname);

plugin({
  name: "bun-test-shims",
  setup(build) {
    build.module("better-sqlite3", () => ({
      loader: "tsx",
      contents: `export * from ${sqliteShim};\nexport { default } from ${sqliteShim};\n`,
    }));
  },
});
