#!/usr/bin/env node
// Prove the cityhall example app is solvable, offline.
//
// 1. Copy examples/apps/cityhall to a fresh temp directory (without its
//    node_modules; the app's installed node_modules is linked in, so run
//    `npm ci` in the app first, as `make cityhall-reference-check` does).
// 2. Run the app's gate on the planted baseline: it must FAIL.
// 3. Overlay examples/reference/cityhall/ (full-file replacements of the
//    fixed modules and contracts, plus the two developer tests with the
//    contract change accepted).
// 4. Run the gate again: it must PASS.
//
// Prints the acceptance counts for both runs and exits non-zero when either
// expectation does not hold. Nothing here touches the app directory itself.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "apps", "cityhall");
const referenceDir = join(here, "cityhall");

if (!existsSync(join(appDir, "node_modules"))) {
  console.error(`no node_modules in ${appDir}: run \`npm ci\` there first (make cityhall-reference-check does)`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "cityhall-reference-"));
const app = join(work, "cityhall");
cpSync(appDir, app, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|\.wrangler|\.deployments)([\\/]|$)/.test(src.slice(appDir.length)),
});
symlinkSync(join(appDir, "node_modules"), join(app, "node_modules"), "dir");

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function suiteCounts(configArgs, label) {
  const out = join(work, `${label}.json`);
  run(process.execPath, [join(app, "node_modules", "vitest", "vitest.mjs"), "run", ...configArgs, "--reporter=json", `--outputFile=${out}`]);
  if (!existsSync(out)) {
    return { passed: 0, total: 0 };
  }
  const report = JSON.parse(readFileSync(out, "utf8"));
  return { passed: report.numPassedTests, total: report.numTotalTests };
}

function gate(label) {
  const started = Date.now();
  const result = run("npm", ["run", "gate"]);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const typecheck = run("npm", ["run", "typecheck"]).status === 0;
  const developer = suiteCounts([], `${label}-developer`);
  const acceptance = suiteCounts(["--config", "gate/vitest.config.ts"], `${label}-acceptance`);
  const verdict = result.status === 0 ? "PASS" : "FAIL";
  console.log(
    `${label.padEnd(9)} gate ${verdict} in ${seconds}s | typecheck ${typecheck ? "ok" : "FAILED"} | developer suite ${developer.passed}/${developer.total} | acceptance ${acceptance.passed}/${acceptance.total}`,
  );
  return verdict;
}

let ok = true;
try {
  const baseline = gate("baseline");
  if (baseline !== "FAIL") {
    console.error("expected the planted baseline to FAIL its gate");
    ok = false;
  }
  cpSync(referenceDir, app, { recursive: true });
  const reference = gate("reference");
  if (reference !== "PASS") {
    console.error("expected the reference solution to PASS the gate");
    ok = false;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(ok ? "cityhall reference check: OK (baseline fails, reference passes)" : "cityhall reference check: FAILED");
process.exit(ok ? 0 : 1);
