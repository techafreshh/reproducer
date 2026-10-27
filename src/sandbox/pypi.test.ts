import { describe, expect, it } from "vitest";
import { HttpPypiClient, type PypiClient, type PypiFile } from "./pypi-client.js";
import { comparePep440, listVersions } from "./pypi.js";

class FixtureClient implements PypiClient {
  constructor(private readonly releases: Record<string, PypiFile[]>) {}

  async fetchReleases(_pkg: string): Promise<Record<string, PypiFile[]>> {
    return this.releases;
  }
}

describe("listVersions", () => {
  it("keeps sdist and py3-none-any versions, drops platform wheels", async () => {
    const client = new FixtureClient({
      "1.0.0": [{ filename: "pkg-1.0.0.tar.gz", packagetype: "sdist" }],
      "2.0.0": [{ filename: "pkg-2.0.0-cp312-cp312-manylinux_x86_64.whl", packagetype: "bdist_wheel" }],
      "2.1.0": [{ filename: "pkg-2.1.0-py3-none-any.whl", packagetype: "bdist_wheel" }],
    });
    await expect(listVersions(client, "pkg")).resolves.toEqual(["1.0.0", "2.1.0"]);
  });

  it("orders versions ascending by PEP 440, not lexicographically", async () => {
    const client = new FixtureClient({
      "1.10.0": [{ filename: "pkg-1.10.0.tar.gz", packagetype: "sdist" }],
      "1.9.0": [{ filename: "pkg-1.9.0.tar.gz", packagetype: "sdist" }],
    });
    await expect(listVersions(client, "pkg")).resolves.toEqual(["1.9.0", "1.10.0"]);
  });

  it("keeps py2.py3-none-any wheels and drops empty or platform-only versions", async () => {
    const client = new FixtureClient({
      "3.0.0": [{ filename: "pkg-3.0.0-py2.py3-none-any.whl", packagetype: "bdist_wheel" }],
      "3.1.0": [{ filename: "pkg-3.1.0-cp311-cp311-win_amd64.whl", packagetype: "bdist_wheel" }],
      "3.2.0": [],
    });
    await expect(listVersions(client, "pkg")).resolves.toEqual(["3.0.0"]);
  });

  it("sorts pre-releases before the final release", () => {
    expect(comparePep440("1.0rc1", "1.0")).toBeLessThan(0);
    expect(comparePep440("1.0a1", "1.0b1")).toBeLessThan(0);
    expect(comparePep440("1.0.dev1", "1.0a1")).toBeLessThan(0);
    expect(comparePep440("1.0", "1.0.post1")).toBeLessThan(0);
  });

  it.runIf(process.env.PYPI_LIVE !== "0")("live HttpPypiClient for six contains 1.16.0, sorted ascending", async () => {
    const versions = await listVersions(new HttpPypiClient(), "six");
    expect(versions).toContain("1.16.0");
    const sorted = [...versions].sort(comparePep440);
    expect(versions).toEqual(sorted);
  }, 60000);
});
