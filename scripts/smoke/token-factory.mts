#!/usr/bin/env -S npx tsx
/**
 * Live Token Factory smoke (operator only — CI never runs this).
 *
 * Requires NEBIUS_API_KEY (plus MODEL_FAST and optionally NEBIUS_BASE_URL).
 * Builds the live provider via createProvider, sends a fixed demo issue
 * prompt, and prints the raw JSON plus the parsed library.
 */
import { createProvider } from "../../src/llm/provider.js";

const apiKey = process.env.NEBIUS_API_KEY;
if (apiKey === undefined || apiKey === "") {
  console.error("NEBIUS_API_KEY is required for the live Token Factory smoke");
  process.exit(2);
}

const provider = createProvider(process.env);
if (provider.tag !== "live") {
  console.error("expected the live provider with NEBIUS_API_KEY set");
  process.exit(2);
}

const raw = await provider.completeTriage(
  [
    "Summarize the bug report below as a symptom spec.",
    "Return spec JSON only: an object with library, versions, symptomClass, errorStrings, frames, trigger, expectedOutput.",
    "<<<UNTRUSTED:issue>>>",
    "lib crashes with boom on parse('')",
    "<<<END>>>",
  ].join("\n\n"),
);
console.log(raw);
console.log(JSON.stringify({ library: (JSON.parse(raw) as { library?: unknown }).library }));
