/**
 * A FAITHFUL, offline fixture for the live run-live integration path.
 *
 * The ladder's marker fakes (MarkerGateRunner) pass a single marker file
 * per-unit, so they could never reproduce the live divergence that produced the
 * false green: a WHOLE-APP gate run against ONE unit's bare repo fails (missing
 * files), while the same gate run against the COMPOSED integrated tree passes.
 * That is the exact live-vs-offline gap this fixture closes.
 *
 * This fixture is a REAL multi-file app with a REAL whole-app gate run as a REAL
 * child process (plain `node`, never `npm` or the network), so it is faithful to
 * the live `npm run gate` semantics (a whole-app typecheck plus a behavioral
 * assertion that imports the composed handler) while staying deterministic and
 * offline:
 *
 *   - `src/index.js` imports every resource and routes to it.
 *   - two resources (`a`, `b`) each own one file under `src/resources`.
 *   - the gate (`gate/run.mjs`, run as `node gate/run.mjs`) first does
 *     `node --check` over EVERY app source file (the typecheck step), then
 *     imports the composed app handler and asserts BOTH resources are fixed
 *     (an unauthenticated request is rejected and an authenticated one
 *     succeeds). A single resource file in isolation cannot satisfy it: the
 *     typecheck fails on the missing sibling files before any assertion, and
 *     the behavioral assertion needs every resource present and fixed.
 *
 * The planted gap: both resources skip the auth check, so an unauthenticated
 * request wrongly succeeds. The fix adds the auth check per resource. The gate
 * passes only when BOTH resources are fixed in one composed tree.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The two resource unit ids this fixture app is decomposed into. */
export const RESOURCE_UNITS = ["a", "b"] as const;

/** The repo-relative path of a resource unit's owned source file. */
export function resourcePath(unitId: string): string {
  return `src/resources/${unitId}.js`;
}

/** The gate argv: run the real whole-app gate as a plain node child process. */
export function gateCommand(): readonly string[] {
  return [process.execPath, "gate/run.mjs"];
}

/** The frozen shared auth contract (honored by resources, never rewritten). */
const AUTH_CONTRACT = `// FROZEN shared auth contract.
export const DEMO_TOKEN = "demo-token";
export function requireAuth(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : "";
  if (token !== DEMO_TOKEN) {
    return new Response(JSON.stringify({ error: "authentication required" }), { status: 401 });
  }
  return null;
}
`;

/** The app entry: imports every resource and routes to it (whole-app wiring). */
const INDEX = `import { handle as a } from "./resources/a.js";
import { handle as b } from "./resources/b.js";

const RESOURCES = { a, b };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((p) => p !== "");
    const handler = RESOURCES[parts[0]];
    if (!handler) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return handler(request);
  },
};
`;

/**
 * A resource module. The BUGGY variant skips the auth check (the planted gap:
 * an unauthenticated request wrongly succeeds). The FIXED variant calls the
 * frozen requireAuth first and short-circuits on its Response.
 */
function resourceModule(unitId: string, fixed: boolean): string {
  const authLine = fixed
    ? `  const denied = requireAuth(request);\n  if (denied) return denied;\n`
    : `  // FABRIC-FOLLOWUP: planted gap: this resource skips requireAuth.\n`;
  return `import { requireAuth } from "../contracts/auth.js";

export async function handle(request) {
${authLine}  return new Response(JSON.stringify({ resource: "${unitId}", ok: true }), { status: 200 });
}
`;
}

/**
 * The REAL whole-app gate, run as \`node gate/run.mjs\`. It mirrors the live gate:
 *   1. a typecheck step: \`node --check\` over EVERY app source file, so a tree
 *      missing a sibling file (a single unit's bare repo) fails here first;
 *   2. a behavioral step: import the composed app handler and assert EVERY
 *      resource rejects an unauthenticated request (401) and accepts an
 *      authenticated one (200). A partial fix fails.
 * Exit 0 only when the whole composed app is fixed; non-zero otherwise.
 */
const GATE_RUNNER = `import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const APP_FILES = [
  "src/index.js",
  "src/contracts/auth.js",
  "src/resources/a.js",
  "src/resources/b.js",
];

// 1. Whole-app typecheck: node --check over every file. A missing file (a single
// unit's bare repo) fails here, before any assertion, exactly as the live gate's
// typecheck step does.
for (const file of APP_FILES) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

// 2. Behavioral: import the composed handler and assert every resource is fixed.
const app = (await import("../src/index.js")).default;
const { DEMO_TOKEN } = await import("../src/contracts/auth.js");

async function invoke(path, init) {
  const request = new Request("http://app.local" + path, init);
  return app.fetch(request);
}

for (const name of ["a", "b"]) {
  const unauth = await invoke("/" + name, { method: "GET" });
  assert.equal(
    unauth.status,
    401,
    name + " must reject an unauthenticated request via requireAuth, got " + unauth.status,
  );
  const authed = await invoke("/" + name, {
    method: "GET",
    headers: { authorization: "Bearer " + DEMO_TOKEN },
  });
  assert.equal(authed.status, 200, name + " must succeed for an authenticated request");
}

console.log("gate passed: the whole app is fixed");
`;

/**
 * Seed the faithful app project directory: the frozen contract, the entry, both
 * resources (buggy by default), and the real gate runner. This is the baseline
 * the integration workspace is seeded from and the promotion target.
 */
export async function seedFaithfulApp(projectDir: string): Promise<void> {
  const files: Record<string, string> = {
    "src/contracts/auth.js": AUTH_CONTRACT,
    "src/index.js": INDEX,
    "src/resources/a.js": resourceModule("a", false),
    "src/resources/b.js": resourceModule("b", false),
    "gate/run.mjs": GATE_RUNNER,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(projectDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

/** The FIXED contents of a resource module (what a fixing agent should write). */
export function fixedResource(unitId: string): string {
  return resourceModule(unitId, true);
}

/** The still-BUGGY contents of a resource module (an agent that produced no fix). */
export function buggyResource(unitId: string): string {
  return resourceModule(unitId, false);
}
