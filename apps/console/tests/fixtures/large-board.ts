/**
 * A synthetic LARGE board log for the console's scale tests and local
 * screenshots (never shipped in the replay index): a lead, four sub-leads that
 * split their domain items, 30 (or 100) workers, about 38 items over eight
 * city-services domains, two seam items from accepted seam contracts, claims,
 * two claim contests, pushes, five integrated revisions with rising acceptance
 * counts, fix requests, a protected-test contract a human accepts, and the
 * promotion of the passing revision.
 *
 * Every message goes through the PURE board API (the same append functions the
 * Worker and the local control call, via the orchestration fixture board), so
 * the board itself accepted each one and the real fold and buildBoardGraph
 * read it. Deterministic: no clock, no randomness.
 */
import type { BoardMessage } from "@switchyard-change/orchestration/board-graph";

import { FixtureBoard } from "../../../../packages/orchestration/tests/board-graph-fixture.ts";

/** The eight domains, each with its sub-items (the first four are split by sub-leads). */
const DOMAINS: readonly { readonly domain: string; readonly parts: readonly string[] }[] = [
  { domain: "permits", parts: ["apply-form", "fee-calc", "status-page", "inspector-queue"] },
  { domain: "utilities", parts: ["meter-read", "billing-cycle", "outage-map", "autopay"] },
  { domain: "records", parts: ["request-intake", "redaction", "fee-waiver", "audit-log"] },
  { domain: "housing", parts: ["waitlist", "voucher-check", "unit-search", "landlord-portal"] },
  { domain: "parking", parts: ["meter-rates", "citation-appeal", "permit-zones", "garage-status"] },
  { domain: "licensing", parts: ["business-renewal", "pet-license", "vendor-permit", "contractor-check"] },
  { domain: "transit", parts: ["fare-calc", "route-alerts", "reduced-fare", "stop-search"] },
  { domain: "parks", parts: ["shelter-booking", "field-permits", "program-signup", "trail-status"] },
];

/** How many domains a sub-lead splits (the rest are flat items). */
const SPLIT_DOMAINS = 4;
/** The shared seams (declared on the goal); a worker's contract on each becomes a seam item. */
const SEAMS = [
  { contract: "address", path: "src/shared/address.ts", why: "every domain normalizes addresses differently" },
  { contract: "fees", path: "src/shared/fees.ts", why: "fees round three different ways" },
] as const;
/** The flat item whose protected test a human lets it change. */
const FEE_ITEM = "parking-meter-rates";
const PROTECTED_TEST = "tests/parking/meter-rates.test.ts";
const ACCEPTANCE_TOTAL = 160;
/** Acceptance passing on revisions 1..5 (the fifth passes the gate). */
const ACCEPTANCE_CLIMB = [40, 88, 121, 150, 160] as const;

export interface LargeBoardOptions {
  /** Worker agents besides the lead (the first four become sub-leads). Default 30. */
  readonly workers?: number;
}

/** A deterministic 40-hex commit id. */
function commitOf(n: number): string {
  const head = ((n * 2654435761) >>> 0).toString(16).padStart(8, "0");
  return `${head}${n.toString(16).padStart(32, "0")}`;
}

/** The synthetic large board log (30 workers by default; pass `workers: 100` for the big variant). */
export function largeBoardLog(options: LargeBoardOptions = {}): BoardMessage[] {
  const workerCount = Math.max(SPLIT_DOMAINS + 4, options.workers ?? 30);
  const b = new FixtureBoard();
  let commits = 0;
  const nextCommit = (): string => commitOf((commits += 1));

  b.human({
    type: "goal.posted",
    payload: {
      objective: "Make the city services portal correct: every fee exact to the cent, every form validated, every private record behind auth",
      rules: { maxContestTurns: 2, contestIdleMessages: 25, maxFixAttempts: 4 },
      protected: [PROTECTED_TEST],
      seams: SEAMS.map((s) => ({ path: s.path, importers: ["src/shared/index.ts"] })),
      testInventory: { status: "recorded", format: "node-test", count: ACCEPTANCE_TOTAL },
    },
  });
  b.join("lead", "lead", "reads the goal and seeds the plan");

  // The lead proposes the four split domains as one item each, and every other domain's parts.
  const flat: string[] = [];
  DOMAINS.forEach(({ domain, parts }, i) => {
    if (i < SPLIT_DOMAINS) {
      b.agent("lead", {
        type: "item.proposed",
        payload: { item: domain, objective: `make ${domain} correct end to end`, acceptance: [`the ${domain} acceptance suite passes`], scopeHint: [`src/${domain}/**`] },
        rationale: `${domain} is wide: a sub-lead should split it`,
      });
      return;
    }
    for (const part of parts) {
      const item = `${domain}-${part}`;
      flat.push(item);
      b.agent("lead", {
        type: "item.proposed",
        payload: { item, objective: `fix ${domain} ${part.replace(/-/g, " ")}`, acceptance: [`${item} passes its acceptance tests`], scopeHint: [`src/${domain}/${part}.ts`, `src/${domain}/common.ts`, ...(item === FEE_ITEM ? [PROTECTED_TEST] : [])] },
        rationale: `one item per ${domain} concern`,
      });
    }
  });

  const workers = Array.from({ length: workerCount }, (_, i) => `agent-${i + 1}`);
  for (const agent of workers) b.join(agent, "worker");

  // Sub-leads: each claims a wide domain and splits it into its parts.
  const subLeads = workers.slice(0, SPLIT_DOMAINS);
  const children = new Map<string, string[]>();
  DOMAINS.slice(0, SPLIT_DOMAINS).forEach(({ domain, parts }, i) => {
    const lead = subLeads[i]!;
    b.agent(lead, { type: "item.claimed", payload: { item: domain, intent: { read: ["src/shared/**"], write: [`src/${domain}/**`] } }, rationale: `taking ${domain} as its sub-lead` });
    const kids = parts.map((part) => `${domain}.${part}`);
    children.set(domain, kids);
    b.agent(lead, {
      type: "item.split",
      payload: { item: domain, children: parts.map((part) => ({ item: `${domain}.${part}`, objective: `${domain}: ${part.replace(/-/g, " ")}`, scopeHint: [`src/${domain}/${part}.ts`] })) },
      rationale: `four parts that do not share files`,
    });
  });

  // The workable items in claim order: split children, then the flat items.
  const workable = [...[...children.values()].flat(), ...flat];
  const pathOf = (item: string): string => {
    const seam = SEAMS.find((s) => item === `seam-${s.contract}`);
    if (seam !== undefined) return seam.path;
    const dot = item.indexOf(".");
    if (dot >= 0) return `src/${item.slice(0, dot)}/${item.slice(dot + 1)}.ts`;
    const dash = item.indexOf("-");
    return `src/${item.slice(0, dash)}/${item.slice(dash + 1)}.ts`;
  };
  const owner = new Map<string, string>();
  const pool = workers.slice(SPLIT_DOMAINS);
  // Two pairs share their domain's common file: the holder writes it, the claimant then contests it.
  const CONTESTS = [
    { item: "transit-reduced-fare", holder: "transit-fare-calc", keep: false },
    { item: "parks-trail-status", holder: "parks-shelter-booking", keep: true },
  ] as const;
  const contested = new Set<string>(CONTESTS.map((c) => c.item));
  const holderOf = new Set<string>(CONTESTS.map((c) => c.holder));
  const commonOf = (item: string): string => `src/${item.slice(0, item.indexOf("-"))}/common.ts`;
  // The contest holders claim first, so both contests happen with 30 workers too.
  const claimList = [...holderOf, ...workable.filter((item) => !contested.has(item) && !holderOf.has(item))];
  const free: string[] = [];
  pool.forEach((agent, i) => {
    const item = claimList[i];
    if (item === undefined) {
      free.push(agent);
      return;
    }
    owner.set(item, agent);
    const write = holderOf.has(item) ? [pathOf(item), commonOf(item)] : [pathOf(item)];
    b.agent(agent, { type: "item.claimed", payload: { item, intent: { read: ["src/shared/**"], write } }, ...(i % 5 === 0 ? { rationale: `starting on ${item}` } : {}) });
  });

  // Two contests over a domain's common file: one is ceded, one is kept by both and escalates to a human.
  CONTESTS.forEach(({ item, holder, keep }, i) => {
    const holderAgent = owner.get(holder);
    const claimant = free[i] ?? pool[pool.length - 1 - i]!;
    if (holderAgent === undefined || claimant === holderAgent) return;
    b.agent(claimant, {
      type: "item.claimed",
      payload: { item, intent: { read: [], write: [pathOf(item), commonOf(item)] } },
      rationale: `${item} needs ${commonOf(item)} too`,
    });
    const contest = String(b.state.items[item]?.claimant?.contest ?? "");
    if (contest === "") throw new Error(`no contest on ${item}`);
    if (!keep) {
      b.agent(claimant, { type: "claim.ceded", payload: { contest }, rationale: "I will wait for the push" });
      return;
    }
    b.agent(holderAgent, { type: "claim.kept", payload: { contest }, rationale: "mid-edit on the common file" });
    b.agent(claimant, { type: "claim.kept", payload: { contest }, rationale: "cannot ship without it" });
  });

  // Two seam contracts on shared helpers: the lead accepts both and they become seam items.
  const seams: string[] = [];
  SEAMS.forEach(({ contract, path, why }, n) => {
    const proposer = pool[n + 1]!;
    const needs = [...owner.entries()].find(([, agent]) => agent === proposer)![0];
    b.agent(proposer, { type: "contract.proposed", payload: { contract, target: path, kind: "modify", item: needs, description: why }, rationale: why });
    b.agent("lead", { type: "contract.accepted", payload: { contract }, rationale: "one shared helper for everyone" });
    const seam = Object.values(b.state.items).find((it) => it.fromContract === contract)?.id;
    if (seam === undefined) throw new Error(`the accepted seam contract ${contract} made no seam item`);
    seams.push(seam);
  });

  // A protected test change for the fee calculator, decided by a human.
  const feeOwner = owner.get(FEE_ITEM);
  if (feeOwner !== undefined) {
    b.agent(feeOwner, {
      type: "contract.proposed",
      payload: { contract: "fees-test", target: PROTECTED_TEST, kind: "modify", item: FEE_ITEM, description: "the test pins a truncated fee" },
      rationale: "the old test truncates the fee instead of rounding it",
    });
    b.human({ type: "contract.accepted", payload: { contract: "fees-test" } });
  }

  // Five integration rounds. Each round the owners push; the sub-leads merge their children.
  const latest = new Map<string, string>();
  const pushItem = (item: string, agent: string): void => {
    const commit = nextCommit();
    b.agent(agent, { type: "push.announced", payload: { item, commit, paths: [pathOf(item)] }, rationale: `pushed ${item}` });
    latest.set(item, commit);
  };
  const doneProposed = new Set<string>();
  /** Child pushes a sub-lead already merged (a child's push is merged once). */
  const mergedChild = new Set<string>();
  const holders = (): [string, string][] =>
    [...owner.entries()].filter(([item]) => b.state.items[item]?.owner === owner.get(item));
  for (let round = 0; round < ACCEPTANCE_CLIMB.length; round += 1) {
    const last = round === ACCEPTANCE_CLIMB.length - 1;
    // Who pushes this round: everyone on round 1, then the items the last failure implicated.
    const lastRev = round === 0 ? undefined : b.log.filter((m) => m.type === "integrated.rev").at(-1);
    const implicated = new Set<string>(
      lastRev?.type === "integrated.rev" ? (lastRev.payload.failing?.items ?? []) : [],
    );
    // Before the third revision, a human settles the escalated contest for its owner.
    if (round === 2) {
      for (const contest of Object.values(b.state.contests)) {
        if (contest.status === "escalated") {
          b.human({ type: "claim.resolved", payload: { contest: contest.id, how: "human-decided", winner: contest.owner } });
        }
      }
    }
    // After the first revision, agents take the items still open (a second claim each when everyone is busy).
    if (round === 1) {
      workable
        .filter((item) => b.state.items[item]?.status === "open")
        .forEach((item, i) => {
          const agent = free[3 + i] ?? pool[(i * 7) % pool.length]!;
          b.agent(agent, { type: "item.claimed", payload: { item, intent: { read: [], write: [pathOf(item)] } }, rationale: `${item} is still open` });
          owner.set(item, agent);
        });
    }
    for (const [item, agent] of holders()) {
      if (!latest.has(item) || implicated.has(item) || last) {
        if (round > 0 && !last && round % 2 === 1) {
          b.agent(agent, {
            type: "item.struggling",
            payload: { item, turnsSpent: round + 1, failedEdits: 0, reason: "failing-revision", lastFailure: `${item}: expected 400, got 201` },
          });
        }
        pushItem(item, agent);
      }
    }
    // Idle agents volunteer on the struggling items; the owners decline (they have pushed a fix).
    const struggling = holders().filter(([item]) => b.state.items[item]?.struggling !== undefined);
    if (struggling.length > 0) {
      free.slice(4).forEach((volunteer, i) => {
        const [item, holder] = struggling[(i + round) % struggling.length]!;
        b.agent(volunteer, { type: "help.volunteered", payload: { item }, to: [holder], rationale: "idle: I can take a part" });
        b.agent(holder, { type: "help.declined", payload: { item, volunteer }, to: [volunteer], rationale: "the fix is already pushed" });
      });
    }
    // Seam items: the engine granted each to its proposer; they push on the first round.
    if (round === 0) {
      seams.forEach((seam, i) => {
        const path = SEAMS[i]!.path;
        let agent = b.state.items[seam]?.owner;
        if (agent === undefined && b.state.items[seam]?.status === "open") {
          agent = free[2 + i] ?? pool[pool.length - 1 - i]!;
          b.agent(agent, { type: "item.claimed", payload: { item: seam, intent: { read: [], write: [path] } } });
        }
        if (agent === undefined) return;
        owner.set(seam, agent);
        const commit = nextCommit();
        b.agent(agent, { type: "push.announced", payload: { item: seam, commit, paths: [path] }, rationale: "the shared seam first" });
        latest.set(seam, commit);
      });
    }
    // Sub-leads merge their children's latest pushes into one push for the split item.
    const subLeadPushes: string[] = [];
    DOMAINS.slice(0, SPLIT_DOMAINS).forEach(({ domain }, i) => {
      const kids = (children.get(domain) ?? []).filter((kid) => latest.has(kid) && !mergedChild.has(latest.get(kid)!));
      kids.forEach((kid) => mergedChild.add(latest.get(kid)!));
      if (kids.length === 0) return;
      const commit = nextCommit();
      b.agent(subLeads[i]!, {
        type: "push.announced",
        payload: { item: domain, commit, paths: kids.map(pathOf), merges: kids.map((kid) => ({ item: kid, commit: latest.get(kid)! })) },
        rationale: `merged ${kids.length} part(s) of ${domain}`,
      });
      latest.set(domain, commit);
      subLeadPushes.push(domain);
    });
    if (last) {
      for (const [item, agent] of holders()) {
        if (!doneProposed.has(item)) {
          b.agent(agent, { type: "done.proposed", payload: { item } });
          doneProposed.add(item);
        }
      }
    }
    // The merged set: every flat item's and seam's latest push, and each sub-lead's latest push.
    const merged = [
      ...[...latest.entries()].filter(([item]) => !item.includes(".")).map(([, commit]) => commit),
    ];
    const passed = ACCEPTANCE_CLIMB[round]!;
    const failingItems = last ? [] : holders().map(([item]) => item).filter((item) => !item.includes(".")).filter((_, i) => i % (round + 2) === 0);
    b.rev({
      commit: nextCommit(),
      gate: last ? "pass" : "fail",
      merged,
      ...(last ? {} : { failing: { output: `not ok - ${failingItems.length} item(s) still fail acceptance`, items: failingItems } }),
      progress: {
        passed: passed + 12,
        failed: ACCEPTANCE_TOTAL - passed,
        total: ACCEPTANCE_TOTAL + 12,
        suites: [
          { passed: 12, failed: 0, total: 12, suite: "developer" },
          { passed, failed: ACCEPTANCE_TOTAL - passed, total: ACCEPTANCE_TOTAL, suite: "acceptance" },
        ],
        acceptance: { passed, failed: ACCEPTANCE_TOTAL - passed, total: ACCEPTANCE_TOTAL },
      },
    });
  }
  const passing = b.log.filter((m) => m.type === "integrated.rev").at(-1);
  if (passing?.type === "integrated.rev") {
    b.record("revision.promoted", { rev: passing.payload.n, gatedCommit: passing.payload.commit, commit: nextCommit(), branch: "switchyard/city-portal" });
  }
  for (const agent of [...workers, "lead"]) {
    b.agent(agent, { type: "agent.left", payload: {}, rationale: "the run is over" });
  }
  return b.log;
}
