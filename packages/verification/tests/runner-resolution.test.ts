/**
 * The gate's own toolchain is part of the gate: a worker cannot swap the test
 * runner through package.json and the lockfile (a version bump, a file: link,
 * an npm alias, a nested shadow copy, a new package claiming the runner's
 * bin), while unrelated dependency changes stay allowed. Fixture lockfiles;
 * offline.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertRunnerResolutionUnchanged,
  MAX_LOCKFILE_KEYS,
  runnerClosure,
  runnerPackagesFor,
  runnerPackagesFromJsonKeys,
  runnerResolutionContract,
  runnerResolutionViolations,
  type DependencySnapshot,
} from "../src/index.ts";

const manifest = (devDependencies: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "app", scripts: { gate: "vitest run" }, devDependencies, ...extra }, null, 2);

const BASE_PACKAGES = {
  "": { name: "app", devDependencies: { vitest: "2.1.8", "left-pad": "1.3.0" } },
  "node_modules/vitest": {
    version: "2.1.8",
    resolved: "https://registry.npmjs.org/vitest/-/vitest-2.1.8.tgz",
    integrity: "sha512-vitest",
    dev: true,
    dependencies: { vite: "^5.0.0", tinypool: "^1.0.0" },
    bin: { vitest: "vitest.mjs" },
  },
  "node_modules/vite": {
    version: "5.4.0",
    resolved: "https://registry.npmjs.org/vite/-/vite-5.4.0.tgz",
    integrity: "sha512-vite",
    dev: true,
    dependencies: { esbuild: "^0.21.0" },
    bin: { vite: "bin/vite.js" },
  },
  "node_modules/esbuild": { version: "0.21.5", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.21.5.tgz", integrity: "sha512-esbuild", dev: true },
  "node_modules/tinypool": { version: "1.0.1", resolved: "https://registry.npmjs.org/tinypool/-/tinypool-1.0.1.tgz", integrity: "sha512-tinypool", dev: true },
  "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-leftpad", dev: true },
};

const lock = (packages: Record<string, unknown>) => JSON.stringify({ name: "app", lockfileVersion: 3, requires: true, packages }, null, 2);

const BASE: DependencySnapshot = {
  manifest: manifest({ vitest: "2.1.8", "left-pad": "1.3.0" }),
  lockfiles: { "package-lock.json": lock(BASE_PACKAGES) },
};

/** The baseline with some packages entries replaced (undefined removes one). */
function gated(changes: Record<string, unknown>, devDependencies: Record<string, string> = { vitest: "2.1.8", "left-pad": "1.3.0" }, extra: Record<string, unknown> = {}): DependencySnapshot {
  const packages: Record<string, unknown> = { ...BASE_PACKAGES };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete packages[key];
    } else {
      packages[key] = value;
    }
  }
  return { manifest: manifest(devDependencies, extra), lockfiles: { "package-lock.json": lock(packages) } };
}

describe("runner packages and their closure", () => {
  it("maps the programs the gate runs to packages (by bin and by name) and follows the lockfile closure", () => {
    expect(runnerPackagesFor(["vitest", "tsc"], BASE)).toEqual(["tsc", "typescript", "vitest"]);
    // Other words count only when they name a baseline bin.
    expect(runnerPackagesFor([], BASE, ["run", "vite"])).toEqual(["vite"]);
    expect(runnerClosure(BASE.lockfiles["package-lock.json"], ["vitest"])).toEqual([
      "node_modules/esbuild",
      "node_modules/tinypool",
      "node_modules/vite",
      "node_modules/vitest",
    ]);
  });

  it("the claim-time contract protects the runner's declarations, the resolution sections, and its lockfile closure, never unrelated entries", () => {
    const contract = runnerResolutionContract(BASE, ["vitest"]);
    const pkg = contract.jsonKeys.find((j) => j.file === "package.json")!.keys;
    expect(pkg).toEqual(expect.arrayContaining([["devDependencies", "vitest"], ["dependencies", "vitest"], ["overrides"], ["resolutions"]]));
    expect(pkg).not.toContainEqual(["devDependencies", "left-pad"]);
    const lockKeys = contract.jsonKeys.find((j) => j.file === "package-lock.json")!.keys;
    expect(lockKeys).toEqual(expect.arrayContaining([["packages", "node_modules/vitest"], ["packages", "node_modules/esbuild"]]));
    expect(lockKeys).not.toContainEqual(["packages", "node_modules/left-pad"]);
    // Every key segment is non-empty (the integration job refuses an empty one).
    expect(contract.jsonKeys.every((j) => j.keys.every((k) => k.every((s) => s !== "")))).toBe(true);
    expect(runnerPackagesFromJsonKeys(contract.jsonKeys)).toEqual(["vitest"]);
    // A pnpm or yarn lockfile is protected whole.
    expect(runnerResolutionContract({ manifest: BASE.manifest!, lockfiles: { "pnpm-lock.yaml": "lockfileVersion: 9\n" } }, ["vitest"]).wholeFiles).toEqual(["pnpm-lock.yaml"]);
    expect(runnerResolutionContract(BASE, []).jsonKeys).toEqual([]);
    // A closure too large to list (or an unreadable lockfile) protects the lockfile whole.
    const big: Record<string, unknown> = { "": { name: "app" }, "node_modules/vitest": { version: "1", dependencies: {} as Record<string, string> } };
    for (let i = 0; i <= MAX_LOCKFILE_KEYS; i += 1) {
      (big["node_modules/vitest"] as { dependencies: Record<string, string> }).dependencies[`dep-${i}`] = "1";
      big[`node_modules/dep-${i}`] = { version: "1" };
    }
    expect(runnerResolutionContract({ manifest: BASE.manifest!, lockfiles: { "package-lock.json": lock(big) } }, ["vitest"]).wholeFiles).toEqual(["package-lock.json"]);
    expect(runnerResolutionContract({ manifest: BASE.manifest!, lockfiles: { "package-lock.json": "{ not json" } }, ["vitest"]).wholeFiles).toEqual(["package-lock.json"]);
  });
});

describe("runnerResolutionViolations: the gated tree against the baseline", () => {
  it("allows an unrelated dependency bump", () => {
    const bump = gated(
      { "node_modules/left-pad": { version: "1.3.1", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.1.tgz", integrity: "sha512-x", dev: true } },
      { vitest: "2.1.8", "left-pad": "1.3.1" },
    );
    expect(runnerResolutionViolations(BASE, bump, ["vitest"])).toEqual([]);
    expect(runnerResolutionViolations(BASE, BASE, ["vitest"])).toEqual([]);
  });

  it("refuses a version bump of the runner (manifest and lockfile)", () => {
    const bump = gated(
      { "node_modules/vitest": { ...BASE_PACKAGES["node_modules/vitest"], version: "2.1.9", resolved: "https://registry.npmjs.org/vitest/-/vitest-2.1.9.tgz", integrity: "sha512-other" } },
      { vitest: "2.1.9", "left-pad": "1.3.0" },
    );
    const found = runnerResolutionViolations(BASE, bump, ["vitest"]);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^package\.json#devDependencies\.vitest: .*"2\.1\.8" to "2\.1\.9"/),
        expect.stringMatching(/^package-lock\.json#packages\["node_modules\/vitest"\]: .*version 2\.1\.8 .* to version 2\.1\.9/),
      ]),
    );
  });

  it("refuses a file: link for the runner", () => {
    const link = gated(
      { "node_modules/vitest": { resolved: "shim", link: true }, shim: { name: "vitest", version: "2.1.8", bin: { vitest: "index.js" } } },
      { vitest: "file:./shim", "left-pad": "1.3.0" },
    );
    const found = runnerResolutionViolations(BASE, link, ["vitest"]);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/package\.json#devDependencies\.vitest: .* to a local path \(file:\.\/shim\)/),
        expect.stringMatching(/package-lock\.json#packages\["node_modules\/vitest"\]: .*a local link to shim \(a local link or file: path is never accepted/),
      ]),
    );
  });

  it("refuses an npm alias for the runner, and a changed transitive dependency of it", () => {
    const alias = gated(
      { "node_modules/vitest": { name: "evil-runner", version: "1.0.0", resolved: "https://registry.npmjs.org/evil-runner/-/evil-runner-1.0.0.tgz", integrity: "sha512-evil", dev: true } },
      { vitest: "npm:evil-runner@1.0.0", "left-pad": "1.3.0" },
    );
    expect(runnerResolutionViolations(BASE, alias, ["vitest"])).toEqual(
      expect.arrayContaining([expect.stringMatching(/devDependencies\.vitest: .* to an npm alias \(npm:evil-runner@1\.0\.0\)/), expect.stringMatching(/node_modules\/vitest/)]),
    );
    const transitive = gated({ "node_modules/esbuild": { version: "0.21.5", resolved: "file:../esbuild-shim", dev: true } });
    expect(runnerResolutionViolations(BASE, transitive, ["vitest"])).toEqual([expect.stringMatching(/node_modules\/esbuild.*local path \(file:\.\.\/esbuild-shim\)/)]);
  });

  it("refuses a nested copy that would shadow a closure entry, a new package claiming the runner's bin, and changed overrides", () => {
    const nested = gated({ "node_modules/vitest/node_modules/vite": { version: "0.0.1", resolved: "https://example.invalid/vite.tgz", integrity: "sha512-x" } });
    expect(runnerResolutionViolations(BASE, nested, ["vitest"])).toEqual([expect.stringMatching(/node_modules\/vitest\/node_modules\/vite.*absent to version 0\.0\.1/)]);
    const hijack = gated({ "node_modules/innocent": { version: "1.0.0", resolved: "https://registry.npmjs.org/innocent/-/innocent-1.0.0.tgz", integrity: "sha512-i", bin: { vitest: "x.js" } } });
    expect(runnerResolutionViolations(BASE, hijack, ["vitest"])).toEqual([expect.stringMatching(/node_modules\/innocent.*declares the gate's runner bin\(s\) vitest/)]);
    const overrides = gated({}, undefined, { overrides: { esbuild: "file:./esbuild-shim" } });
    expect(runnerResolutionViolations(BASE, overrides, ["vitest"])).toEqual([expect.stringMatching(/^package\.json#overrides: changed/)]);
  });

  it("refuses an added or removed lockfile and compares a pnpm lockfile whole", () => {
    expect(runnerResolutionViolations(BASE, { ...BASE, lockfiles: {} }, ["vitest"])).toEqual([expect.stringMatching(/package-lock\.json: removed/)]);
    const pnpm = (text: string): DependencySnapshot => ({ manifest: BASE.manifest!, lockfiles: { "pnpm-lock.yaml": text } });
    expect(runnerResolutionViolations(pnpm("a"), pnpm("a"), ["vitest"])).toEqual([]);
    expect(runnerResolutionViolations(pnpm("a"), pnpm("b"), ["vitest"])).toEqual([expect.stringMatching(/pnpm-lock\.yaml: changed/)]);
  });

  it("assertRunnerResolutionUnchanged reads directories and refuses with every reason", async () => {
    const write = async (snapshot: DependencySnapshot) => {
      const dir = await mkdtemp(join(tmpdir(), "scf-runner-"));
      await writeFile(join(dir, "package.json"), snapshot.manifest!);
      for (const [name, text] of Object.entries(snapshot.lockfiles)) {
        await writeFile(join(dir, name), text);
      }
      return dir;
    };
    const baseDir = await write(BASE);
    await expect(assertRunnerResolutionUnchanged(baseDir, await write(BASE), ["vitest"])).resolves.toBeUndefined();
    const link = gated({ "node_modules/vitest": { resolved: "shim", link: true } }, { vitest: "file:./shim", "left-pad": "1.3.0" });
    await expect(assertRunnerResolutionUnchanged(baseDir, await write(link), ["vitest"])).rejects.toThrow(/integration refused: the gated tree changes the gate's own toolchain .*devDependencies\.vitest/);
  });
});
