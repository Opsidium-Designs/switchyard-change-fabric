/**
 * `switchyard-change showcase-app` at the real CLI entrypoint (offline): a
 * dry run against this repo's examples/apps and published replays prints the
 * exact wrangler calls and the showcase config and writes nothing (the replay
 * index is byte-for-byte unchanged); bad flag combinations are refused. A dry
 * run never calls wrangler, so no network is touched.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const INDEX = resolve(REPO_ROOT, "apps/console/public/replays/index.json");

function runCli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SCF_ENV_FILE: "/dev/null" };
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) delete env[key];
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", CLI, ...args],
      { cwd: REPO_ROOT, env, timeout: 60_000 },
      (error, stdout, stderr) => resolvePromise({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

describe("showcase-app CLI", () => {
  it("a before-only dry run prints the calls and the config and writes nothing", async () => {
    const before = await readFile(INDEX, "utf8");
    const { code, stdout } = await runCli(["showcase-app", "--app", "storefront", "--before-only", "--run", "board-live-sf7", "--run", "board-live-sf8", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("worker switchyard-showcase-storefront (dry run: nothing is uploaded or written)");
    expect(stdout).toMatch(/\(cd \S+\/before && wrangler deploy --message 'showcase storefront: original [0-9a-f]{10}'\)/);
    expect(stdout).toMatch(/\(cd \S+\/before && wrangler versions upload --preview-alias before --message/);
    expect(stdout).not.toContain("--preview-alias after");
    expect(stdout).toContain('"preview_urls": true');
    expect(stdout).toContain("records on: board-live-sf7, board-live-sf8");
    expect(stdout).toContain("Dry run: nothing was uploaded and nothing was written.");
    expect(await readFile(INDEX, "utf8")).toBe(before);
  });

  it("refuses bad combinations with a clear error", async () => {
    const none = await runCli(["showcase-app", "--app", "storefront", "--dry-run"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("pass --fixed");
    const both = await runCli(["showcase-app", "--app", "storefront", "--fixed", "x.bundle", "--before-only", "--run", "board-live-sf21", "--dry-run"]);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("do not go together");
    const wrongApp = await runCli(["showcase-app", "--app", "storefront", "--before-only", "--run", "board-live-l3", "--dry-run"]);
    expect(wrongApp.code).toBe(1);
    expect(wrongApp.stderr).toContain('is of the app "service-api"');
    const noApp = await runCli(["showcase-app", "--before-only"]);
    expect(noApp.code).toBe(1);
    expect(noApp.stderr).toContain("Usage: switchyard-change showcase-app");
  });
});
