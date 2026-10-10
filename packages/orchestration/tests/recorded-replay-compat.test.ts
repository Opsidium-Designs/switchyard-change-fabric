/**
 * Recorded logs replay exactly as they were recorded: the three published
 * live runs (apps/console/public/replays) and the K = 1 golden demo log were
 * recorded before the arbitration revision rule existed, so their goals carry
 * no `rules.arbitration` and the engine must reduce them (and fold them at
 * every seq) to exactly the states the reducer at e84d3ef produced. The
 * hashes below were captured from that reducer: sha256 of the canonical JSON
 * (sorted keys, undefined dropped) of reduceBoard(log), and of every
 * foldBoard(log, k) for k = 0..length, in order. A change that alters how an
 * old log reduces fails here; new behavior belongs behind a goal rule.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { foldBoard, reduceBoard, type BoardMessage } from "@switchyard-change/change-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

const RECORDED: readonly { readonly path: string; readonly messages: number; readonly reduced: string; readonly folded: string }[] = [
  {
    path: "apps/console/public/replays/board-live-reg3.json",
    messages: 89,
    reduced: "f94155e00b32fe571f3a6c5b27f504b2dcdd037451b0967325e73f76c0224812",
    folded: "287d918496052735f2139ef3b473017a467c911eb45ca3e8987e6005537548d4",
  },
  {
    path: "apps/console/public/replays/board-live-sf7.json",
    messages: 152,
    reduced: "55dff8e5803929a0fd59fa366640bee3f9610f38b4f1c99f370a81ffcfc46ce2",
    folded: "02dbe78c93e75b7d91335696d79d852dd84a64e19f9b8312c25845dd816e3a66",
  },
  {
    path: "apps/console/public/replays/board-live-sf8.json",
    messages: 178,
    reduced: "d8ae14cf69c5b12baaca022f122406f6ec382d2bf902e793858b827e89ac8f40",
    folded: "0fa21e55c9b18f054bca7252088b72b5f5ca1f9a8e4d819554ec870d4fea78f7",
  },
  {
    path: "packages/orchestration/tests/fixtures/board-audit-speculate1.log.json",
    messages: 79,
    reduced: "d59fc0fdefd6e24fdd76cfe9e220811197cc8f3e4d12bfb3c43355c122180f65",
    folded: "26c01b845807fff508be96d7dc6ed67dfbd7306d7e12bd5a7eca9f34b3a4cc65",
  },
];

/** Canonical JSON: sorted keys, undefined dropped (key order never matters to the board). */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canon);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = canon(v);
      }
    }
    return out;
  }
  return value;
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");

function load(path: string): BoardMessage[] {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as BoardMessage[] | { messages: BoardMessage[] };
  return Array.isArray(raw) ? raw : raw.messages;
}

describe("recorded logs replay exactly as recorded (arbitration revision 1)", () => {
  for (const recorded of RECORDED) {
    it(`${recorded.path}: reduceBoard and every foldBoard prefix are unchanged`, () => {
      const log = load(recorded.path);
      expect(log).toHaveLength(recorded.messages);
      const goal = log.find((m) => m.type === "goal.posted");
      expect(goal?.type === "goal.posted" ? goal.payload.rules.arbitration : "no goal").toBeUndefined();
      const state = reduceBoard(log);
      expect(sha256(state)).toBe(recorded.reduced);
      const chain = createHash("sha256");
      for (let k = 0; k <= log.length; k += 1) {
        chain.update(JSON.stringify(canon(foldBoard(log, k))));
      }
      expect(chain.digest("hex")).toBe(recorded.folded);
      expect(foldBoard(log)).toEqual(state);
    });
  }
});
