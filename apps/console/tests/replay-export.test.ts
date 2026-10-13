/**
 * Offline tests for the replay exporter's pure half: path scrubbing, the
 * secret refusal, the snapshot allow list, Worker paging (fetch faked), and the
 * index upsert. No network, no file system.
 */
import { describe, expect, it } from "vitest";

import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import {
  buildReplayFile,
  describeReplay,
  fetchBoardLog,
  findLocalPaths,
  findSecrets,
  labelSimulated,
  parseDotEnv,
  recordedOutcome,
  ReplayRefused,
  scrubString,
  scrubValue,
  sensitiveEnvValues,
  SIMULATED_NOTE,
  slimSnapshot,
  upsertIndex,
} from "../scripts/replay-export.ts";

function msg(seq: number, type: string, payload: Record<string, unknown>, from = "engine"): BoardMessage {
  return { seq, at: `2026-10-10T00:00:${String(seq).padStart(2, "0")}.000Z`, from, type, payload } as unknown as BoardMessage;
}

const COMMIT = "142d9a1a945a9a344469c3d0ffc36446b485846c";

describe("scrubString", () => {
  it("turns a board worktree path into a <work> placeholder, keeping the repo-relative tail", () => {
    expect(scrubString("at TestContext (/tmp/scf-board-uPpoWU/worktrees/scf-integration-Nu35lv/gate/gate.test.mjs:94:12)")).toBe(
      "at TestContext (<work>/gate/gate.test.mjs:94:12)",
    );
    expect(scrubString("file:///tmp/scf-board-uPpoWU/worktrees/scf-integration-Nu35lv/gate/gate.test.mjs:94")).toBe(
      "file://<work>/gate/gate.test.mjs:94",
    );
    expect(scrubString("cwd /tmp/scf-board-9Nz2uq/worktrees/scf-integration-kFocHC\n\n")).toBe("cwd <work>\n\n");
    expect(scrubString("/var/folders/ab/cd12/T/scf-x/src/a.ts")).toBe("<work>/src/a.ts");
  });

  it("makes the repo root repo-relative and hides home directories", () => {
    const root = "/home/someone/code/fabric";
    expect(scrubString(`${root}/examples/apps/storefront/src/money.ts`, root)).toBe("examples/apps/storefront/src/money.ts");
    expect(scrubString(`ran in ${root}`, root)).toBe("ran in .");
    expect(scrubString("/home/someone/.npm/_logs/x.log")).toBe("<home>/.npm/_logs/x.log");
    expect(scrubString("/Users/someone/x")).toBe("<home>/x");
  });

  it("leaves URLs, relative paths, and prose alone", () => {
    for (const text of ["https://example.com/tmp/x", "src/tmp/file.ts", "see /tmp for scratch", "a/home/b", "money.ts(44,83): error"]) {
      expect(scrubString(text)).toBe(text);
    }
  });

  it("scrubs nested values and keys without mutating the input", () => {
    const input = { a: ["/tmp/scf-1/x"], b: { "/home/u/k": 1 }, n: 3 };
    const out = scrubValue(input);
    expect(out).toEqual({ a: ["<work>/x"], b: { "<home>/k": 1 }, n: 3 });
    expect(input.a[0]).toBe("/tmp/scf-1/x");
    expect(findLocalPaths(out)).toEqual([]);
    expect(findLocalPaths(input)).toEqual(["$.a[0]"]);
  });
});

describe("findSecrets", () => {
  it("allows commit ids, item ids, and prose about bearers", () => {
    const safe = {
      commit: COMMIT,
      item: "seam-agent-5-contract-1",
      prose: "set SWITCHYARD_API_TOKEN to require a bearer on every mutation",
      path: "src/resources/notifications.js",
      output: "AssertionError: expected 1072 to be 1073 // Object.is equality",
    };
    expect(findSecrets(safe)).toEqual([]);
  });

  it("flags bearer tokens, artifact tokens, long hex and base64 secrets, keys, and URL credentials", () => {
    const kinds = (text: string) => findSecrets({ text }).map((f) => f.kind);
    expect(kinds("Authorization: Bearer abc123def456ghi789jkl")).toContain("bearer token");
    expect(kinds("token art_v1_0123456789abcdef")).toContain("artifact token (art_v*)");
    expect(kinds("account 0123456789abcdef0123456789abcdef")).toContain("long hex secret");
    expect(kinds(`sha256 ${"ab".repeat(32)}`)).toContain("long hex secret");
    expect(kinds("x Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo")).toContain("long base64 secret");
    expect(kinds("sk-abcdefghijklmnopqrstuvwxyz012345")).toContain("provider key");
    expect(kinds("https://x:supersecret@example.com/repo.git")).toContain("credential in URL");
    expect(kinds("-----BEGIN RSA PRIVATE KEY-----")).toContain("private key");
  });

  it("reads a dotenv file's values for the check (quotes, comments, export prefixes)", () => {
    const env = parseDotEnv('# comment\nexport CF_API_TOKEN="quoted value 123"\nACCOUNT_ID=abcdef123456 # trailing\n\nBAD LINE\nSINGLE=\'x y z w v\'\n');
    expect(env).toEqual({ CF_API_TOKEN: "quoted value 123", ACCOUNT_ID: "abcdef123456", SINGLE: "x y z w v" });
    expect(findSecrets({ s: "id abcdef123456 leaked" }, env)).toEqual([{ at: "$.s", kind: "value of $ACCOUNT_ID" }]);
  });

  it("flags the value of any TOKEN/SECRET/KEY/ACCOUNT env var, reporting the name only", () => {
    const env = { CLOUDFLARE_API_TOKEN: "plain-words-token", CF_ACCOUNT_ID: "acct-1234", HOME: "/home/x", SHORT_KEY: "1", OTHER: "plain-words-token" };
    expect(sensitiveEnvValues(env).map((e) => e.name).sort()).toEqual(["CF_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    const findings = findSecrets({ messages: [{ payload: { note: "leaked plain-words-token here" } }] }, env);
    expect(findings).toEqual([{ at: "$.messages[0].payload.note", kind: "value of $CLOUDFLARE_API_TOKEN" }]);
    expect(JSON.stringify(findings)).not.toContain("plain-words-token");
  });
});

describe("buildReplayFile", () => {
  const messages = [
    msg(1, "goal.posted", { objective: "fix the widget" }, "human"),
    msg(2, "agent.joined", { role: "lead" }, "lead"),
    msg(3, "item.proposed", { item: "unit-a", objective: "a" }, "lead"),
    msg(4, "integrated.rev", {
      n: 1,
      commit: COMMIT,
      gate: "fail",
      failing: { output: "at (/tmp/scf-board-x/worktrees/scf-integration-y/gate/g.mjs:1:1)" },
      progress: { acceptance: { passed: 3, total: 5 } },
    }),
  ];

  it("scrubs, slims the snapshot to the allow list, and keeps the log otherwise intact", () => {
    const file = buildReplayFile({
      changeId: "board-live-x",
      messages,
      snapshot: { id: "board-live-x", status: "planning", integration: { verdict: "failed" }, deployment: { url: "https://app.someone.workers.dev" }, work: [] },
    });
    expect(file.format).toBe("switchyard-replay/v1");
    expect(file.snapshot).toEqual({ id: "board-live-x", status: "planning", integration: { verdict: "failed" } });
    expect(JSON.stringify(file)).toContain("<work>/gate/g.mjs:1:1");
    expect(file.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(recordedOutcome(file)).toBe("failed");
    expect(describeReplay(file)).toBe("1 agent(s), 1 item(s) proposed, 1 integrated revision(s); last revision 1: gate fail, acceptance 3/5; 4 board messages.");
  });

  it("marks a simulated run (scripted agents) in the file, and only when asked", () => {
    const live = buildReplayFile({ changeId: "board-live-x", messages });
    expect("simulated" in live).toBe(false);
    const sim = buildReplayFile({ changeId: "board-sim-x", messages }, { simulated: true });
    expect(sim.simulated).toBe(true);
    // The label sits before the log, so a reader of the raw file meets it first.
    expect(Object.keys(sim).slice(0, 3)).toEqual(["format", "changeId", "simulated"]);
  });

  it("refuses to build a file holding a secret, naming where", () => {
    const leaky = [...messages, msg(5, "push.announced", { item: "unit-a", note: "Bearer 0123456789abcdefXYZ" }, "agent-1")];
    let caught: unknown;
    try {
      buildReplayFile({ changeId: "board-live-x", messages: leaky, snapshot: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReplayRefused);
    expect((caught as ReplayRefused).findings[0]).toEqual({ at: "$.messages[4].payload.note", kind: "bearer token" });
    expect((caught as Error).message).not.toContain("0123456789abcdef");
  });

  it("refuses an env secret, an unsafe id, an empty log, and a gap in the log", () => {
    expect(() => buildReplayFile({ changeId: "x", messages, snapshot: null }, { env: { MY_SECRET: "fix the widget" } })).toThrow(/value of \$MY_SECRET/);
    expect(() => buildReplayFile({ changeId: "../etc/passwd", messages })).toThrow(/unsafe change id/);
    expect(() => buildReplayFile({ changeId: "x", messages: [] })).toThrow(/no messages/);
    expect(() => buildReplayFile({ changeId: "x", messages: [messages[0]!, messages[2]!] })).toThrow(/not contiguous/);
  });

  it("slimSnapshot keeps only allow-listed fields and passes null through", () => {
    expect(slimSnapshot(null)).toBeNull();
    expect(slimSnapshot({ objective: "o", costEvents: [1], recruitments: [{ gitUrl: "https://x" }] })).toEqual({ objective: "o" });
  });
});

describe("fetchBoardLog", () => {
  it("pages after the last seq until the Worker says there is no more", async () => {
    const all = Array.from({ length: 5 }, (_, i) => msg(i + 1, "agent.joined", {}, `agent-${i}`));
    const urls: string[] = [];
    const fake = async (url: string): Promise<Response> => {
      urls.push(url);
      const after = Number(new URL(url).searchParams.get("after"));
      const page = all.filter((m) => m.seq > after).slice(0, 2);
      return new Response(JSON.stringify({ messages: page, hasMore: after + 2 < all.length }), { status: 200 });
    };
    const log = await fetchBoardLog(fake, "http://w/", "c1");
    expect(log.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(urls[0]).toBe("http://w/changes/c1/board?after=0&limit=1000");
    expect(urls.at(-1)).toBe("http://w/changes/c1/board?after=4&limit=1000");
  });

  it("fails loudly on a missing board", async () => {
    await expect(fetchBoardLog(async () => new Response("{}", { status: 404 }), "http://w", "nope")).rejects.toThrow(/no board/);
  });
});

describe("upsertIndex", () => {
  it("adds a new run and replaces an existing one in place", () => {
    const entry = { id: "a", title: "A", app: "service-api", outcome: "verified" as const, description: "d", messages: 3 };
    const one = upsertIndex(null, entry);
    const two = upsertIndex(one, { ...entry, id: "b" });
    const replaced = upsertIndex(two, { ...entry, title: "A2" });
    expect(replaced.runs.map((r) => `${r.id}:${r.title}`)).toEqual(["a:A2", "b:A"]);
  });
});

describe("labelSimulated", () => {
  const entry = { id: "board-sim-x", title: "100 agents", app: "scale-project", outcome: "verified" as const, description: "d.", messages: 3 };

  it("labels a simulated entry's title, description, and flag, once", () => {
    const labelled = labelSimulated(entry, true);
    expect(labelled.title).toBe("SIMULATED: 100 agents");
    expect(labelled.description).toBe(`${SIMULATED_NOTE} d.`);
    expect(labelled.simulated).toBe(true);
    expect(labelSimulated(labelled, true)).toEqual(labelled);
  });

  it("leaves a live entry exactly as it was", () => {
    expect(labelSimulated(entry, false)).toBe(entry);
  });
});
