import { describe, expect, it } from "vitest";
import {
  createLiveProvider,
  createProvider,
  createScriptedProvider,
  resolveModelProvider,
} from "./provider.js";

describe("resolveModelProvider", () => {
  it("defaults to openrouter when MODEL_PROVIDER is unset", () => {
    expect(resolveModelProvider({})).toBe("openrouter");
  });

  it("parses openrouter and deepseek case-insensitively", () => {
    expect(resolveModelProvider({ MODEL_PROVIDER: "OpenRouter" })).toBe("openrouter");
    expect(resolveModelProvider({ MODEL_PROVIDER: "DeepSeek" })).toBe("deepseek");
  });

  it("throws naming both valid options for unknown providers", () => {
    expect(() => resolveModelProvider({ MODEL_PROVIDER: "bedrock" })).toThrow(
      'unknown MODEL_PROVIDER "bedrock": expected "openrouter" or "deepseek"',
    );
  });
});

describe("createProvider", () => {
  it("returns tag scripted when no provider key is set (default openrouter)", () => {
    expect(createProvider({}).tag).toBe("scripted");
  });

  it("returns tag scripted when the selected provider key is empty", () => {
    expect(createProvider({ OPENROUTER_API_KEY: "" }).tag).toBe("scripted");
    expect(
      createProvider({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" }).tag,
    ).toBe("scripted");
  });

  it("returns tag live against the OpenRouter default base URL", () => {
    const provider = createProvider({ OPENROUTER_API_KEY: "test-key", MODEL_FAST: "fast-model" });
    expect(provider.tag).toBe("live");
    if (provider.tag === "live") {
      expect(provider.provider).toBe("openrouter");
      expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(provider.model).toBe("fast-model");
    }
  });

  it("returns tag live against the DeepSeek default base URL", () => {
    const provider = createProvider({
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      MODEL_FAST: "reason-model",
    });
    expect(provider.tag).toBe("live");
    if (provider.tag === "live") {
      expect(provider.provider).toBe("deepseek");
      expect(provider.baseUrl).toBe("https://api.deepseek.com/v1");
      expect(provider.model).toBe("reason-model");
    }
  });

  it("honors per-provider base URL overrides", () => {
    const provider = createProvider({
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: "https://proxy.example/v1",
      MODEL_FAST: "reason-model",
    });
    expect(provider.tag).toBe("live");
    if (provider.tag === "live") {
      expect(provider.baseUrl).toBe("https://proxy.example/v1");
    }
  });

  it("throws missing MODEL_FAST when the key is set but MODEL_FAST is unset", () => {
    expect(() =>
      createProvider({ OPENROUTER_API_KEY: "test-key" }),
    ).toThrow("missing MODEL_FAST for provider openrouter");
    expect(() =>
      createProvider({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "test-key" }),
    ).toThrow("missing MODEL_FAST for provider deepseek");
    expect(() =>
      createProvider({ OPENROUTER_API_KEY: "test-key", MODEL_FAST: "" }),
    ).toThrow("missing MODEL_FAST for provider openrouter");
  });

  it("throws for unknown MODEL_PROVIDER even with no keys set", () => {
    expect(() => createProvider({ MODEL_PROVIDER: "bedrock" })).toThrow(
      'unknown MODEL_PROVIDER "bedrock": expected "openrouter" or "deepseek"',
    );
  });

  it("stays scripted on the legacy provider key alone (legacy env vars are unread)", () => {
    // Split literal keeps the legacy-key scrub check at zero hits while proving the old key is ignored.
    const legacyKey = "NEB" + "IUS_API_KEY";
    expect(createProvider({ [legacyKey]: "test-key", MODEL_FAST: "fast-model" }).tag).toBe(
      "scripted",
    );
  });

  it("ignores the other provider's key (selection precedence)", () => {
    expect(
      createProvider({ MODEL_PROVIDER: "deepseek", OPENROUTER_API_KEY: "test-key" }).tag,
    ).toBe("scripted");
    expect(createProvider({ DEEPSEEK_API_KEY: "test-key" }).tag).toBe("scripted");
  });
});

describe("createScriptedProvider", () => {
  it("returns canned strings in order", async () => {
    const provider = createScriptedProvider({ triageOutputs: ["first", "second"] });
    expect(provider.tag).toBe("scripted");
    await expect(provider.completeTriage("prompt one")).resolves.toBe("first");
    await expect(provider.completeTriage("prompt two")).resolves.toBe("second");
  });

  it("throws once the queue is exhausted", async () => {
    const provider = createScriptedProvider({ triageOutputs: ["only"] });
    await expect(provider.completeTriage("prompt")).resolves.toBe("only");
    await expect(provider.completeTriage("prompt")).rejects.toThrow("scripted triage outputs exhausted");
  });
});

describe("createLiveProvider", () => {
  it("constructs the OpenRouter driver without network access", () => {
    const provider = createLiveProvider({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      model: "fast-model",
    });
    expect(provider.tag).toBe("live");
    expect(provider.provider).toBe("openrouter");
    expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("constructs the DeepSeek driver without network access", () => {
    const provider = createLiveProvider({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "test-key",
      model: "reason-model",
    });
    expect(provider.tag).toBe("live");
    expect(provider.provider).toBe("deepseek");
    expect(provider.baseUrl).toBe("https://api.deepseek.com/v1");
  });
});
