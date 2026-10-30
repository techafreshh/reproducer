/**
 * Live TinyFish research: `tinyfishSearch` on `GET https://api.search.tinyfish.ai`
 * (`X-API-Key` header, `query` + optional `purpose` params) and
 * `tinyfishFetch` on `POST https://api.fetch.tinyfish.ai`
 * (`X-API-Key` header, body `{urls: [url], format: "markdown"}`).
 * Every result/title/snippet/text field is sanitized with
 * `sanitizeUntrusted` and wrapped with
 * `wrapDataBlock("tinyfish-search" | "tinyfish-fetch", …)` at the tool
 * boundary. Search results are capped at 5 client-side (the search API sends
 * no server-side max-results param).
 */
import { sanitizeUntrusted, wrapDataBlock } from "../../sanitize/sanitizer.js";
import type { TinyfishExtractResponse, TinyfishResult, TinyfishSearchResponse } from "./types.js";

export type FetchFn = typeof fetch;

/** Hard cap honored by every TinyFish search call. */
export const TINYFISH_MAX_RESULTS = 5;

export interface TinyfishSearchOptions {
  maxResults?: number;
  purpose?: string;
  apiKey?: string;
  fetch?: FetchFn;
}

export interface TinyfishExtractOptions {
  apiKey?: string;
  fetch?: FetchFn;
}

interface RawTinyfishResult {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  content?: unknown;
  body?: unknown;
  text?: unknown;
  raw_content?: unknown;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rawContentOf(raw: RawTinyfishResult): string {
  for (const key of ["snippet", "content", "text", "body"] as const) {
    const text = toText(raw[key]);
    if (text !== "") return text;
  }
  return "";
}

/** Clamp the requested count into the 5-cap, defaulting to the cap. */
export function clampMaxResults(maxResults?: number): number {
  if (maxResults === undefined) return TINYFISH_MAX_RESULTS;
  if (!Number.isFinite(maxResults)) return TINYFISH_MAX_RESULTS;
  return Math.min(Math.max(1, Math.floor(maxResults)), TINYFISH_MAX_RESULTS);
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
 * Pure response mapper: raw TinyFish search `results` payloads → sanitized
 * `TinyfishSearchResponse`. Enforces the ≤5 slice; separately testable from
 * the `fetch`-doing `tinyfishSearch` below.
 */
export function mapTinyfishSearchResults(rawResults: unknown, maxResults?: number): TinyfishSearchResponse {
  const list: RawTinyfishResult[] = Array.isArray(rawResults) ? (rawResults as RawTinyfishResult[]) : [];
  const cap = clampMaxResults(maxResults);
  const sliced = list.slice(0, cap);
  const results: TinyfishResult[] = sliced.map((raw) => {
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
    wrapped: wrapDataBlock("tinyfish-search", clean),
    clean,
  };
}

/**
 * Pure response mapper: raw TinyFish fetch payload → sanitized
 * `TinyfishExtractResponse`. Accepts single-result `results` arrays carrying
 * `text` (plus `content`/`raw_content`/`body` tolerance) and top-level
 * `text`/`content`/`raw_content` shapes. A payload whose only entry lives in
 * `errors[]` (`bot_blocked`, `timeout`, `login_required`, …) is a clean
 * failure: it returns a sanitized empty-content result instead of throwing.
 */
export function mapTinyfishExtract(raw: unknown, fallbackUrl: string): TinyfishExtractResponse {
  let url = fallbackUrl;
  let rawContent = "";
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (typeof record.url === "string" && record.url !== "") url = record.url;
    for (const key of ["text", "content", "raw_content", "body"]) {
      const text = toText(record[key]);
      if (text !== "") {
        rawContent = text;
        break;
      }
    }
    if (rawContent === "" && Array.isArray(record.results)) {
      const first = (record.results as RawTinyfishResult[])[0];
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
    wrapped: wrapDataBlock("tinyfish-fetch", content.clean),
  };
}

function requireApiKey(apiKey?: string): string {
  if (apiKey === undefined || apiKey === "") {
    throw new Error("missing TINYFISH_API_KEY: set TINYFISH_API_KEY or configure fixtures");
  }
  return apiKey;
}

/**
 * Search TinyFish for `query`. `maxResults` defaults to 5 and is clamped
 * client-side with `Math.min(maxResults, 5)` — the API sends no max-results
 * param, only `query` plus the optional `purpose` intent text. Throws
 * `missing TINYFISH_API_KEY` when no key is supplied, and
 * `tinyfish search failed: <status>` on HTTP errors (401 invalid key, 402
 * allowance exhausted, 429 rate limit).
 */
export async function tinyfishSearch(query: string, opts: TinyfishSearchOptions = {}): Promise<TinyfishSearchResponse> {
  const apiKey = requireApiKey(opts.apiKey);
  const maxResults = clampMaxResults(opts.maxResults);
  const doFetch: FetchFn = opts.fetch ?? globalThis.fetch;
  const params = new URLSearchParams({ query });
  if (opts.purpose !== undefined && opts.purpose.trim() !== "") {
    params.set("purpose", opts.purpose);
  }
  const res = await doFetch(`https://api.search.tinyfish.ai?${params.toString()}`, {
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`tinyfish search failed: ${res.status}`);
  }
  const payload = (await res.json()) as { results?: unknown };
  return mapTinyfishSearchResults(payload.results, maxResults);
}

/** Extract readable content for `url` via TinyFish fetch (`format: "markdown"`). */
export async function tinyfishExtract(url: string, opts: TinyfishExtractOptions = {}): Promise<TinyfishExtractResponse> {
  const apiKey = requireApiKey(opts.apiKey);
  const doFetch: FetchFn = opts.fetch ?? globalThis.fetch;
  const res = await doFetch("https://api.fetch.tinyfish.ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ urls: [url], format: "markdown" }),
  });
  if (!res.ok) {
    throw new Error(`tinyfish fetch failed: ${res.status}`);
  }
  const payload = (await res.json()) as unknown;
  return mapTinyfishExtract(payload, url);
}
