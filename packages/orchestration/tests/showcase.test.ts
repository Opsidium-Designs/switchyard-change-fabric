/**
 * The replay page's "Try the app" showcase (offline): the worker and alias
 * names, the `--fixed <src>[@ref]` parsing, the showcase-only wrangler config,
 * the wrangler commands and their dry-run lines, the alias URLs parsed from
 * realistic wrangler output, the honesty check (the fixed commit must be the
 * run's passing revision: the gated tree, else the recorded promoted commit;
 * a mismatch or a missing proof refuses), the replay index update, and the
 * whole command against temp git repos and a git bundle with a FAKE wrangler
 * (a dry run calls nothing and writes nothing; a refusal happens before any
 * call). No network.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parsePreviewReplay, type PreviewReplayFile } from "../src/preview-replay.ts";
import { parsePreviewAliasUrl } from "../src/revision-preview.ts";
import {
  afterAlias,
  checkFixedMatchesRun,
  formatShowcaseCommand,
  isShowcaseUrl,
  parseFixedSource,
  readAppWranglerConfig,
  runShowcaseApp,
  showcaseCommands,
  showcaseRunFacts,
  showcaseWorkerName,
  showcaseWranglerConfig,
  withShowcaseApps,
} from "../src/showcase.ts";

const git = promisify(execFile);

async function sh(cwd: string, ...args: string[]): Promise<string> {
  return (await git("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), body);
  }
}

const REPLAYS = new URL("../../../apps/console/public/replays/", import.meta.url);

async function publishedReplay(id: string): Promise<PreviewReplayFile> {
  return parsePreviewReplay(await readFile(new URL(`${id}.json`, REPLAYS), "utf8"));
}

describe("names", () => {
  it("one showcase worker per app, outside the infra-down pattern", () => {
    expect(showcaseWorkerName("storefront")).toBe("switchyard-showcase-storefront");
    expect(showcaseWorkerName("storefront").startsWith("switchyard-change-fabric-")).toBe(false);
    expect(() => showcaseWorkerName("../x")).toThrow(/app directory name/);
    expect(() => showcaseWorkerName("x".repeat(60))).toThrow(/too long/);
  });

  it("the fixed alias names the run and revision and fits one hostname label", () => {
    const worker = showcaseWorkerName("storefront");
    expect(afterAlias("board-live-sf21", 6, worker)).toBe("after-sf21-r6");
    expect(afterAlias("board-live-l3", 5, showcaseWorkerName("service-api"))).toBe("after-l3-r5");
    const long = afterAlias(`board-${"x".repeat(80)}`, 12, worker);
    expect(`${long}-${worker}`.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^after-x+-r12$/);
  });

  it("parses --fixed <src>[@ref]", () => {
    expect(parseFixedSource("/s/storefront--board-live-sf21.bundle")).toEqual({ path: "/s/storefront--board-live-sf21.bundle", ref: "HEAD" });
    expect(parseFixedSource("/s/a.bundle@switchyard/board-live-sf21")).toEqual({ path: "/s/a.bundle", ref: "switchyard/board-live-sf21" });
    expect(parseFixedSource("repo@15d7d40565")).toEqual({ path: "repo", ref: "15d7d40565" });
    // An "@" inside an existing directory name is part of the path.
    expect(parseFixedSource("/home/me@work/repo")).toEqual({ path: "/home/me", ref: "work/repo" });
    expect(parseFixedSource("/home/me@work/repo", (p) => p === "/home/me@work/repo")).toEqual({ path: "/home/me@work/repo", ref: "HEAD" });
    expect(parseFixedSource("/s/a.bundle@main", (p) => p === "/s/a.bundle")).toEqual({ path: "/s/a.bundle", ref: "main" });
    expect(() => parseFixedSource("repo@-x")).toThrow(/not a ref/);
    expect(() => parseFixedSource("repo@a..b")).toThrow(/not a ref/);
    expect(() => parseFixedSource("")).toThrow(/needs a git directory/);
  });
});

describe("the showcase wrangler config", () => {
  it("keeps the app's main and compatibility date, names the showcase worker, and turns preview URLs on", () => {
    const app = readAppWranglerConfig(
      '{\n  // the app\n  "name": "switchyard-change-fabric-storefront",\n  "main": "src/index.ts",\n  "compatibility_date": "2025-09-23",\n  "observability": { "enabled": true },\n}\n',
      "storefront",
    );
    expect(app).toEqual({ main: "src/index.ts", compatibilityDate: "2025-09-23" });
    const text = showcaseWranglerConfig("switchyard-showcase-storefront", app);
    expect(text.startsWith("// ")).toBe(true);
    const body = JSON.parse(text.split("\n").slice(1).join("\n"));
    expect(body).toEqual({
      name: "switchyard-showcase-storefront",
      main: "src/index.ts",
      compatibility_date: "2025-09-23",
      workers_dev: true,
      preview_urls: true,
    });
    const flagged = readAppWranglerConfig('{"main":"src/index.js","compatibility_date":"2025-01-01","compatibility_flags":["nodejs_compat"]}', "x");
    expect(JSON.parse(showcaseWranglerConfig("w", flagged).split("\n").slice(1).join("\n")).compatibility_flags).toEqual(["nodejs_compat"]);
  });

  it("refuses a config it cannot use", () => {
    expect(() => readAppWranglerConfig("not json", "x")).toThrow(/not a JSON object/);
    expect(() => readAppWranglerConfig('{"compatibility_date":"2025-01-01"}', "x")).toThrow(/main/);
    expect(() => readAppWranglerConfig('{"main":"../out.js","compatibility_date":"2025-01-01"}', "x")).toThrow(/main/);
    expect(() => readAppWranglerConfig('{"main":"/abs.js","compatibility_date":"2025-01-01"}', "x")).toThrow(/main/);
    expect(() => readAppWranglerConfig('{"main":"src/a.js"}', "x")).toThrow(/compatibility_date/);
    expect(() => readAppWranglerConfig('{"main":"src/a.js","compatibility_date":"2025-01-01","compatibility_flags":["a b"]}', "x")).toThrow(/flags/);
  });
});

describe("the commands", () => {
  const before = "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd";
  const fixed = "15d7d40565c8df381bfacecbf8a8333da0ab3dbb";

  it("deploys the original, then uploads the before and after versions under their aliases", () => {
    const commands = showcaseCommands({ app: "storefront", beforeCommit: before, after: { runId: "board-live-sf21", rev: 6, commit: fixed, alias: "after-sf21-r6" } });
    expect(commands).toEqual([
      { dir: "before", args: ["deploy", "--message", "showcase storefront: original aaaaaaaaaa"] },
      { dir: "before", args: ["versions", "upload", "--preview-alias", "before", "--message", "showcase storefront: original aaaaaaaaaa"], alias: "before" },
      {
        dir: "after",
        args: ["versions", "upload", "--preview-alias", "after-sf21-r6", "--message", "showcase storefront: board-live-sf21 r6 15d7d40565"],
        alias: "after-sf21-r6",
      },
    ]);
    expect(commands.map((c) => formatShowcaseCommand(c, { before: "/tmp/s/before", after: "/tmp/s/after" }))).toEqual([
      "(cd /tmp/s/before && wrangler deploy --message 'showcase storefront: original aaaaaaaaaa')",
      "(cd /tmp/s/before && wrangler versions upload --preview-alias before --message 'showcase storefront: original aaaaaaaaaa')",
      "(cd /tmp/s/after && wrangler versions upload --preview-alias after-sf21-r6 --message 'showcase storefront: board-live-sf21 r6 15d7d40565')",
    ]);
  });

  it("before-only has no after upload", () => {
    expect(showcaseCommands({ app: "storefront", beforeCommit: before }).map((c) => c.dir)).toEqual(["before", "before"]);
  });

  it("reads each alias URL from realistic wrangler versions upload output", () => {
    const output = (alias: string) =>
      [
        " ⛅️ wrangler 4.149.0",
        "Total Upload: 40.12 KiB / gzip: 9.80 KiB",
        "Uploaded switchyard-showcase-storefront (2.10 sec)",
        "Worker Version ID: 0d9c1f2e-1111-2222-3333-444455556666",
        "Version Preview URL: https://0d9c1f2e-switchyard-showcase-storefront.example.workers.dev",
        `Version Preview Alias URL: https://${alias}-switchyard-showcase-storefront.example.workers.dev`,
      ].join("\n");
    expect(parsePreviewAliasUrl(output("before"), "before")).toBe("https://before-switchyard-showcase-storefront.example.workers.dev");
    expect(parsePreviewAliasUrl(output("after-sf21-r6"), "after-sf21-r6")).toBe("https://after-sf21-r6-switchyard-showcase-storefront.example.workers.dev");
    expect(parsePreviewAliasUrl(output("before"), "after-sf21-r6")).toBeUndefined();
  });
});

describe("what the published replays prove", () => {
  it("reads the passing revision and the promotion", async () => {
    expect(showcaseRunFacts(await publishedReplay("board-live-sf21"))).toEqual({
      runId: "board-live-sf21",
      verdict: "verified",
      passing: { n: 6, commit: "6dfdb6d2245392b71a0f5b2a0a55638a4e5d2d03" },
      promoted: { rev: 6, commit: "15d7d40565c8df381bfacecbf8a8333da0ab3dbb" },
    });
    expect(showcaseRunFacts(await publishedReplay("board-live-l3"))).toMatchObject({ verdict: "verified", passing: { n: 5 }, promoted: { rev: 5, commit: "1298cc3fe8e4c8886323d70b6ef67d744acd4750" } });
    const reg3 = showcaseRunFacts(await publishedReplay("board-live-reg3"));
    expect(reg3).toMatchObject({ verdict: "verified", passing: { n: 3 } });
    expect(reg3.promoted).toBeUndefined();
    const sf7 = showcaseRunFacts(await publishedReplay("board-live-sf7"));
    expect(sf7.verdict).toBe("failed");
    expect(sf7.passing).toBeUndefined();
  });
});

/** A source repo like a promoted bundle's: baseline, an integrated (gated) commit, and the promotion commit with the same tree. */
async function sourceRepo(app = "demo"): Promise<{ dir: string; baseline: string; gated: string; promoted: string; other: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scf-showcase-src-"));
  await git("git", ["init", "-q", "--initial-branch=main", dir]);
  await writeFiles(dir, {
    "wrangler.jsonc": `{\n  "name": "switchyard-change-fabric-${app}",\n  "main": "src/index.js",\n  "compatibility_date": "2025-09-23",\n}\n`,
    "src/index.js": "export default { fetch() { return new Response('broken'); } };\n",
    ".wrangler/state/junk": "local dev state\n",
  });
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "baseline");
  const baseline = await sh(dir, "rev-parse", "HEAD");
  await writeFile(join(dir, "src/index.js"), "export default { fetch() { return new Response('fixed'); } };\n");
  await sh(dir, "commit", "-q", "-am", "integrated revision 1");
  const gated = await sh(dir, "rev-parse", "HEAD");
  // The promotion: a new commit on the baseline with the gated tree.
  await sh(dir, "checkout", "-q", "-b", "switchyard/board-live-x1", baseline);
  await sh(dir, "checkout", "-q", gated, "--", ".");
  await sh(dir, "commit", "-q", "-m", "Promote Change board-live-x1");
  const promoted = await sh(dir, "rev-parse", "HEAD");
  await writeFile(join(dir, "src/index.js"), "export default { fetch() { return new Response('something else'); } };\n");
  await sh(dir, "commit", "-q", "-am", "unrelated");
  const other = await sh(dir, "rev-parse", "HEAD");
  await sh(dir, "checkout", "-q", promoted);
  return { dir, baseline, gated, promoted, other };
}

function runReplay(gated: string, promoted?: { rev: number; commit: string }, verdict = "verified"): PreviewReplayFile {
  return {
    format: "switchyard-replay/v1",
    changeId: "board-live-x1",
    messages: [
      { type: "goal.posted", payload: { objective: "x" } },
      { type: "integrated.rev", payload: { n: 1, commit: gated, gate: "pass" } },
      ...(promoted !== undefined ? [{ type: "revision.promoted", payload: { rev: promoted.rev, commit: promoted.commit, gatedCommit: gated, branch: "switchyard/board-live-x1" } }] : []),
    ],
    snapshot: { integration: { verdict } },
  };
}

describe("the honesty check", () => {
  it("matches on the gated tree when the gated commit is in the source", async () => {
    const s = await sourceRepo();
    const match = await checkFixedMatchesRun(s.dir, s.promoted, showcaseRunFacts(runReplay(s.gated)));
    expect(match).toMatchObject({ rev: 1, via: "gated" });
  });

  it("refuses a fixed commit whose tree is not the gated tree", async () => {
    const s = await sourceRepo();
    await expect(checkFixedMatchesRun(s.dir, s.other, showcaseRunFacts(runReplay(s.gated, { rev: 1, commit: s.other })))).rejects.toThrow(/does not hold the tree the gate passed/);
    await expect(checkFixedMatchesRun(s.dir, s.baseline, showcaseRunFacts(runReplay(s.gated)))).rejects.toThrow(/does not hold the tree/);
  });

  it("matches the recorded promoted commit when the gated commit is absent", async () => {
    const s = await sourceRepo();
    const absent = "6dfdb6d2245392b71a0f5b2a0a55638a4e5d2d03";
    const match = await checkFixedMatchesRun(s.dir, s.promoted, showcaseRunFacts(runReplay(absent, { rev: 1, commit: s.promoted })));
    expect(match).toMatchObject({ rev: 1, via: "promoted" });
  });

  it("refuses when the gated commit is absent and the fixed commit is not the promoted one", async () => {
    const s = await sourceRepo();
    const absent = "6dfdb6d2245392b71a0f5b2a0a55638a4e5d2d03";
    await expect(checkFixedMatchesRun(s.dir, s.other, showcaseRunFacts(runReplay(absent, { rev: 1, commit: s.promoted })))).rejects.toThrow(/neither the gated commit/);
    await expect(checkFixedMatchesRun(s.dir, s.promoted, showcaseRunFacts(runReplay(absent, { rev: 2, commit: s.promoted })))).rejects.toThrow(/promotion of revision 2/);
  });

  it("refuses when nothing proves it (no gated commit in the source, no recorded promotion)", async () => {
    const s = await sourceRepo();
    await expect(checkFixedMatchesRun(s.dir, s.promoted, showcaseRunFacts(runReplay("6dfdb6d2245392b71a0f5b2a0a55638a4e5d2d03")))).rejects.toThrow(/cannot prove/);
  });

  it("refuses a run that did not pass", async () => {
    const s = await sourceRepo();
    await expect(checkFixedMatchesRun(s.dir, s.promoted, showcaseRunFacts(runReplay(s.gated, undefined, "failed")))).rejects.toThrow(/use --before-only/);
    const failing: PreviewReplayFile = { ...runReplay(s.gated), messages: [{ type: "integrated.rev", payload: { n: 1, commit: s.gated, gate: "fail" } }] };
    await expect(checkFixedMatchesRun(s.dir, s.promoted, showcaseRunFacts(failing))).rejects.toThrow(/no verified revision/);
  });
});

describe("the replay index record", () => {
  const index = () => ({
    format: "switchyard-replay/v1",
    runs: [
      { id: "board-live-sf21", title: "t", app: "storefront", outcome: "verified", description: "d", messages: 1 },
      { id: "board-live-sf7", title: "t", app: "storefront", outcome: "failed", description: "d", messages: 1 },
      { id: "board-live-l3", title: "t", app: "service-api", outcome: "verified", description: "d", messages: 1 },
    ],
  });
  const before = { url: "https://before-switchyard-showcase-storefront.example.workers.dev", commit: "a".repeat(40) };
  const after = { url: "https://after-sf21-r6-switchyard-showcase-storefront.example.workers.dev", commit: "b".repeat(40), run: "board-live-sf21", rev: 6 };

  it("sets before and after on the run, leaving the rest as it was", () => {
    const next = withShowcaseApps(index(), "storefront", ["board-live-sf21"], { before, after });
    expect(next.runs[0]).toEqual({ ...index().runs[0], apps: { before, after } });
    expect(next.runs.slice(1)).toEqual(index().runs.slice(1));
    expect(next.format).toBe("switchyard-replay/v1");
  });

  it("before-only refreshes before on several runs and keeps a proven after", () => {
    const first = withShowcaseApps(index(), "storefront", ["board-live-sf21"], { before, after });
    const fresh = { ...before, commit: "c".repeat(40) };
    const next = withShowcaseApps(first, "storefront", ["board-live-sf21", "board-live-sf7"], { before: fresh });
    expect(next.runs[0]!.apps).toEqual({ before: fresh, after });
    expect(next.runs[1]!.apps).toEqual({ before: fresh });
  });

  it("refuses an unknown run, another app's run, a bad URL, and an after on another run", () => {
    expect(() => withShowcaseApps(index(), "storefront", ["board-live-zz"], { before })).toThrow(/not in the replay index/);
    expect(() => withShowcaseApps(index(), "storefront", ["board-live-l3"], { before })).toThrow(/service-api/);
    expect(() => withShowcaseApps(index(), "storefront", ["board-live-sf21"], { before: { ...before, url: "http://x.workers.dev" } })).toThrow(/workers.dev/);
    expect(() => withShowcaseApps(index(), "storefront", ["board-live-sf21"], { before, after: { ...after, url: "https://u:p@x.workers.dev" } })).toThrow(/workers.dev/);
    expect(() => withShowcaseApps(index(), "storefront", ["board-live-sf7"], { before, after })).toThrow(/exactly the one run/);
    expect(() => withShowcaseApps({}, "storefront", [], { before })).toThrow(/no runs/);
  });

  it("isShowcaseUrl accepts only credential-free https workers.dev URLs", () => {
    expect(isShowcaseUrl("https://before-x.y.workers.dev")).toBe(true);
    expect(isShowcaseUrl("https://before-x.y.workers.dev.evil.com")).toBe(false);
    expect(isShowcaseUrl("https://u:p@before-x.y.workers.dev")).toBe(false);
    expect(isShowcaseUrl("javascript:alert(1)")).toBe(false);
  });
});

/** A fabric-like repo (examples/apps/demo at HEAD) plus a replays dir with one passing run. */
async function fabric(gated: string, promoted?: { rev: number; commit: string }): Promise<{ root: string; replays: string }> {
  const root = await mkdtemp(join(tmpdir(), "scf-showcase-fabric-"));
  await git("git", ["init", "-q", "--initial-branch=master", root]);
  await writeFiles(root, {
    "examples/apps/demo/wrangler.jsonc": '{\n  "name": "switchyard-change-fabric-demo",\n  "main": "src/index.js",\n  "compatibility_date": "2025-09-23",\n  "workers_dev": true\n}\n',
    "examples/apps/demo/src/index.js": "export default { fetch() { return new Response('broken'); } };\n",
    "README.md": "fabric\n",
  });
  await sh(root, "add", "-A");
  await sh(root, "commit", "-q", "-m", "fabric");
  const replays = join(root, "replays");
  await mkdir(replays);
  await writeFile(join(replays, "board-live-x1.json"), JSON.stringify(runReplay(gated, promoted)));
  await writeFile(
    join(replays, "index.json"),
    `${JSON.stringify({ format: "switchyard-replay/v1", runs: [{ id: "board-live-x1", title: "x1", app: "demo", outcome: "verified", description: "d", messages: 3 }] }, null, 2)}\n`,
  );
  return { root, replays };
}

/** A fake wrangler: records each call and what its directory held, prints realistic output. */
function fakeWrangler(fail?: string) {
  const calls: { args: readonly string[]; config: string; index: string; files: string[] }[] = [];
  const wrangler = async (args: readonly string[], cwd: string): Promise<string> => {
    calls.push({
      args,
      config: await readFile(join(cwd, "wrangler.jsonc"), "utf8"),
      index: await readFile(join(cwd, "src/index.js"), "utf8"),
      files: (await readdir(cwd)).sort(),
    });
    if (fail !== undefined && args.includes(fail)) throw new Error("Authentication error [code: 10000]");
    const alias = args[args.indexOf("--preview-alias") + 1];
    if (args[0] === "deploy") return "Uploaded switchyard-showcase-demo\nhttps://switchyard-showcase-demo.example.workers.dev\n";
    return `Worker Version ID: 1\nVersion Preview Alias URL: https://${alias}-switchyard-showcase-demo.example.workers.dev\n`;
  };
  return { calls, wrangler };
}

describe("runShowcaseApp (fake wrangler, temp repos)", () => {
  it("publishes the original and the fixed code from a bundle and records both links", async () => {
    const s = await sourceRepo();
    const bundle = join(await mkdtemp(join(tmpdir(), "scf-showcase-b-")), "demo--board-live-x1.bundle");
    await sh(s.dir, "bundle", "create", "-q", bundle, "HEAD", "switchyard/board-live-x1");
    // The gated commit is NOT in the bundle (as in a real promoted bundle): proof by the recorded promotion.
    const f = await fabric("6dfdb6d2245392b71a0f5b2a0a55638a4e5d2d03", { rev: 1, commit: s.promoted });
    const { calls, wrangler } = fakeWrangler();
    const lines: string[] = [];
    const result = await runShowcaseApp({ repoRoot: f.root, app: "demo", fixed: bundle, runs: ["board-live-x1"], beforeOnly: false, dryRun: false, replaysDir: f.replays, wrangler, log: (l) => lines.push(l) });

    expect(calls.map((c) => c.args.slice(0, 4))).toEqual([
      ["deploy", "--message", expect.stringContaining("original")],
      ["versions", "upload", "--preview-alias", "before"],
      ["versions", "upload", "--preview-alias", "after-x1-r1"],
    ]);
    expect(calls[0]!.index).toContain("broken");
    expect(calls[1]!.index).toContain("broken");
    expect(calls[2]!.index).toContain("'fixed'");
    for (const c of calls) {
      expect(c.files).not.toContain(".wrangler");
      expect(JSON.parse(c.config.split("\n").slice(1).join("\n"))).toEqual({
        name: "switchyard-showcase-demo",
        main: "src/index.js",
        compatibility_date: "2025-09-23",
        workers_dev: true,
        preview_urls: true,
      });
    }
    const beforeCommit = await sh(f.root, "rev-parse", "HEAD");
    expect(result.after).toEqual({ url: "https://after-x1-r1-switchyard-showcase-demo.example.workers.dev", commit: s.promoted, run: "board-live-x1", rev: 1 });
    const written = JSON.parse(await readFile(join(f.replays, "index.json"), "utf8"));
    expect(written.runs[0].apps).toEqual({
      before: { url: "https://before-switchyard-showcase-demo.example.workers.dev", commit: beforeCommit },
      after: result.after,
    });
    // The app's own config in the fabric repo is untouched.
    expect(await readFile(join(f.root, "examples/apps/demo/wrangler.jsonc"), "utf8")).not.toContain("preview_urls");
    expect(lines.join("\n")).toContain("the promoted commit the replay records for revision 1");
  });

  it("a dry run prints the exact commands and touches nothing", async () => {
    const s = await sourceRepo();
    const f = await fabric(s.gated);
    const indexBefore = await readFile(join(f.replays, "index.json"), "utf8");
    const { calls, wrangler } = fakeWrangler();
    const lines: string[] = [];
    await runShowcaseApp({ repoRoot: f.root, app: "demo", fixed: `${s.dir}@${s.promoted}`, runs: ["board-live-x1"], beforeOnly: false, dryRun: true, replaysDir: f.replays, wrangler, log: (l) => lines.push(l) });
    expect(calls).toEqual([]);
    expect(await readFile(join(f.replays, "index.json"), "utf8")).toBe(indexBefore);
    const text = lines.join("\n");
    expect(text).toContain("dry run: nothing is uploaded or written");
    expect(text).toMatch(/wrangler deploy --message/);
    expect(text).toMatch(/wrangler versions upload --preview-alias before --message/);
    expect(text).toMatch(/wrangler versions upload --preview-alias after-x1-r1 --message/);
    expect(text).toContain('"preview_urls": true');
    expect(text).toContain("its tree equals the gated commit");
  });

  it("refuses a mismatched fixed commit before any wrangler call, and writes nothing", async () => {
    const s = await sourceRepo();
    const f = await fabric(s.gated);
    const indexBefore = await readFile(join(f.replays, "index.json"), "utf8");
    const { calls, wrangler } = fakeWrangler();
    await expect(
      runShowcaseApp({ repoRoot: f.root, app: "demo", fixed: `${s.dir}@${s.other}`, runs: ["board-live-x1"], beforeOnly: false, dryRun: false, replaysDir: f.replays, wrangler, log: () => undefined }),
    ).rejects.toThrow(/does not hold the tree the gate passed/);
    expect(calls).toEqual([]);
    expect(await readFile(join(f.replays, "index.json"), "utf8")).toBe(indexBefore);
  });

  it("before-only publishes the original alone; a failed upload records nothing", async () => {
    const f = await fabric("6dfdb6d2245392b71a0f5b2a0a55638a4e5d2d03");
    const ok = fakeWrangler();
    const result = await runShowcaseApp({ repoRoot: f.root, app: "demo", runs: ["board-live-x1"], beforeOnly: true, dryRun: false, replaysDir: f.replays, wrangler: ok.wrangler, log: () => undefined });
    expect(ok.calls.map((c) => c.args[0])).toEqual(["deploy", "versions"]);
    expect(result.after).toBeUndefined();
    const written = JSON.parse(await readFile(join(f.replays, "index.json"), "utf8"));
    expect(Object.keys(written.runs[0].apps)).toEqual(["before"]);

    const f2 = await fabric("6dfdb6d2245392b71a0f5b2a0a55638a4e5d2d03");
    const indexBefore = await readFile(join(f2.replays, "index.json"), "utf8");
    const bad = fakeWrangler("before");
    await expect(
      runShowcaseApp({ repoRoot: f2.root, app: "demo", runs: ["board-live-x1"], beforeOnly: true, dryRun: false, replaysDir: f2.replays, wrangler: bad.wrangler, log: () => undefined }),
    ).rejects.toThrow(/nothing was recorded/);
    expect(await readFile(join(f2.replays, "index.json"), "utf8")).toBe(indexBefore);
  });

  it("refuses bad argument combinations", async () => {
    const f = await fabric("6dfdb6d2245392b71a0f5b2a0a55638a4e5d2d03");
    const { wrangler } = fakeWrangler();
    const base = { repoRoot: f.root, app: "demo", dryRun: true, replaysDir: f.replays, wrangler, log: () => undefined };
    await expect(runShowcaseApp({ ...base, runs: ["board-live-x1"], beforeOnly: false })).rejects.toThrow(/--fixed/);
    await expect(runShowcaseApp({ ...base, fixed: "x", runs: ["board-live-x1"], beforeOnly: true })).rejects.toThrow(/do not go together/);
    await expect(runShowcaseApp({ ...base, fixed: "x", runs: [], beforeOnly: false })).rejects.toThrow(/exactly one --run/);
    await expect(runShowcaseApp({ ...base, runs: ["../etc"], beforeOnly: true })).rejects.toThrow(/not a replay id/);
    await expect(runShowcaseApp({ ...base, app: "nope", runs: [], beforeOnly: true })).rejects.toThrow(/not in the repository's HEAD/);
    await expect(runShowcaseApp({ ...base, runs: ["board-live-zz"], beforeOnly: true })).rejects.toThrow(/not in the replay index/);
    await expect(runShowcaseApp({ ...base, fixed: join(f.root, "missing.bundle"), runs: ["board-live-x1"], beforeOnly: false })).rejects.toThrow(/does not exist/);
  });
});
