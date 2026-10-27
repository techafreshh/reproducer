/**
 * Pure PyPI version-list logic: `listVersions` keeps the installable
 * pure-Python versions from a client's `releases` record and sorts them
 * ascending by PEP 440. Never touches the network — the client seam in
 * `pypi-client.js` owns all I/O — so fixture clients drive every unit test.
 */
import type { PypiClient, PypiFile } from "./pypi-client.js";

/**
 * Whether one PyPI file installs anywhere: an sdist
 * (`packagetype === "sdist"`, or an archive name that is not a wheel), or a
 * wheel tagged `py3-none-any` / `py2.py3-none-any`. Any other `.whl` is a
 * platform-specific build and reads as not installable.
 */
export function isPurePythonFile(file: PypiFile): boolean {
  if (file.filename.endsWith(".whl")) {
    return file.filename.includes("py2.py3-none-any") || file.filename.includes("py3-none-any");
  }
  if (file.packagetype === "sdist") return true;
  return file.filename.endsWith(".tar.gz") || file.filename.endsWith(".zip");
}

/** Alias kept for the bisect-tool call sites drafted against that name. */
export const isInstallableFile = isPurePythonFile;

// PEP 440 precedence per release segment, then pre/post/dev:
// `[epoch!]release[pre][post][dev][+local]`, where `pre` is
// `a|alpha|b|beta|c|rc|preview|pre`, `post` is `post|rev|r`, and anything
// else in the suffix leaves the version unparseable.
const PRE_KIND: Record<string, number> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  c: 2,
  rc: 2,
  preview: 2,
  pre: 2,
};

interface ParsedPep440 {
  epoch: number;
  release: number[];
  preKind: number;
  preNum: number;
  post: number;
  dev: number;
  local: (number | string)[];
  hasLocal: boolean;
}

/** Parse a PEP 440 version; null when the string is not a valid version. */
function parsePep440(version: string): ParsedPep440 | null {
  const lower = version.trim().toLowerCase();
  if (lower.length === 0) return null;
  const head = /^(?:(\d+)!)?(\d+(?:\.\d+)*)(.*)$/.exec(lower);
  if (head?.[2] === undefined || head[3] === undefined) return null;
  const epoch = head[1] === undefined ? 0 : Number(head[1]);
  const release = head[2].split(".").map(Number);
  if (!Number.isSafeInteger(epoch) || release.some((n) => !Number.isSafeInteger(n))) return null;
  let rest = head[3];

  let local: (number | string)[] = [];
  let hasLocal = false;
  const plus = rest.indexOf("+");
  if (plus !== -1) {
    const localStr = rest.slice(plus + 1);
    rest = rest.slice(0, plus);
    if (!/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(localStr)) return null;
    hasLocal = true;
    local = localStr.split(/[-_.]/).map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
  }

  let preKind = 3;
  let preNum = 0;
  let hasPre = false;
  const pre = /^[-_.]?(a|alpha|b|beta|c|rc|preview|pre)[-_.]?(\d*)/.exec(rest);
  if (pre?.[1] !== undefined && pre[2] !== undefined) {
    const kind = PRE_KIND[pre[1]];
    if (kind === undefined) return null;
    preKind = kind;
    preNum = pre[2] === "" ? 0 : Number(pre[2]);
    if (!Number.isSafeInteger(preNum)) return null;
    hasPre = true;
    rest = rest.slice(pre[0].length);
  }

  let post = -1;
  const postMatch = /^[-_.]?(post|rev|r)[-_.]?(\d*)/.exec(rest);
  if (postMatch?.[2] !== undefined) {
    post = postMatch[2] === "" ? 0 : Number(postMatch[2]);
    if (!Number.isSafeInteger(post)) return null;
    rest = rest.slice(postMatch[0].length);
  }

  let dev = -1;
  const devMatch = /^[-_.]?dev[-_.]?(\d*)/.exec(rest);
  if (devMatch?.[1] !== undefined) {
    dev = devMatch[1] === "" ? 0 : Number(devMatch[1]);
    if (!Number.isSafeInteger(dev)) return null;
    rest = rest.slice(devMatch[0].length);
  }

  if (!/^[-_.]*$/.test(rest)) return null;
  // A bare `.devN` (no pre, no post) precedes even alphas: `1.0.dev1 < 1.0a1`.
  if (!hasPre && post === -1 && dev !== -1) preKind = -1;
  return { epoch, release, preKind, preNum, post, dev, local, hasLocal };
}

/** Compare two local segments: numbers sort before strings, then by value. */
function compareLocalSegments(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ascending PEP 440 ordering: epoch, then zero-padded release segments, then
 * pre (`dev < a < b < rc < final`), then post, then dev (a `.devN` sorts
 * before the same release without it), then local (`+local` sorts after the
 * bare release). Unparseable versions sort after parseable ones by plain
 * string comparison rather than throwing.
 */
export function comparePep440(a: string, b: string): number {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (pa === null && pb === null) return a < b ? -1 : a > b ? 1 : 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch;
  const width = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < width; i++) {
    const x = pa.release[i] ?? 0;
    const y = pb.release[i] ?? 0;
    if (x !== y) return x - y;
  }
  if (pa.preKind !== pb.preKind) return pa.preKind - pb.preKind;
  if (pa.preNum !== pb.preNum) return pa.preNum - pb.preNum;
  if (pa.post !== pb.post) return pa.post - pb.post;
  if (pa.dev !== pb.dev) {
    if (pa.dev === -1) return 1;
    if (pb.dev === -1) return -1;
    return pa.dev - pb.dev;
  }
  if (pa.hasLocal !== pb.hasLocal) return pa.hasLocal ? 1 : -1;
  const localWidth = Math.max(pa.local.length, pb.local.length);
  for (let i = 0; i < localWidth; i++) {
    const x = pa.local[i];
    const y = pb.local[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const cmp = compareLocalSegments(x, y);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/** Alias kept for call sites drafted against the generic comparator name. */
export const compareVersions = comparePep440;

/**
 * Ordered list of installable pure-Python versions of `pkg`: keeps versions
 * with at least one `isPurePythonFile` file (a version kept by any single
 * qualifying file is listed once; zero-file and platform-wheel-only versions
 * are dropped) and sorts ascending with `comparePep440`.
 */
export async function listVersions(client: PypiClient, pkg: string): Promise<string[]> {
  const releases = await client.fetchReleases(pkg);
  const versions = Object.keys(releases).filter((version) => {
    const files = releases[version] ?? [];
    return files.some(isPurePythonFile);
  });
  versions.sort(comparePep440);
  return versions;
}
