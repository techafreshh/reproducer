import { readFileSync } from "node:fs";

/** Resolved posting configuration for `reproducer run --post`. */
export interface PostConfig {
  /** Lowercased-compare allowlist of `owner/repo` strings. */
  allowlist: string[];
  /** Base URL for the `Trace: <base>/runs/<id>` comment link. */
  dashboardBase: string;
}

/** Default dashboard base when no config key or env override sets one. */
export const DEFAULT_DASHBOARD_BASE = "http://localhost:8080";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || !trimmed.includes("/")) continue;
    out.push(trimmed);
  }
  return out;
}

function firstString(candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "") || DEFAULT_DASHBOARD_BASE;
}

/**
 * Load posting config from a JSON file. Missing path (or missing file)
 * reads as empty-allowlist defaults; malformed JSON throws the
 * `invalid config: <path>` sentinel. The allowlist is read from the first
 * array found at `reproducer.post.allowlist`, `post.allowlist`,
 * `reproducer.allowlist`, or top-level `allowlist`; the dashboard base
 * from `reproducer.dashboardBase` (plus common aliases) else
 * `DASHBOARD_BASE_URL`, else the localhost default.
 */
export function loadPostConfig(configPath?: string): PostConfig {
  const envBase =
    typeof process.env.DASHBOARD_BASE_URL === "string" &&
    process.env.DASHBOARD_BASE_URL.trim().length > 0
      ? normalizeBase(process.env.DASHBOARD_BASE_URL)
      : DEFAULT_DASHBOARD_BASE;
  if (configPath === undefined || configPath.trim() === "") {
    return { allowlist: [], dashboardBase: envBase };
  }
  const path = configPath;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { allowlist: [], dashboardBase: envBase };
    }
    throw new Error(`invalid config: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid config: ${path}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`invalid config: ${path}`);
  }
  const reproducer = isRecord(parsed.reproducer) ? parsed.reproducer : undefined;
  const post = isRecord(parsed.post)
    ? parsed.post
    : reproducer !== undefined && isRecord(reproducer.post)
      ? reproducer.post
      : undefined;
  const allowlist =
    asStringList(post?.allowlist).length > 0
      ? asStringList(post?.allowlist)
      : asStringList(reproducer?.allowlist).length > 0
        ? asStringList(reproducer?.allowlist)
        : asStringList(parsed.allowlist);
  const base =
    firstString([
      reproducer?.dashboardBase,
      reproducer?.dashboard_base,
      (reproducer?.dashboard as unknown) instanceof Object
        ? (reproducer?.dashboard as Record<string, unknown>).base
        : undefined,
      post?.dashboardBase,
      post?.dashboard_base,
      parsed.dashboardBase,
      parsed.dashboard_base,
    ]) ?? envBase;
  return { allowlist, dashboardBase: normalizeBase(base) };
}

/**
 * Case-insensitive `owner/repo` membership check against the allowlist.
 * Both sides are trimmed before comparison; GitHub names are
 * case-insensitive.
 */
export function isRepoAllowlisted(owner: string, repo: string, allowlist: string[]): boolean {
  const target = `${owner.trim()}/${repo.trim()}`.toLowerCase();
  return allowlist.some((entry) => entry.trim().toLowerCase() === target);
}
