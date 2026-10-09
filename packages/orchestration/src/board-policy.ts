/**
 * board-policy: a deterministic, goal-agnostic stand-in for the model behind an
 * agent turn. It is the fake turn transport offline runs and tests use, so a
 * board run is reproducible with no network.
 *
 * The policy reads only what a live model reads (the agent's digest, its own
 * past decisions, the public board facts, and the repo listing) and applies
 * generic rules, in priority order:
 *   1. the lead decides pending contracts (accept unless the target overlaps a
 *      write intent held by someone other than the proposer), then workers'
 *      proposed items (accept unless the proposal duplicates an existing
 *      item's scope or objective, see `duplicateOf`), else waits;
 *   2. answer an open contest: as the claimant, narrow the overlapping part of
 *      the write intent to the concrete files nobody else holds (cede when
 *      nothing is left); as the owner, keep once;
 *   3. reply to a help request or question addressed to the agent;
 *   4. after narrowing in a contest, ask the other party (a `to`-addressed
 *      question) about the scope they now share a boundary on;
 *   5. fix a held item a failing revision asked it to fix (an edit carrying the
 *      revision), edit a held item that has no push yet, then propose it done;
 *   6. while free, claim the first open item it has not been refused, with the
 *      item's scope hint as the write intent; a claim refused because it
 *      touches the contract (existing tests, gate config) proposes a contract
 *      change per protected entry, waits for the decision, and claims again;
 *   7. otherwise wait.
 * Tools (agents build tools for each other), woven into the rules above:
 *   - the lead seeds tools itself when the structural rule fires (see
 *     BoardAgent's seed turn); otherwise, when free and the planned items
 *     share a repeated mechanical change (`detectBoardToolNeed`), a worker
 *     proposes a scanner and, as another agent, a codemod; one tool per agent;
 *   - claim your own accepted tool item, or a lead-seeded one, first, and
 *     build it (a rebuild after a failed gate, bounded);
 *   - on a held item with no push yet: run a published scanner over its files,
 *     then a published codemod on the files the scanner flagged (fall back to
 *     an edit when it changed nothing); with no published tool, edit by hand
 *     at once: tools are accelerators, never prerequisites (no waiting);
 *   - as a scanner's builder, turn findings no outstanding item covers into
 *     one proposal citing the tool (the lead decides it); run the scanner over
 *     the whole repo right after publishing, then again over each new passing
 *     revision (a sweep, bounded);
 *   - as the lead, accept a tool proposal, and accept a proposal from a
 *     tool's findings unless an outstanding item already covers its files.
 * No rule names a file, an app, or a goal: the same policy runs unchanged on any
 * repo.
 */

import {
  detectBoardToolNeed,
  entriesOverlap,
  entryWithin,
  hasWildcard,
  intentPath,
  overlappingEntries,
  type BoardDigest,
  type BoardMessage,
} from "@switchyard-change/change-core";
import type {
  AgentAction,
  AgentTurnInput,
  AgentTurnOutcome,
  AgentTurnTransport,
} from "@switchyard-change/model-adapters";
import { matchesGlob } from "@switchyard-change/verification";

type Input = AgentTurnInput<BoardDigest, BoardMessage>;

/** The write intent the agent asked for in its latest claim of `item`. */
function claimedWrite(input: Input, item: string): readonly string[] | undefined {
  for (let i = input.capsule.decisions.length - 1; i >= 0; i -= 1) {
    const action = input.capsule.decisions[i]!.action;
    if (action.type === "claim" && action.itemId === item) {
      return action.intent.write;
    }
  }
  return undefined;
}

/**
 * Narrow a write intent away from an overlap: entries that do not overlap are
 * kept; an overlapping glob is replaced by the concrete files it names that no
 * other agent's live claim covers. Every result stays within the original.
 */
function narrowed(input: Input, write: readonly string[], overlap: readonly string[]): string[] {
  const others = input.board.liveClaims.filter((c) => c.owner !== input.agent).flatMap((c) => c.write);
  const out: string[] = [];
  for (const entry of write) {
    if (!overlap.includes(entry)) {
      out.push(entry);
      continue;
    }
    const path = intentPath(entry);
    if (!hasWildcard(path)) {
      continue;
    }
    for (const file of input.repo.files) {
      if (matchesGlob(file, path) && !others.some((o) => entriesOverlap(file, o)) && !out.includes(file)) {
        out.push(file);
      }
    }
  }
  return out;
}

/** Lower-case word tokens of at least 3 characters (a goal-agnostic bag of words). */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
}

/** Jaccard similarity of two word sets. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const w of a) {
    if (b.has(w)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

/** Objectives at least this similar (word Jaccard) duplicate each other. */
export const DUPLICATE_OBJECTIVE_SIMILARITY = 0.6;

/**
 * Why a proposal should be rejected, if it should. Generic rules: a proposal
 * with no scope can never be claimed; one whose every scope entry overlaps a
 * single existing item's scope duplicates that item's scope; one whose
 * objective is nearly the same words as an existing item's duplicates its
 * objective. `item` names the duplicated item (absent for the no-scope case).
 */
export function duplicateOf(
  proposal: { readonly objective: string; readonly scopeHint: readonly string[] },
  items: readonly { readonly item: string; readonly objective: string; readonly scopeHint: readonly string[] }[],
): { readonly item?: string; readonly why: string } | undefined {
  if (proposal.scopeHint.length === 0) {
    return { why: "it declares no scope, so it could never be claimed" };
  }
  for (const existing of items) {
    if (existing.scopeHint.length > 0 && proposal.scopeHint.every((p) => existing.scopeHint.some((e) => entriesOverlap(p, e)))) {
      return { item: existing.item, why: `its scope (${proposal.scopeHint.join(", ")}) is already inside that item's scope` };
    }
  }
  const mine = words(proposal.objective);
  for (const existing of items) {
    if (similarity(mine, words(existing.objective)) >= DUPLICATE_OBJECTIVE_SIMILARITY) {
      return { item: existing.item, why: "its objective restates that item's objective" };
    }
  }
  return undefined;
}

type BoardTools = NonNullable<Input["board"]["tools"]>;
type BoardToolFact = BoardTools[number];

/** The latest published version of a tool, if any. */
function latest(tool: BoardToolFact): BoardToolFact["versions"][number] | undefined {
  return tool.versions.at(-1);
}

/** True when a tool's declared inputs cover `file` (no inputs: the whole repo). */
function toolCovers(tool: BoardToolFact, file: string): boolean {
  return tool.inputs.length === 0 || tool.inputs.some((g) => entryWithin(file, g));
}

/**
 * True when an OUTSTANDING item already covers `file`: an open (or contested)
 * item's scope hint, a claimed item's write intent (its owner narrowed the rest
 * away), or an undecided proposal's scope. Done, rejected, and split items and
 * tool items cover nothing.
 */
export function coveredByOutstanding(
  file: string,
  items: NonNullable<Input["board"]["items"]>,
  pending: NonNullable<Input["board"]["pendingItems"]>,
): boolean {
  const within = (entries: readonly string[]) => entries.some((e) => entryWithin(file, intentPath(e)));
  for (const item of items) {
    if (item.tool !== undefined) {
      continue;
    }
    if ((item.status === "open" || item.status === "contested") && within(item.scopeHint)) {
      return true;
    }
    if (item.status === "claimed" && within(item.write ?? item.scopeHint)) {
      return true;
    }
  }
  return pending.some((p) => p.tool === undefined && within(p.scopeHint));
}

/** The concrete, unprotected repo files a write intent covers. */
function filesOf(input: Input, write: readonly string[]): string[] {
  return input.repo.files.filter(
    (f) => write.some((w) => matchesGlob(f, intentPath(w))) && !input.digest.protected.some((p) => entryWithin(f, p) || f === p),
  );
}

/**
 * True when building a tool should stop: its own gate failed twice, or two
 * build attempts were refused (for example a rebuild that changed nothing),
 * or three builds were tried.
 */
function toolBuildsSpent(input: Input, capability: string, ownerFailures: number): boolean {
  const builds = input.capsule.decisions.filter((h) => h.action.type === "build_tool" && h.action.capability === capability);
  return ownerFailures >= 2 || builds.filter((h) => h.outcome !== "posted").length >= 2 || builds.length >= 3;
}

/** The tool actions of a worker, or undefined when no tool rule applies. */
function toolAction(input: Input, stage: "held" | "free"): AgentAction | undefined {
  const d = input.digest;
  const me = input.agent;
  const decisions = input.capsule.decisions;
  const tools = input.board.tools ?? [];
  const items = input.board.items ?? [];
  const pending = input.board.pendingItems ?? [];

  if (stage === "held") {
    // My own accepted tool item comes first, even while I hold other work:
    // others may be waiting for it.
    for (const tool of tools) {
      if (tool.proposedBy !== me || tool.status !== "open") {
        continue;
      }
      const refused = decisions.filter((h) => h.action.type === "claim" && h.action.itemId === tool.item && h.outcome !== "posted").length;
      if (refused < 2) {
        return { type: "claim", itemId: tool.item, intent: { read: [], write: [`tools/${tool.capability}/**`] }, rationale: `building the tool I proposed (${tool.capability})` };
      }
    }
    // Build a tool item I hold (a rebuild after a failed gate, bounded).
    for (const claim of d.claims) {
      const tool = tools.find((t) => t.item === claim.item);
      if (!tool || tool.versions.length > 0 || toolBuildsSpent(input, tool.capability, tool.ownerFailures ?? tool.failedGates)) {
        continue;
      }
      return {
        type: "build_tool",
        capability: tool.capability,
        rationale: tool.failedGates > 0 ? `rebuilding ${tool.capability} after its own gate failed` : `building the ${tool.kind} ${tool.capability} other agents will run`,
      };
    }

    // Findings of a scanner I built that no outstanding item covers become one proposal.
    const proposed = decisions.flatMap((h) => (h.action.type === "propose_item" && h.action.fromTool !== undefined ? h.action.scopeHint : []));
    for (const m of input.messages) {
      if (m.type !== "tool.used" || (m.payload.findings ?? []).length === 0) {
        continue;
      }
      const tool = tools.find((t) => t.capability === m.payload.capability);
      const version = tool?.versions.find((v) => v.version === m.payload.version);
      if (!tool || !version || version.publishedBy !== me) {
        continue;
      }
      const findings = m.payload.findings ?? [];
      const files = [...new Set(findings.map((f) => f.path))]
        .filter((f) => !coveredByOutstanding(f, items, pending) && !proposed.includes(f) && !d.protected.some((p) => entryWithin(f, p) || f === p))
        .sort();
      if (files.length === 0) {
        continue;
      }
      const places = findings.filter((f) => files.includes(f.path)).length;
      return {
        type: "propose_item",
        objective: `Apply the change ${tool.capability} finds at ${places} place(s) that no outstanding item covers: ${files.join(", ")}`.slice(0, 500),
        acceptance: [`${tool.capability} finds nothing left in ${files.join(", ")}`.slice(0, 500), "the change gate passes on an integrated revision that merges this item's push"],
        scopeHint: files.slice(0, 64),
        fromTool: { capability: tool.capability, version: version.version },
        rationale: `${m.payload.by === me ? "my" : `${m.payload.by}'s`} run of ${tool.capability}@${version.version} (seq ${m.seq}) found ${places} place(s) no outstanding item covers`,
      };
    }

    // Held items with no push of mine yet: a published scanner, then a codemod.
    for (const claim of d.claims) {
      if (tools.some((t) => t.item === claim.item) || claim.fix !== undefined || (claim.lastPush && claim.lastPush.agent === me)) {
        continue;
      }
      const files = filesOf(input, claim.intent.write);
      const usedOn = (capability: string) =>
        decisions.filter((h) => h.action.type === "use_tool" && h.action.capability === capability && h.action.itemId === claim.item);
      const scanner = tools.find((t) => t.kind === "scanner" && latest(t) !== undefined && files.some((f) => toolCovers(t, f)));
      const codemod = tools.find((t) => t.kind === "codemod" && latest(t) !== undefined && files.some((f) => toolCovers(t, f)));
      if (scanner && usedOn(scanner.capability).length === 0) {
        return {
          type: "use_tool",
          capability: scanner.capability,
          version: latest(scanner)!.version,
          args: files.filter((f) => toolCovers(scanner, f)),
          itemId: claim.item,
          rationale: `finding every place in item ${claim.item} that needs the change before editing`,
        };
      }
      if (codemod && usedOn(codemod.capability).length === 0) {
        const scan = scanner ? usedOn(scanner.capability).at(-1) : undefined;
        const flagged = scan?.note?.files !== undefined ? scan.note.files.split(",").filter((f) => files.includes(f)) : undefined;
        const targets = flagged ?? files.filter((f) => toolCovers(codemod, f));
        if (targets.length > 0) {
          return {
            type: "use_tool",
            capability: codemod.capability,
            version: latest(codemod)!.version,
            args: targets,
            itemId: claim.item,
            rationale: `applying the repeated change with ${codemod.capability} instead of editing ${targets.length} file(s) by hand`,
          };
        }
      }
      // Tools are accelerators, never prerequisites: with no published tool
      // for this item, it is edited by hand now (the normal edit below).
    }
    return undefined;
  }

  // Free: my own accepted tool item first, then a tool the lead seeded
  // (other agents' items wait for it).
  const plannedTools = new Set(items.filter((i) => i.tool !== undefined && i.planned === true).map((i) => i.item));
  for (const tool of [...tools.filter((t) => t.proposedBy === me), ...tools.filter((t) => t.proposedBy !== me && plannedTools.has(t.item))]) {
    if (tool.status !== "open") {
      continue;
    }
    const refused = decisions.filter((h) => h.action.type === "claim" && h.action.itemId === tool.item && h.outcome !== "posted").length;
    if (refused < 2) {
      return {
        type: "claim",
        itemId: tool.item,
        intent: { read: [], write: [`tools/${tool.capability}/**`] },
        rationale: tool.proposedBy === me ? `building the tool I proposed (${tool.capability})` : `building the ${tool.kind} ${tool.capability} the lead seeded; other items wait for it`,
      };
    }
  }

  // A repeated mechanical change across the planned items: propose a tool for it (one per agent).
  if (!decisions.some((h) => h.action.type === "propose_tool")) {
    const need = detectBoardToolNeed(
      items
        .filter((i) => i.planned === true)
        .map((i) => ({ item: i.item, scopeHint: i.scopeHint, status: i.status, objective: i.objective, ...(i.tool !== undefined || i.fromTool !== undefined ? { tool: true } : {}) })),
      input.repo.files,
      { protected: d.protected },
    );
    if (need) {
      const has = (capability: string) => tools.some((t) => t.capability === capability);
      const why = `${need.items.length} items (${need.items.join(", ")}) apply the same "${need.editKind}" change across ${need.files.length} files`;
      if (!has(need.scanner)) {
        return {
          type: "propose_tool",
          capability: need.scanner,
          kind: "scanner",
          why: `${why}: a scanner finds every place in the repository that needs it, including any the plan missed`,
          // A scanner looks everywhere (no inputs: the whole repository); only a codemod's changes are scoped.
          inputs: [],
          outputs: ["findings"],
        };
      }
      if (!has(need.codemod)) {
        return {
          type: "propose_tool",
          capability: need.codemod,
          kind: "codemod",
          why: `${why}: one codemod applies it the same way everywhere instead of hand edits`,
          inputs: [...need.scope],
          outputs: ["edits"],
        };
      }
    }
  }

  // A scanner I built: re-run it over the latest passing revision when new code landed (a sweep).
  const rev = d.integrated?.n ?? 0;
  for (const tool of tools) {
    const version = latest(tool);
    if (tool.kind !== "scanner" || !version || version.publishedBy !== me) {
      continue;
    }
    const sweeps = decisions.filter((h) => h.action.type === "use_tool" && h.action.capability === tool.capability && h.action.itemId === undefined);
    const lastRev = Number(sweeps.at(-1)?.note?.rev ?? 0);
    // The first sweep right after publishing (the whole repo as it is), then one per new passing revision.
    if ((sweeps.length === 0 || rev > lastRev) && sweeps.length < 4) {
      return {
        type: "use_tool",
        capability: tool.capability,
        version: version.version,
        args: [],
        rationale: rev === 0 ? `running ${tool.capability} over the whole repository to find every place that needs the change` : `re-running ${tool.capability} over revision ${rev} to find any place still missing the change`,
      };
    }
  }
  return undefined;
}

function decide(input: Input): AgentAction {
  const d = input.digest;
  const me = input.agent;
  const decisions = input.capsule.decisions;

  if (input.role === "lead") {
    // Contracts on the original tests or the gate's configuration are a
    // human's to decide; the lead decides only the others.
    const contract = input.board.pendingContracts.find((c) => !c.protected);
    if (contract) {
      const clash = input.board.liveClaims.some(
        (c) => c.owner !== contract.proposedBy && c.write.some((w) => entriesOverlap(w, contract.target)),
      );
      return {
        type: "decide_contract",
        contractId: contract.contract,
        decision: clash ? "reject" : "accept",
        rationale: clash
          ? `${contract.target} is inside another agent's claimed write intent`
          : `${contract.target} is not held by anyone but the proposer`,
      };
    }
    const proposal = input.board.pendingItems?.[0];
    if (proposal?.tool !== undefined) {
      // A tool is internal work: it must pass its own gate, and it never counts toward the Change.
      return {
        type: "decide_item",
        itemId: proposal.item,
        decision: "accept",
        rationale: `${proposal.tool} is a tool other agents can run instead of repeating hand edits; it is published only if it passes its own gate`,
      };
    }
    if (proposal?.fromTool !== undefined) {
      const covered = proposal.scopeHint.filter((f) => coveredByOutstanding(f, input.board.items ?? [], (input.board.pendingItems ?? []).filter((p) => p.item !== proposal.item)));
      const empty = proposal.scopeHint.length === 0;
      return {
        type: "decide_item",
        itemId: proposal.item,
        decision: covered.length === 0 && !empty ? "accept" : "reject",
        rationale:
          covered.length === 0 && !empty
            ? `${proposal.item} is new work: ${proposal.fromTool.capability} found it in files no outstanding item covers`
            : empty
              ? `${proposal.item} is not taken: it declares no scope`
              : `${proposal.item} duplicates outstanding work: ${covered.join(", ")} is already covered`,
      };
    }
    if (proposal) {
      const dup = duplicateOf(proposal, input.board.items ?? []);
      return {
        type: "decide_item",
        itemId: proposal.item,
        decision: dup === undefined ? "accept" : "reject",
        rationale:
          dup === undefined
            ? `${proposal.item} adds work no existing item covers`
            : dup.item !== undefined
              ? `${proposal.item} duplicates item ${dup.item}: ${dup.why}`
              : `${proposal.item} is not taken: ${dup.why}`,
      };
    }
    return { type: "wait", reason: "no contract or proposed item awaits a decision" };
  }

  // 2. Contests the agent is party to.
  for (const contest of d.contests) {
    if (contest.status !== "open") {
      continue;
    }
    if (contest.claimant === me) {
      const write = claimedWrite(input, contest.item) ?? contest.overlap;
      const narrower = narrowed(input, write, overlappingEntries(write, contest.overlap));
      return narrower.length > 0
        ? {
            type: "contest_reply",
            contestId: contest.id,
            reply: "narrow",
            write: narrower,
            rationale: `narrowing to what ${contest.owner} does not hold`,
          }
        : { type: "contest_reply", contestId: contest.id, reply: "cede", rationale: "nothing is left once the overlap is removed" };
    }
    if (contest.owner === me && contest.turns === 0) {
      return { type: "contest_reply", contestId: contest.id, reply: "keep", rationale: `item ${contest.ownerItem} is already granted to me` };
    }
  }

  // 3. Answer requests addressed to me.
  const answered = new Set(
    decisions.flatMap((h) => (h.action.type === "message" && h.action.kind === "reply" && h.action.payload.requestId ? [h.action.payload.requestId] : [])),
  );
  for (const m of input.messages) {
    if (m.type === "help.requested" && m.to?.includes(me) && !answered.has(m.payload.request)) {
      return {
        type: "message",
        kind: "reply",
        to: [m.from],
        payload: { requestId: m.payload.request },
        rationale: `answering ${m.from} on item ${m.payload.item}: my write intent stays as granted; yours is clear of it`,
      };
    }
  }

  // 4. After narrowing, ask the other party about the shared boundary.
  const asked = new Set(
    decisions.flatMap((h) => (h.action.type === "message" && h.action.kind === "question" && h.outcome === "posted" ? [h.note?.to ?? ""] : [])),
  );
  for (const h of decisions) {
    const owner = h.note?.owner;
    const item = h.note?.item;
    if (
      h.action.type === "contest_reply" &&
      h.action.reply === "narrow" &&
      h.outcome === "posted" &&
      owner !== undefined &&
      item !== undefined &&
      !asked.has(owner) &&
      d.claims.some((c) => c.item === item)
    ) {
      return {
        type: "message",
        kind: "question",
        to: [owner],
        payload: { itemId: item, need: "shared-boundary" },
        rationale: `I narrowed item ${item} away from your write intent; tell me if you also need any file I kept`,
      };
    }
  }

  // 5. Work on held items: a requested fix first.
  const fixFirst = d.claims.some((c) => c.fix !== undefined);
  const toolTurn = fixFirst ? undefined : toolAction(input, "held");
  if (toolTurn) {
    return toolTurn;
  }
  for (const claim of d.claims) {
    if (claim.fix !== undefined) {
      const failedFixes = decisions.filter(
        (h) => h.action.type === "edit" && h.action.itemId === claim.item && h.outcome !== "posted" && h.note?.fix === String(claim.fix!.n),
      ).length;
      if (failedFixes < 2) {
        return {
          type: "edit",
          itemId: claim.item,
          instruction: `Fix what failed the integration gate on revision ${claim.fix.n} (attempt ${claim.fix.attempt}): ${claim.objective}`,
        };
      }
    }
  }
  const toolItems = new Set((input.board.tools ?? []).map((t) => t.item));
  for (const claim of d.claims) {
    // A tool item is built (build_tool above), never edited or proposed done.
    if (toolItems.has(claim.item)) {
      continue;
    }
    // No push yet, or only the previous owner's (a handed-off item): edit it.
    if (!claim.lastPush || claim.lastPush.agent !== me) {
      const failedEdits = decisions.filter((h) => h.action.type === "edit" && h.action.itemId === claim.item && h.outcome !== "posted").length;
      if (failedEdits >= 2) {
        continue;
      }
      return { type: "edit", itemId: claim.item, instruction: `Implement: ${claim.objective}` };
    }
    if (!claim.doneProposed) {
      return { type: "propose_done", itemId: claim.item, rationale: `pushed ${claim.lastPush.commit}` };
    }
  }

  // 6. Claim the first open item not already refused. A claim refused because
  //    it touches the contract (PROTECTED) goes through the contract route:
  //    propose the change for each protected entry it needs, wait for the
  //    decision, then claim once more (a second PROTECTED refusal gives up).
  // A tool whose builds are spent no longer keeps its builder from other work.
  const spentTools = new Set(
    (input.board.tools ?? [])
      .filter((t) => t.versions.length === 0 && toolBuildsSpent(input, t.capability, t.ownerFailures ?? t.failedGates))
      .map((t) => t.item),
  );
  const free = d.pending.length === 0 && d.claims.every((c) => spentTools.has(c.item) || (c.doneProposed && c.fix === undefined));
  if (free) {
    const freeTurn = toolAction(input, "free");
    if (freeTurn) {
      return freeTurn;
    }
    // A worker's tool item is claimed by whoever proposed it (another agent's is left to it).
    const seeded = new Set((input.board.items ?? []).filter((i) => i.tool !== undefined && i.planned === true).map((i) => i.item));
    const otherTools = new Set((input.board.tools ?? []).filter((t) => t.proposedBy !== me && !seeded.has(t.item)).map((t) => t.item));
    for (const open of d.openItems.filter((i) => i.scopeHint.length > 0 && !otherTools.has(i.item))) {
      const claims = decisions.filter((h) => h.action.type === "claim" && h.action.itemId === open.item);
      const last = claims.at(-1);
      if (last === undefined || last.outcome === "posted") {
        return {
          type: "claim",
          itemId: open.item,
          intent: { read: [], write: [...open.scopeHint] },
          rationale: `taking the first open item; writing its scope hint`,
        };
      }
      const protectedRefusals = claims.filter((h) => h.outcome === "rejected" && h.code === "PROTECTED").length;
      if (last.code !== "PROTECTED" || protectedRefusals >= 3 || last.action.type !== "claim") {
        continue;
      }
      const write = last.action.intent.write;
      const hits = d.protected.filter((p) => write.some((w) => entriesOverlap(w, p)));
      // A human already said no for this item (the board refuses repeat
      // proposals with CONTRACT_REJECTED): go straight to a new test file.
      const contractRefused = decisions.some(
        (h) => h.action.type === "message" && h.action.kind === "contract" && h.action.payload.itemId === open.item && h.code === "CONTRACT_REJECTED",
      );
      if (protectedRefusals === 2 || contractRefused) {
        // The human did not release every path: add a NEW test file instead,
        // beside the first protected test, named after the item.
        const first = hits.find((p) => !/[*?]/.test(p));
        const suffix = first ? /(\.(test|spec)\.[A-Za-z0-9]+)$/.exec(first)?.[1] : undefined;
        if (first && suffix) {
          const dir = first.includes("/") ? first.slice(0, first.lastIndexOf("/") + 1) : "";
          const fresh = `${dir}${open.item}${suffix}`;
          if (!d.protected.includes(fresh)) {
            return {
              type: "claim",
              itemId: open.item,
              intent: { read: [], write: [fresh] },
              rationale: "the existing tests stay as they are; adding a new test file instead",
            };
          }
        }
        continue;
      }
      const proposed = decisions.flatMap((h) =>
        h.action.type === "message" && h.action.kind === "contract" && h.action.payload.itemId === open.item && h.outcome === "posted"
          ? [h.action.payload.target ?? ""]
          : [],
      );
      // One contract per protected path the claim needs, each a concrete path
      // from the contract (a human decides each).
      // Another agent already asked for this item: wait for the human's answer.
      if (input.board.pendingContracts.some((c) => c.item === open.item && c.proposedBy !== me)) {
        continue;
      }
      const needed = hits.filter((p) => !proposed.includes(p));
      if (needed.length > 0) {
        return {
          type: "message",
          kind: "contract",
          payload: { target: needed[0]!, change: "modify", itemId: open.item },
          rationale: `item ${open.item} needs to change ${needed[0]}, which is part of the original tests or the gate's configuration`,
        };
      }
      if (input.board.pendingContracts.some((c) => c.proposedBy === me && c.item === open.item)) {
        continue; // waiting for the lead or a human to decide
      }
      return {
        type: "claim",
        itemId: open.item,
        intent: { read: [], write: [...write] },
        rationale: "claiming again now that the contract change was decided",
      };
    }
  }
  return { type: "wait", reason: free ? "no open item I can claim" : "waiting on the board" };
}

/** The deterministic generic policy as a turn transport. */
export function createGenericBoardPolicy(): AgentTurnTransport<BoardDigest, BoardMessage> {
  return async (input): Promise<AgentTurnOutcome> => ({ action: decide(input), model: "generic-policy" });
}
