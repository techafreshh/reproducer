/**
 * LLM provider factory: `scripted` (default, no keys) vs `live` (OpenRouter
 * or the DeepSeek API direct).
 *
 * The provider is a swappable transport — one structured triage call — while
 * `src/agent/triage.ts` owns the sanitize/validate/freeze contract. No
 * sanitizer or ledger imports here. Both providers are OpenAI-compatible, so
 * the `openai` SDK client stays; only baseURL + apiKey + model change per
 * selection. `MODEL_PROVIDER` (`openrouter` default, `deepseek` alt) selects
 * the provider; `MODEL_FAST` / `MODEL_REASON` carry the model ids with no
 * defaults. Never trust unvalidated model JSON — `validateSymptomSpec` in
 * `src/gate/spec.ts` remains the downstream safety net.
 */
import OpenAI from "openai";
import { SymptomSpecSchema } from "../gate/spec.js";

/** Swappable triage transport: one prompt in, one raw spec-JSON string out. */
export interface TriageProvider {
  readonly tag: "scripted" | "live";
  completeTriage(prompt: string): Promise<string>;
}

/** Live triage transport plus the non-secret config it was built from. */
export interface LiveTriageProvider extends TriageProvider {
  readonly tag: "live";
  readonly provider: ModelProvider;
  readonly baseUrl: string;
  readonly model: string;
}

/** Selectable model provider: `openrouter` (default) or `deepseek` direct. */
export type ModelProvider = "openrouter" | "deepseek";

/** Default OpenRouter base URL when `OPENROUTER_BASE_URL` is unset. */
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Default DeepSeek base URL when `DEEPSEEK_BASE_URL` is unset. */
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/**
 * Parse `MODEL_PROVIDER` (case-insensitive, default `openrouter`).
 * Throws `unknown MODEL_PROVIDER "...": expected "openrouter" or "deepseek"`.
 */
export function resolveModelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const raw = env.MODEL_PROVIDER;
  const normalized = (raw ?? "openrouter").toLowerCase();
  if (normalized === "openrouter" || normalized === "deepseek") {
    return normalized;
  }
  throw new Error(`unknown MODEL_PROVIDER "${raw}": expected "openrouter" or "deepseek"`);
}

/** Non-secret per-provider config: which provider, its key, and its base URL. */
export interface ProviderConfig {
  provider: ModelProvider;
  apiKey: string | undefined;
  baseUrl: string;
}

/** Resolve the selected provider's key + base URL (no network, env only). */
export function resolveProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const provider = resolveModelProvider(env);
  if (provider === "deepseek") {
    return {
      provider,
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL,
    };
  }
  return {
    provider,
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE_URL,
  };
}

export interface ScriptedProviderOptions {
  triageOutputs: string[];
}

/** Scripted triage transport: the canned driver behind the `scripted` tag. */
export interface ScriptedTriageProvider extends TriageProvider {
  readonly tag: "scripted";
}

/** Scripted driver: shifts one canned string per triage call (CI, zero keys). */
export function createScriptedProvider(options: ScriptedProviderOptions): ScriptedTriageProvider {
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
  provider: ModelProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Extract the assistant content, preserving the refusal/empty sentinels. */
function extractContent(response: OpenAI.Chat.Completions.ChatCompletion): string {
  const message = response.choices[0]?.message;
  if (typeof message?.content === "string") {
    return message.content;
  }
  throw new Error(
    message?.refusal ? `live triage refused: ${message.refusal}` : "live triage returned no content",
  );
}

/** One structured `response_format: json_schema` triage call. */
async function jsonSchemaCompletion(
  client: OpenAI,
  model: string,
  prompt: string,
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "symptom_spec",
        schema: SymptomSpecSchema as unknown as Record<string, unknown>,
      },
    },
  });
  return extractContent(response);
}

/**
 * DeepSeek retry guard: only API errors whose message mentions
 * `response_format`/`json_schema` look like a structured-output rejection;
 * anything else propagates without retry.
 */
function isResponseFormatRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  const nested = record.error;
  const nestedRecord =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : null;
  const haystack = [
    record.message,
    record.code,
    record.type,
    record.status,
    nestedRecord?.message,
    nestedRecord?.code,
    nestedRecord?.type,
    nestedRecord?.param,
  ]
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .join(" ");
  return /response_format|json_schema/i.test(haystack);
}

/**
 * Live driver: one structured triage call via the `openai` SDK. OpenRouter
 * always sends `response_format: json_schema`. DeepSeek prefers `json_schema`
 * and falls back to `json_object` on a response-format rejection.
 */
export function createLiveProvider(options: LiveProviderOptions): LiveTriageProvider {
  const client = new OpenAI({ baseURL: options.baseUrl, apiKey: options.apiKey });
  return {
    tag: "live",
    provider: options.provider,
    baseUrl: options.baseUrl,
    model: options.model,
    async completeTriage(prompt: string): Promise<string> {
      if (options.provider === "deepseek") {
        try {
          return await jsonSchemaCompletion(client, options.model, prompt);
        } catch (error) {
          if (!isResponseFormatRejection(error)) {
            throw error;
          }
          const fallback = await client.chat.completions.create({
            model: options.model,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
          });
          return extractContent(fallback);
        }
      }
      return jsonSchemaCompletion(client, options.model, prompt);
    },
  };
}

/**
 * Choose the triage driver from the environment: scripted when the selected
 * provider's key (`OPENROUTER_API_KEY` / `DEEPSEEK_API_KEY`) is unset/empty,
 * live otherwise. Throws `missing MODEL_FAST for provider <p>` when the key
 * is set but `MODEL_FAST` is unset/empty — no empty model id is ever sent.
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): ScriptedTriageProvider | LiveTriageProvider {
  const { provider, apiKey, baseUrl } = resolveProviderConfig(env);
  if (apiKey === undefined || apiKey === "") {
    return createScriptedProvider({ triageOutputs: [] });
  }
  const model = env.MODEL_FAST;
  if (model === undefined || model === "") {
    throw new Error(`missing MODEL_FAST for provider ${provider}`);
  }
  return createLiveProvider({ provider, baseUrl, apiKey, model });
}
