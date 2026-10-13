/** Evidence grades follow a message's type and sender, never its content. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { gradeOf } from "../src/evidence.ts";

const log = (JSON.parse(readFileSync(new URL("../public/replays/board-live-sf21.json", import.meta.url), "utf8")) as { messages: BoardMessage[] }).messages;
const first = (type: BoardMessage["type"]) => log.find((m) => m.type === type)!;

describe("evidence grades", () => {
  it("grades the engine's gate and promotion as checked, a human ruling as decided", () => {
    expect(gradeOf(first("integrated.rev"))).toBe("checked");
    expect(gradeOf(first("revision.promoted"))).toBe("checked");
    expect(gradeOf(first("item.completed"))).toBe("checked");
    expect(gradeOf(first("contract.accepted"))).toBe("decided");
    expect(gradeOf(first("fix.requested"))).toBe("recorded");
  });

  it("never grades an agent's word as checked", () => {
    for (const m of log.filter((x) => x.from !== "engine" && x.from !== "human")) {
      expect(gradeOf(m)).not.toBe("checked");
    }
    expect(gradeOf(first("done.proposed"))).toBe("claimed");
    expect(gradeOf({ ...first("integrated.rev"), from: "agent-1" } as BoardMessage)).toBe("claimed");
  });
});
