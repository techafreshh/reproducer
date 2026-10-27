import { describe, expect, it } from "vitest";
import { createLiveProvider, createProvider, createScriptedProvider } from "./provider.js";

describe("createProvider", () => {
  it("returns tag scripted when NEBIUS_API_KEY is unset", () => {
    expect(createProvider({}).tag).toBe("scripted");
  });

  it("returns tag scripted when NEBIUS_API_KEY is empty", () => {
    expect(createProvider({ NEBIUS_API_KEY: "" }).tag).toBe("scripted");
  });

  it("returns tag live when NEBIUS_API_KEY is set without calling completeTriage", () => {
    const provider = createProvider({ NEBIUS_API_KEY: "test-key", MODEL_FAST: "fast-model" });
    expect(provider.tag).toBe("live");
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
  it("constructs the live driver without network access", () => {
    const provider = createLiveProvider({
      baseUrl: "https://api.tokenfactory.nebius.com/v1",
      apiKey: "test-key",
      model: "fast-model",
    });
    expect(provider.tag).toBe("live");
  });
});
