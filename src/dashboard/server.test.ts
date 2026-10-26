import { describe, expect, it } from "vitest";
import { app, getPort } from "./server.ts";

describe("dashboard app", () => {
  it("serves GET /healthz with 200 and the exact body {\"ok\":true}", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("returns 404 for unknown routes (PRD status-code contract)", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});

describe("getPort", () => {
  it("defaults to 8080 and honors a valid PORT", () => {
    expect(getPort({})).toBe(8080);
    expect(getPort({ PORT: "3210" })).toBe(3210);
  });

  it("falls back to 8080 on missing, invalid, or non-positive PORT", () => {
    expect(getPort({ PORT: "" })).toBe(8080);
    expect(getPort({ PORT: "abc" })).toBe(8080);
    expect(getPort({ PORT: "0" })).toBe(8080);
    expect(getPort({ PORT: "-1" })).toBe(8080);
    expect(getPort({ PORT: "8080.5" })).toBe(8080);
  });
});
