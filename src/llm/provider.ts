/**
 * LLM provider factory: `scripted` (default, no keys) vs `live` (Nebius Token Factory).
 *
 * The provider is a swappable transport — one structured triage call — while
 * `src/agent/triage.ts` owns the sanitize/validate/freeze contract. No
 * sanitizer or ledger imports here.
 */
import { createProvider as createPiProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import OpenAI from "openai";
import { SymptomSpecSchema } from "../gate/spec.js";

/** Swappable triage transport: one prompt in, one raw spec-JSON string out. */
export interface TriageProvider {
  readonly tag: "scripted" | "live";
  completeTriage(prompt: string): Promise<string>;
}

export interface ScriptedProviderOptions {
  triageOutputs: string[];
}

/** Scripted driver: shifts one canned string per triage call (CI, zero keys). */
export function createScriptedProvider(options: ScriptedProviderOptions): TriageProvider {
  const queue = [...options.triageOutputs];
  return {
    tag: "scripted",
    async completeTriage(_prompt: string): Promise<string> {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("scripted triage outputs exhausted");
      }
      return next;
    },
  };
}

export interface LiveProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Live driver: one structured `response_format: json_schema` call via the `openai` SDK. */
export function createLiveProvider(options: LiveProviderOptions): TriageProvider {
  // pi-ai session config for parity — the structured call below goes through
  // the `openai` SDK directly.
  createPiProvider({
    id: "nebius-token-factory",
    baseUrl: options.baseUrl,
    auth: { apiKey: envApiKeyAuth("Nebius", ["NEBIUS_API_KEY"]) },
    api: openAICompletionsApi(),
    models: [],
  });
  const client = new OpenAI({ baseURL: options.baseUrl, apiKey: options.apiKey });
  return {
    tag: "live",
    async completeTriage(prompt: string): Promise<string> {
      const response = await client.chat.completions.create({
        model: options.model,
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "symptom_spec",
            schema: SymptomSpecSchema as unknown as Record<string, unknown>,
          },
        },
      });
      const message = response.choices[0]?.message;
      if (typeof message?.content === "string") {
        return message.content;
      }
      throw new Error(
        message?.refusal ? `live triage refused: ${message.refusal}` : "live triage returned no content",
      );
    },
  };
}

/**
 * Choose the triage driver from the environment: scripted when
 * `NEBIUS_API_KEY` is unset/empty, live otherwise. Reads
 * `NEBIUS_BASE_URL`/`MODEL_FAST` for the live path.
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): TriageProvider {
  const apiKey = env.NEBIUS_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return createScriptedProvider({ triageOutputs: [] });
  }
  return createLiveProvider({
    baseUrl: env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1",
    apiKey,
    model: env.MODEL_FAST ?? "",
  });
}
