/**
 * PyPI version-list client seam: all network I/O behind the minimal
 * `PypiClient` interface so pure version logic stays testable without PyPI.
 * `HttpPypiClient` reads the JSON API's `releases` key; the PEP 691 Simple
 * API stub below marks the future fallback point behind the same interface.
 */
export interface PypiFile {
  filename: string;
  packagetype?: string;
}

export interface PypiClient {
  fetchReleases(pkg: string): Promise<Record<string, PypiFile[]>>;
}

interface PypiJsonResponse {
  releases?: Record<string, PypiFile[]>;
}

/**
 * JSON-API client: single global-`fetch` GET of
 * `https://pypi.org/pypi/<pkg>/json`, returning its `releases` record
 * (missing key reads as `{}`). Throws `pypi request failed: <status> ...`
 * on any non-2xx response.
 */
export class HttpPypiClient implements PypiClient {
  async fetchReleases(pkg: string): Promise<Record<string, PypiFile[]>> {
    const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`pypi request failed: ${res.status} ${res.statusText} for ${pkg}`);
    }
    const data = (await res.json()) as PypiJsonResponse;
    return data.releases ?? {};
  }
}

/**
 * PEP 691 fallback stub (Simple API, `https://pypi.org/simple/<pkg>/`).
 *
 * Extension point, not a live client: when the JSON API is unavailable the
 * fallback should GET the Simple index for `<pkg>` and map its per-version
 * file list into the same `Record<string, PypiFile[]>` shape, so callers
 * keep working unchanged. Currently throws `not implemented` instead.
 */
export class Pep691PypiClient implements PypiClient {
  async fetchReleases(pkg: string): Promise<Record<string, PypiFile[]>> {
    void pkg;
    throw new Error(
      `pypi simple api fallback not implemented: https://pypi.org/simple/${encodeURIComponent(pkg)}/`,
    );
  }
}
