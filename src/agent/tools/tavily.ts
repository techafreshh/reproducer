/**
 * Live Tavily research: `tavilySearch` on `POST /search` and `tavilyExtract`
 * on `POST /extract`, both Bearer-authed. Every result/content field is
 * sanitized with `sanitizeUntrusted` and wrapped with
 * `wrapDataBlock("tavily-search" | "tavily-extract", …)` at the tool boundary.
 * `max_results` is capped at 5.
 */
import { sanitizeUntrusted, wrapDataBlock } from "../../sanitize/sanitizer.js";
import type { TavilyExtractResponse, TavilyResult, TavilySearchResponse } from "./types.js";

export type FetchFn = typeof fetch;

/** Hard cap honored by every Tavily search call. */
export const TAVILY_MAX_RESULTS = 5;

export interface TavilySearchOptions {
  maxResults?: number;
  apiKey?: string;
  fetch?: FetchFn;
}

export interface TavilyExtractOptions {
  apiKey?: string;
  fetch?: FetchFn;
}

interface RawTavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  body?: unknown;
  text?: unknown;
  snippet?: unknown;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rawContentOf(raw: RawTavilyResult): string {
  for (const key of ["content", "body", "text", "snippet"] as const) {
    const text = toText(raw[key]);
    if (text !== "") return text;
  }
  return "";
}

/** Clamp the requested count into `max_results`, defaulting to the 5-cap. */
export function clampMaxResults(maxResults?: number): number {
  if (maxResults === undefined) return TAVILY_MAX_RESULTS;
  if (!Number.isFinite(maxResults)) return TAVILY_MAX_RESULTS;
  return Math.min(Math.max(1, Math.floor(maxResults)), TAVILY_MAX_RESULTS);
}

function unionFlags(flagSets: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const set of flagSets) {
    for (const flag of set) {
      if (!seen.has(flag)) {
        seen.add(flag);
        out.push(flag);
      }
    }
  }
  return out;
}

/**
 * Pure response mapper: raw Tavily `results` payloads → sanitized
 * `TavilySearchResponse`. Enforces the ≤5 slice; separately testable from the
 * `fetch`-doing `tavilySearch` below.
 */
export function mapTavilySearchResults(rawResults: unknown, maxResults?: number): TavilySearchResponse {
  const list: RawTavilyResult[] = Array.isArray(rawResults) ? (rawResults as RawTavilyResult[]) : [];
  const cap = clampMaxResults(maxResults);
  const sliced = list.slice(0, cap);
  const results: TavilyResult[] = sliced.map((raw) => {
    const title = sanitizeUntrusted(toText(raw.title));
    const content = sanitizeUntrusted(rawContentOf(raw));
    return {
      title: title.clean,
      url: toText(raw.url),
      content: content.clean,
      clean: content.clean,
      flags: unionFlags([title.flags, content.flags]),
    };
  });
  const flags = unionFlags(results.map((result) => result.flags));
  const clean = results.map((result) => result.clean).join("\n\n");
  return {
    results,
    flags,
    wrapped: wrapDataBlock("tavily-search", clean),
    clean,
  };
}

/**
 * Pure response mapper: raw Tavily extract payload → sanitized
 * `TavilyExtractResponse`. Accepts `/extract` shapes (`raw_content`,
 * `content`, `text`) and single-result `results` arrays.
 */
export function mapTavilyExtract(raw: unknown, fallbackUrl: string): TavilyExtractResponse {
  let url = fallbackUrl;
  let rawContent = "";
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (typeof record.url === "string" && record.url !== "") url = record.url;
    for (const key of ["raw_content", "content", "text", "body"]) {
      const text = toText(record[key]);
      if (text !== "") {
        rawContent = text;
        break;
      }
    }
    if (rawContent === "" && Array.isArray(record.results)) {
      const first = (record.results as RawTavilyResult[])[0];
      if (first !== undefined) {
        if (toText(first.url) !== "") url = toText(first.url);
        rawContent = rawContentOf(first);
        const alt = toText((first as Record<string, unknown>).raw_content);
        if (rawContent === "" && alt !== "") rawContent = alt;
      }
    }
  } else if (typeof raw === "string") {
    rawContent = raw;
  }
  const content = sanitizeUntrusted(rawContent);
  return {
    url,
    content: content.clean,
    clean: content.clean,
    flags: content.flags,
    wrapped: wrapDataBlock("tavily-extract", content.clean),
  };
}

function requireApiKey(apiKey?: string): string {
  if (apiKey === undefined || apiKey === "") {
    throw new Error("missing TAVILY_API_KEY: set TAVILY_API_KEY or configure fixtures");
  }
  return apiKey;
}

/**
 * Search Tavily for `query`. `maxResults` defaults to 5 and is clamped into
 * `max_results` with `Math.min(maxResults, 5)`. Throws `missing
 * TAVILY_API_KEY` when no key is supplied.
 */
export async function tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<TavilySearchResponse> {
  const apiKey = requireApiKey(opts.apiKey);
  const maxResults = clampMaxResults(opts.maxResults);
  const doFetch: FetchFn = opts.fetch ?? globalThis.fetch;
  const res = await doFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, max_results: maxResults }),
  });
  if (!res.ok) {
    throw new Error(`tavily search failed: ${res.status}`);
  }
  const payload = (await res.json()) as { results?: unknown };
  return mapTavilySearchResults(payload.results, maxResults);
}

/** Extract readable content for `url` via Tavily `/extract`. */
export async function tavilyExtract(url: string, opts: TavilyExtractOptions = {}): Promise<TavilyExtractResponse> {
  const apiKey = requireApiKey(opts.apiKey);
  const doFetch: FetchFn = opts.fetch ?? globalThis.fetch;
  const res = await doFetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ urls: [url] }),
  });
  if (!res.ok) {
    throw new Error(`tavily extract failed: ${res.status}`);
  }
  const payload = (await res.json()) as unknown;
  return mapTavilyExtract(payload, url);
}
