/**
 * Shared fixtures for the board-tools end-to-end tests (board-tools.e2e.test.ts
 * and its themed siblings): a project whose plan repeats one change per module
 * and misses a shared module, the fake planner seed for it, and the human's
 * default contract answer (reject). No network, no model.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { BoardMessage } from "@switchyard-change/change-core";

import type { BoardSeed } from "../src/run-board.ts";

export const git = promisify(execFile);
export const GOAL = "Guard every exported function";

/** Three modules the plan covers, and one shared module it does not. */
export async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scf-tools-project-"));
  for (const [rel, body] of Object.entries({
    "package.json": '{"name":"p","type":"module","scripts":{}}\n',
    "src/a.js": "export function a(x) {\n  return x;\n}\n",
    "src/b.js": "export function b(x) {\n  return x;\n}\n",
    "src/c.js": "export function c(x) {\n  return x;\n}\n",
    "src/shared/util.js": "export function util(x) {\n  return x;\n}\n",
  })) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

/** A plan that repeats one change ("guard") per module, and misses the shared module. */
export const seed = async (): Promise<BoardSeed> => ({
  source: "planner",
  model: "fake-planner",
  items: ["a", "b", "c"].map((m) => ({
    item: `guard-${m}`,
    objective: `guard the exported functions of src/${m}.js`,
    acceptance: ["the gate passes"],
    scopeHint: [`src/${m}.js`],
  })),
});

export const reject = async () => "reject" as const;
export const of = <T extends BoardMessage["type"]>(log: readonly BoardMessage[], type: T): Extract<BoardMessage, { type: T }>[] =>
  log.filter((m): m is Extract<BoardMessage, { type: T }> => m.type === type);
