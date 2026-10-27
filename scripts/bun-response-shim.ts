/**
 * Test-only `Response` spec-alignment patch for bare `bun test`.
 *
 * The fetch spec requires `new Response("string")` to default to
 * `content-type: text/plain;charset=UTF-8` when no content type is given.
 * Node (undici) does this; Bun 1.4.4 does not — it leaves the headers
 * empty. Hono's `c.text()` fast path relies on that constructor default,
 * so under `bun test` text responses lose their content type while `c.json()`
 * responses (which set it explicitly) keep theirs. Production serves on
 * Node, where the app is already correct, so this patch — applied only when
 * the runtime is non-conformant — makes the Bun test environment behave
 * exactly like production. Applied by `scripts/bun-test-preload.ts`
 * (wired via `bunfig.toml [test] preload`).
 */

function needsPatch(): boolean {
  try {
    return new Response("x").headers.get("content-type") === null;
  } catch {
    return false;
  }
}

/** Replace the global `Response` with a spec-conformant subclass. Idempotent. */
export function patchResponseForBunTest(): void {
  if (!needsPatch()) return;
  const OriginalResponse = globalThis.Response;
  class SpecResponse extends OriginalResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      if (typeof body === "string" && !this.headers.has("content-type")) {
        this.headers.set("content-type", "text/plain;charset=UTF-8");
      }
    }
  }
  globalThis.Response = SpecResponse as typeof Response;
}
