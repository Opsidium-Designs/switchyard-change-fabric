/**
 * A resolved lease-owner escalation is authoritative for its path on the real
 * Worker handler + ChangeState DO (offline): the stored lease plan, and so the
 * lease edges the console draws from the snapshot, name the human-chosen owner.
 * A decision that names no contender is rejected and the deterministic owner is
 * kept.
 */
import { describe, expect, it } from "vitest";

import { createHarness } from "./harness.ts";

const ID = "change-lease-owner";
const SHARED = "src/audit/events.ts";

/** `api` and `tests` both declare the shared path; `api` is declared first. */
function sharedSpec(): string {
  return [
    `id: ${ID}`,
    "objective: add audit logging",
    "baseline: main",
    "budget_usd: 5",
    "assurance: standard",
    "work:",
    "  - id: api",
    "    objective: add the endpoints and the shared events module",
    `    paths: [src/api/**, ${SHARED}]`,
    "  - id: tests",
    "    objective: add tests touching the shared events module",
    `    paths: [tests/audit/**, ${SHARED}]`,
    "",
  ].join("\n");
}

interface LeaseEdgeView {
  readonly path: string;
  readonly owner: string;
  readonly waiters: readonly string[];
}

async function raiseAndResolve(decision: string) {
  const h = createHarness();
  expect((await h.json("POST", "/changes", sharedSpec())).status).toBe(201);

  const before = await h.json<{ leaseEdges: LeaseEdgeView[] }>("GET", `/changes/${ID}`);
  expect(before.body.leaseEdges.find((e) => e.path === SHARED)?.owner).toBe("api");

  const raised = await h.json<{ escalation: { id: string } }>("POST", `/changes/${ID}/escalations`, {
    kind: "lease-owner",
    path: SHARED,
    question: "which agent owns the shared events module?",
    options: ["api", "tests"],
  });
  expect(raised.status).toBe(201);
  const resolved = await h.json(
    "POST",
    `/changes/${ID}/escalations/${encodeURIComponent(raised.body.escalation.id)}/resolve`,
    { decision },
  );
  expect(resolved.status).toBe(200);
  return h;
}

describe("Worker: lease-owner escalation resolution drives the stored lease plan", () => {
  it("a valid human decision makes the chosen unit the owner on the snapshot", async () => {
    const h = await raiseAndResolve("tests");
    const after = await h.json<{ leaseEdges: LeaseEdgeView[] }>("GET", `/changes/${ID}`);
    const edge = after.body.leaseEdges.find((e) => e.path === SHARED);
    expect(edge?.owner).toBe("tests");
    expect(edge?.waiters).toEqual(["api"]);
  });

  it("an invalid decision keeps the deterministic owner", async () => {
    const h = await raiseAndResolve("nobody");
    const after = await h.json<{ leaseEdges: LeaseEdgeView[] }>("GET", `/changes/${ID}`);
    const edge = after.body.leaseEdges.find((e) => e.path === SHARED);
    expect(edge?.owner).toBe("api");
    expect(edge?.waiters).toEqual(["tests"]);
  });
});
