import { describe, expect, it } from "vitest";

import { boardAgentWorkspaceName, boardHelpForkWorkspaceName, toolsWorkspaceName } from "../src/index.ts";
import { ARTIFACT_REPO_NAME_MAX, boundedRepoName } from "../src/repo-name.ts";

describe("boundedRepoName", () => {
  it("leaves a name that fits unchanged (only sanitized, as before)", () => {
    expect(boundedRepoName("chg-1--board-agent-a")).toBe("chg-1--board-agent-a");
    expect(boundedRepoName("chg 1--board-a:b")).toBe("chg-1--board-a-b");
    const exact = "x".repeat(ARTIFACT_REPO_NAME_MAX);
    expect(boundedRepoName(exact)).toBe(exact);
    // The existing builders keep their exact short names.
    expect(boardAgentWorkspaceName("chg-1", "agent-a")).toBe("chg-1--board-agent-a");
    expect(toolsWorkspaceName("chg-1")).toBe("chg-1--tools");
    expect(boardHelpForkWorkspaceName("chg-1", "help-3")).toBe("chg-1--help-help-3");
  });

  it("bounds a long name to the limit and ends it with a stable hash", () => {
    const long = `${"change-".repeat(10)}--board-${"agent".repeat(8)}`;
    const name = boundedRepoName(long);
    expect(name.length).toBeLessThanOrEqual(ARTIFACT_REPO_NAME_MAX);
    expect(name).toMatch(/^change-change-.*-[0-9a-f]{8}$/);
    expect(name).not.toMatch(/--[0-9a-f]{8}$/);
    expect(boundedRepoName(long)).toBe(name); // deterministic
  });

  it("gives two long names that share a prefix different names", () => {
    const prefix = "c".repeat(70);
    const a = boundedRepoName(`${prefix}--board-agent-a`);
    const b = boundedRepoName(`${prefix}--board-agent-b`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(ARTIFACT_REPO_NAME_MAX);
    expect(b.length).toBeLessThanOrEqual(ARTIFACT_REPO_NAME_MAX);
    // The builders apply the bound too.
    const agentA = boardAgentWorkspaceName(prefix, "agent-a");
    const agentB = boardAgentWorkspaceName(prefix, "agent-b");
    expect(agentA).toBe(a);
    expect(agentA).not.toBe(agentB);
    expect(boardHelpForkWorkspaceName(prefix, "r1").length).toBeLessThanOrEqual(ARTIFACT_REPO_NAME_MAX);
    expect(toolsWorkspaceName(prefix).length).toBeLessThanOrEqual(ARTIFACT_REPO_NAME_MAX);
  });

  it("honors a custom limit and refuses one too small to hold the hash", () => {
    expect(boundedRepoName("abcdefghijklmnopqrstuvwxyz", 20)).toMatch(/^abcdefghijk-[0-9a-f]{8}$/);
    expect(() => boundedRepoName("abcdefghijklmnop", 5)).toThrow(/at least/);
  });
});
