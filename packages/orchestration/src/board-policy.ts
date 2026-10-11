/**
 * board-policy: a deterministic, goal-agnostic stand-in for the model behind an
 * agent turn. It is the fake turn transport offline runs and tests use, so a
 * board run is reproducible with no network.
 *
 * The policy reads only what a live model reads (the agent's digest, its own
 * past decisions, the public board facts, and the repo listing) and applies
 * generic rules, in priority order:
 *   0. the lead extends a claim near its firm deadline whose holder is
 *      progressing (digest.deadlines), and lets a stalled one lapse; it
 *      RE-PLANS an item that is not getting done (board.replan) once: when the
 *      failure names files outside its scope that no outstanding item covers
 *      it re-scopes it to cover them; when its scope spans several files and
 *      the failure names some, it splits it (one child per failing file, the
 *      rest per directory or file); otherwise fresh eyes go first, and once
 *      they spent the budget too (or the item stopped moving twice) a
 *      single-file item merges with an open neighbour in its directory, else
 *      it is re-scoped to the failing tests;
 *   1. the lead decides pending contracts (accept unless the target overlaps a
 *      write intent held by someone other than the proposer; a seam contract
 *      is also rejected when it duplicates another live seam change or the
 *      failing output does not name its seam), then workers'
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
 *      a fix whose type error needs a frozen shared seam proposes a seam
 *      contract instead (the lead accepts it unless someone holds the seam),
 *      and the proposer claims the seam item it became first;
 *   6. while free, claim the first open item it has not been refused (seam
 *      items first, then items whose scope overlaps no other holder's), with the
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
 * Formation (splits, sub-leads, fork-based help), woven in:
 *   - SPLIT: a held item the planner did not decompose (a worker's or a
 *     tool's proposal, not a planned item) with no push yet, whose write
 *     intent spans at least two files no codemod covers (several distinct
 *     sub-changes, not one repeated change), is split into children, one per
 *     directory when they span several, else one per file; the owner becomes
 *     the SUB-LEAD and leaves its children to others (it claims one itself
 *     only after waiting twice); when children push, it pulls them (one
 *     merged push upward);
 *   - HELP: after a codemod pushed the mechanical part of an item across
 *     several files, the hand pass that remains can go in parallel: the owner
 *     grants the second half of the files to a helper (help.requested with
 *     scope) and does not propose done until it pulls the delivered work; a
 *     free agent takes such a request (the runtime forks the requester's
 *     repo), edits the granted files in its fork, and delivers;
 *   - TOOL TIMING: while a codemod covering a held item is being built (not
 *     published, not unavailable), the owner first spends at most two turns
 *     reading its files (a wait) before editing by hand.
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

/** Turns spent exploring an item while a codemod for it is built (bounded). */
export const MAX_EXPLORE_TURNS = 2;

/** The codemods (published, or still being built and not unavailable) whose inputs cover any of `files`. */
function codemodsCovering(input: Input, files: readonly string[]): BoardToolFact[] {
  return (input.board.tools ?? []).filter((t) => t.kind === "codemod" && t.status !== "rejected" && files.some((f) => toolCovers(t, f)));
}

/**
 * The children of a split: one per directory when the files span several
 * directories, else one per file (at most 32). Each child's scope is its
 * concrete files, inside the owner's write intent.
 */
function splitChildren(objective: string, files: readonly string[]): { objective: string; acceptance: string[]; scopeHint: string[] }[] {
  const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".");
  const dirs = [...new Set(files.map(dirOf))];
  const groups = dirs.length >= 2 ? dirs.map((d) => files.filter((f) => dirOf(f) === d)) : files.map((f) => [f]);
  const capped = groups.length > 32 ? [...groups.slice(0, 31), groups.slice(31).flat()] : groups;
  return capped.map((group) => ({
    objective: `${objective.split(" (claim this item now")[0]}: ${group.join(", ")}`.slice(0, 500),
    acceptance: ["the change gate passes on an integrated revision that merges the sub-lead's push"],
    scopeHint: group,
  }));
}

/** The formation actions of a worker (sub-lead pulls, help), or undefined. */
function formationAction(input: Input): AgentAction | undefined {
  const d = input.digest;
  const decisions = input.capsule.decisions;
  const failed = (pred: (a: AgentAction) => boolean) => decisions.filter((h) => pred(h.action) && h.outcome !== "posted").length;
  // An owner answers a volunteer on its item: it hands over the second half of
  // the item's files when there are several, else declines (nothing to divide).
  for (const volunteer of d.volunteers ?? []) {
    const claim = d.claims.find((c) => c.item === volunteer.item);
    if (!claim || decisions.some((h) => h.action.type === "answer_volunteer" && h.action.itemId === volunteer.item && h.action.volunteer === volunteer.agent && h.outcome === "posted")) {
      continue;
    }
    // The item's files: existing ones its intent covers, plus concrete new paths it names.
    const files = [
      ...new Set([
        ...filesOf(input, claim.intent.write),
        ...claim.intent.write.map(intentPath).filter((w) => !hasWildcard(w) && !d.protected.some((p) => entryWithin(w, p) || w === p)),
      ]),
    ].sort();
    const granted = (d.help?.mine ?? []).filter((h) => h.item === claim.item && h.live).flatMap((h) => h.scope);
    const free = files.filter((f) => !granted.includes(f));
    if (free.length >= 2 && claim.fix === undefined) {
      const scope = free.slice(Math.ceil(free.length / 2));
      return { type: "answer_volunteer", itemId: claim.item, volunteer: volunteer.agent, accept: true, scope, rationale: `${volunteer.agent} takes ${scope.join(", ")} (it forks my repo); I keep the rest` };
    }
    // Struggling on a single file: fresh eyes take it (from my repo's state).
    if (free.length === 1 && claim.fix === undefined && (d.struggling ?? []).some((s) => s.item === claim.item)) {
      return {
        type: "answer_volunteer",
        itemId: claim.item,
        volunteer: volunteer.agent,
        accept: true,
        scope: free,
        rationale: `${claim.item} is going badly for me; ${volunteer.agent} takes ${free[0]} with fresh eyes, starting from my repo`,
      };
    }
    return {
      type: "answer_volunteer",
      itemId: claim.item,
      volunteer: volunteer.agent,
      accept: false,
      rationale: claim.fix !== undefined ? "I am answering a fix request on it now" : `${claim.item} has no second file to hand over`,
    };
  }
  // A helper delivers the granted files first (someone is waiting for them).
  for (const grant of d.help?.granted ?? []) {
    if (!grant.live || grant.delivered !== undefined) {
      continue;
    }
    if (failed((a) => a.type === "edit" && a.itemId === grant.item) < 2) {
      return { type: "edit", itemId: grant.item, instruction: `Help ${grant.by} on ${grant.item}: finish ${grant.scope.join(", ")}` };
    }
  }
  // A requester pulls a helper's delivered work.
  for (const help of d.help?.mine ?? []) {
    if (help.delivered !== undefined && !help.pulled && failed((a) => a.type === "pull" && a.requestId === help.request) < 2) {
      return { type: "pull", itemId: help.item, requestId: help.request, rationale: `${help.grantee} delivered ${help.delivered.commit} for ${help.scope.join(", ")}` };
    }
  }
  // A sub-lead merges its children's new pushes into one push upward.
  for (const led of d.subLead ?? []) {
    // A child the sub-lead pushed itself integrates directly: only others' pushes are merged.
    const fresh = led.children.filter((c) => c.lastPush !== undefined && c.lastPush.integratedIn === undefined && !c.merged && c.unverified !== true && c.lastPush.agent !== d.agent);
    if (fresh.length > 0 && failed((a) => a.type === "pull" && a.itemId === led.item && a.requestId === undefined) < 3) {
      return {
        type: "pull",
        itemId: led.item,
        rationale: `as sub-lead of ${led.item}, merging ${fresh.map((c) => `${c.item} (${c.owner ?? "?"})`).join(", ")} into one push`,
      };
    }
  }
  return undefined;
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

/** The directory of a path ("." at the root). */
function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
}

/**
 * The lead's one re-plan of an item that is not getting done (board.replan),
 * from its failure attribution, or undefined when nothing is due. Generic:
 * files and test lines come from the gate's own output and the repo listing.
 */
function replanAction(input: Input): AgentAction | undefined {
  const d = input.digest;
  for (const cue of input.board.replan ?? []) {
    if (input.capsule.decisions.some((h) => h.action.type === "replan_item" && h.action.itemId === cue.item)) {
      continue;
    }
    const unprotected = (f: string) => !d.protected.some((p) => entryWithin(f, p) || f === p);
    const inScope = (f: string) => cue.scopeHint.some((h) => entryWithin(f, intentPath(h)));
    const objective = cue.objective.split(" (claim this item now")[0]!;
    const evidence = cue.rev !== undefined ? `revision ${cue.rev}` : "its latest failing revision";
    const acceptance = ["the change gate passes on an integrated revision that merges this item's push"];
    // The failure names files no outstanding item covers: widen it to them.
    const outside = cue.failingFiles.filter(
      (f) => !inScope(f) && unprotected(f) && !coveredByOutstanding(f, input.board.items ?? [], input.board.pendingItems ?? []),
    );
    if (outside.length > 0) {
      return {
        type: "replan_item",
        itemId: cue.item,
        plan: "rescope",
        children: [{ objective: `${objective} (re-scoped: ${evidence} fails in ${outside.join(", ")})`.slice(0, 500), acceptance, scopeHint: [...cue.scopeHint, ...outside].slice(0, 64) }],
        rationale: `${cue.item} ${cue.reason === "stalled" ? "stopped moving twice" : "spent its fix budget"}; ${evidence} fails in ${outside.join(", ")}, outside its scope`,
      };
    }
    // Several files, and the failure names some of them: one child per failing file, the rest by directory (or file).
    const files = input.repo.files.filter((f) => inScope(f) && unprotected(f));
    const failing = cue.failingFiles.filter((f) => files.includes(f));
    if (files.length >= 2 && failing.length > 0) {
      const rest = files.filter((f) => !failing.includes(f));
      const children = [
        ...failing.map((f) => ({ objective: `${objective}: make ${f} pass ${evidence}`.slice(0, 500), acceptance, scopeHint: [f] })),
        ...(rest.length > 0 ? splitChildren(objective, rest) : []),
      ].slice(0, 32);
      if (children.length >= 2) {
        return {
          type: "replan_item",
          itemId: cue.item,
          plan: "split",
          children,
          rationale: `${cue.item} spans ${files.length} files and ${evidence} fails in ${failing.join(", ")}: smaller items other agents can take`,
        };
      }
    }
    // Nothing in the evidence calls for a different plan: fresh eyes go first,
    // and only once they also spent the budget (or it stopped moving) does the
    // lead re-plan it anyway.
    if (cue.reason === "fix-budget-exhausted" && cue.exhaustedBy.length < 2) {
      continue;
    }
    // A single file: merge with an open neighbour in the same directory, when there is one.
    const dirs = new Set(files.map(dirOf));
    const neighbour = cue.neighbours.find((n) => input.repo.files.some((f) => dirs.has(dirOf(f)) && n.scopeHint.some((h) => entryWithin(f, intentPath(h)))));
    if (neighbour) {
      return {
        type: "replan_item",
        itemId: cue.item,
        plan: "merge",
        withItemId: neighbour.item,
        children: [{ objective: `${objective}; and ${neighbour.objective}`.slice(0, 500), acceptance, scopeHint: [...new Set([...cue.scopeHint, ...neighbour.scopeHint])].slice(0, 64) }],
        rationale: `${cue.item} and ${neighbour.item} touch the same directory: one owner does both`,
      };
    }
    return {
      type: "replan_item",
      itemId: cue.item,
      plan: "rescope",
      children: [
        {
          objective: `${objective} (re-planned: make ${cue.failingTests.length > 0 ? cue.failingTests.slice(0, 2).join("; ") : `${evidence}'s failures`} pass)`.slice(0, 500),
          acceptance,
          scopeHint: [...cue.scopeHint],
        },
      ],
      rationale: `${cue.item} ${cue.reason === "stalled" ? "stopped moving twice" : "spent its fix budget twice"}: a fresh item focused on the failing tests`,
    };
  }
  return undefined;
}

/** Options for the generic policy. */
export interface GenericBoardPolicyOptions {
  /** Prefer open items whose scope overlaps no other holder's (default true). */
  readonly preferNonOverlapping?: boolean;
}

function decide(input: Input, options: GenericBoardPolicyOptions = {}): AgentAction {
  const d = input.digest;
  const me = input.agent;
  const decisions = input.capsule.decisions;

  if (input.role === "lead") {
    // A claim near its firm deadline whose holder is progressing gets one more
    // period (a refused extension is not retried); a stalled one is left to lapse.
    for (const near of d.deadlines ?? []) {
      const refused = decisions.some((h) => h.action.type === "extend_claim" && h.action.itemId === near.item && h.outcome !== "posted");
      if (near.progressing && !refused) {
        return {
          type: "extend_claim",
          itemId: near.item,
          rationale: `${near.owner} is making progress on ${near.item} (last at board seq ${near.lastProgressSeq}); its deadline is ${near.remaining} message(s) away`,
        };
      }
    }
    const replan = replanAction(input);
    if (replan) {
      return replan;
    }
    // Contracts on the original tests or the gate's configuration are a
    // human's to decide; the lead decides only the others.
    const contract = input.board.pendingContracts.find((c) => !c.protected);
    if (contract) {
      const clash = input.board.liveClaims.some(
        (c) => c.owner !== contract.proposedBy && c.write.some((w) => entriesOverlap(w, contract.target)),
      );
      // A seam contract: only the declaration the failing revision needs, once.
      const seamReason =
        contract.seam === undefined
          ? undefined
          : contract.duplicateOf !== undefined
            ? `it duplicates the seam change ${contract.duplicateOf}: one seam change per failing cause`
            : contract.namedInFailure === false
              ? `the failing output does not name ${contract.seam}: a seam change is only for the shared declaration the error needs`
              : undefined;
      const reject = clash || seamReason !== undefined;
      return {
        type: "decide_contract",
        contractId: contract.contract,
        decision: reject ? "reject" : "accept",
        rationale: clash
          ? `${contract.target} is inside another agent's claimed write intent`
          : seamReason ?? `${contract.target} is not held by anyone but the proposer`,
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
    // (A request granting a scope is taken through the fork, below, not answered here.)
    if (m.type === "help.requested" && m.to?.includes(me) && m.payload.scope === undefined && !answered.has(m.payload.request)) {
      return {
        type: "message",
        kind: "reply",
        to: [m.from],
        payload: { requestId: m.payload.request },
        rationale: `answering ${m.from} on item ${m.payload.item}: my write intent stays as granted; yours is clear of it`,
      };
    }
  }

  // 3b. Formation: deliver granted help, pull delivered help, merge children (sub-lead).
  const formation = formationAction(input);
  if (formation) {
    return formation;
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

  // 5a. Split a held item that spans several distinct sub-changes (once, before any push).
  const itemFacts = new Map((input.board.items ?? []).map((i) => [i.item, i]));
  const toolItemIds = new Set((input.board.tools ?? []).map((t) => t.item));
  for (const claim of d.claims) {
    const fact = itemFacts.get(claim.item);
    // Planned items are already the planner's decomposition.
    if (claim.lastPush || claim.fix !== undefined || toolItemIds.has(claim.item) || fact?.parent !== undefined || fact?.planned === true) {
      continue;
    }
    const files = filesOf(input, claim.intent.write);
    const tried = decisions.some((h) => h.action.type === "split" && h.action.itemId === claim.item);
    if (files.length >= 2 && !tried && codemodsCovering(input, files).length === 0) {
      return {
        type: "split",
        itemId: claim.item,
        children: splitChildren(claim.objective, files),
        rationale: `${claim.item} spans ${files.length} files that are distinct sub-changes (no codemod covers them): splitting so other agents take parts; I integrate their pushes as sub-lead`,
      };
    }
  }

  // 5. Work on held items: a requested fix first.
  const fixFirst = d.claims.some((c) => c.fix !== undefined);
  const toolTurn = fixFirst ? undefined : toolAction(input, "held");
  if (toolTurn) {
    return toolTurn;
  }
  // The failing check is in the contract: ask a human to change it (once per path), then keep fixing.
  for (const claim of d.claims) {
    for (const target of claim.contractCue?.paths ?? []) {
      const asked = decisions.some((h) => h.action.type === "message" && h.action.kind === "contract" && h.action.payload.target === target);
      if (!asked && !input.board.pendingContracts.some((c) => c.target === target)) {
        return {
          type: "message",
          kind: "contract",
          payload: { target, change: "modify", itemId: claim.item },
          rationale: `the failing check of revision ${claim.fix?.n ?? "?"} is in the protected ${target}; if it pins the old behavior the goal changes, it needs a human's decision`,
        };
      }
    }
  }
  // The failing type error needs a change to a frozen shared seam: propose a
  // seam contract with the needed change (the lead decides), once per seam.
  for (const claim of d.claims) {
    for (const seam of claim.seamCue?.seams ?? []) {
      const asked = decisions.some(
        (h) => h.action.type === "message" && h.action.kind === "contract" && h.action.payload.target === seam && h.action.payload.itemId === claim.item,
      );
      if (!asked && !input.board.pendingContracts.some((c) => c.seam === seam)) {
        return {
          type: "message",
          kind: "contract",
          payload: {
            target: seam,
            change: "modify",
            itemId: claim.item,
            description: `${claim.item} needs the shared seam ${seam} to declare what its code uses: ${claim.seamCue!.errors[0] ?? "see the failing revision"}`.slice(0, 400),
          },
          rationale: `revision ${claim.fix?.n ?? "?"} failed on a type the shared seam ${seam} declares and no item owns; I need it changed rather than using an undeclared field`,
        };
      }
    }
  }
  // An OPEN seam item (nobody holds it) that my held items need: claim it myself
  // (seam items are exempt from the claim cap); nothing waits on anyone else.
  // Or when no change item of mine is in progress (I hold only tool items, or my
  // items are all proposed done): an open seam item goes to whoever has room.
  const myToolItems = new Set((input.board.tools ?? []).map((t) => t.item));
  const noChangeWork = d.claims.every((c) => myToolItems.has(c.item) || (c.doneProposed && c.fix === undefined));
  for (const open of d.openSeams ?? []) {
    const refused = decisions.some((h) => h.action.type === "claim" && h.action.itemId === open.item && h.outcome !== "posted" && h.code !== "CLAIM_CAP");
    if ((open.blocks.length > 0 || noChangeWork) && !refused) {
      return {
        type: "claim",
        itemId: open.item,
        intent: { read: [], write: [open.seam] },
        rationale: `${open.item} is open and nobody holds it; my ${open.blocks.join(", ")} need(s) it, so I make the seam change myself`,
      };
    }
  }
  // The seam item my accepted seam contract became: take it first (I know the change it needs).
  const askedSeams = new Set(
    decisions.flatMap((h) => (h.action.type === "message" && h.action.kind === "contract" && h.outcome === "posted" ? [h.action.payload.target ?? ""] : [])),
  );
  const mySeamItem = d.openItems.find(
    (i) =>
      i.seam === true &&
      i.scopeHint.length === 1 &&
      askedSeams.has(i.scopeHint[0]!) &&
      !decisions.some((h) => h.action.type === "claim" && h.action.itemId === i.item && h.outcome !== "posted"),
  );
  if (mySeamItem) {
    return {
      type: "claim",
      itemId: mySeamItem.item,
      intent: { read: [], write: [...mySeamItem.scopeHint] },
      rationale: `the lead accepted my seam contract: I make the change to ${mySeamItem.scopeHint[0]} first, then rebase my item onto it`,
    };
  }
  for (const claim of d.claims) {
    // A held item waiting for a shared seam change is fixed after it lands.
    if (claim.fix !== undefined && (claim.waitsFor ?? []).length === 0) {
      const failedFixes = decisions.filter(
        (h) => h.action.type === "edit" && h.action.itemId === claim.item && h.outcome !== "posted" && h.note?.fix === String(claim.fix!.n),
      ).length;
      if (failedFixes < 2) {
        return {
          type: "edit",
          itemId: claim.item,
          instruction:
            claim.regressed !== undefined
              ? `Fix the regression my push ${claim.regressed.commit.slice(0, 10)} introduced on revision ${claim.fix.n} (attempt ${claim.fix.attempt}; ${claim.regressed.to} against the best ${claim.regressed.from}): ${claim.objective}`
              : `Fix what failed the integration gate on revision ${claim.fix.n} (attempt ${claim.fix.attempt}): ${claim.objective}`,
        };
      }
    }
  }
  for (const claim of d.claims) {
    // The integrator left this claim's latest push out (push.excluded): edit
    // again (bounded), since that push is not re-gated as it is.
    if (claim.excluded !== undefined && claim.fix === undefined) {
      const failedEdits = decisions.filter(
        (h) => h.action.type === "edit" && h.action.itemId === claim.item && h.outcome !== "posted" && h.note?.excluded === claim.excluded!.commit,
      ).length;
      if (failedEdits < 2) {
        return {
          type: "edit",
          itemId: claim.item,
          instruction: `My push ${claim.excluded.commit.slice(0, 10)} was left out of integration (${claim.excluded.reason}): fix that, staying inside the write intent, then push again: ${claim.objective}`,
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
      // A codemod covering this item is being built: read the files first
      // (bounded), so a codemod published early is used before hand edits.
      const files = filesOf(input, claim.intent.write);
      const building = codemodsCovering(input, files).find((t) => t.versions.length === 0 && t.unavailable === undefined);
      const explored = decisions.filter((h) => h.action.type === "wait" && h.action.reason.startsWith(`exploring ${claim.item}:`)).length;
      if (building && explored < MAX_EXPLORE_TURNS && !claim.lastPush) {
        return {
          type: "wait",
          reason: `exploring ${claim.item}: reading ${files.length} file(s) while the codemod ${building.capability} is built (${explored + 1} of ${MAX_EXPLORE_TURNS}; then I edit by hand)`,
        };
      }
      // Struggling with idle agents around: give them one turn to volunteer
      // before editing again (once per item; a volunteer's offer wakes me).
      const waitedForVolunteer = decisions.some((h) => h.action.type === "wait" && h.action.reason.startsWith(`struggling on ${claim.item}:`));
      if (!waitedForVolunteer && (d.struggling ?? []).some((s) => s.item === claim.item) && (d.idleAgents ?? []).length > 0 && (d.help?.mine ?? []).every((h) => h.item !== claim.item)) {
        return { type: "wait", reason: `struggling on ${claim.item}: ${(d.idleAgents ?? []).length} idle agent(s) may volunteer; waiting one turn` };
      }
      // Everything this item writes is granted to a helper: wait for its delivery.
      const grantedAll = (d.help?.mine ?? []).filter((h) => h.item === claim.item && h.live && !h.pulled && h.grantee !== undefined).flatMap((h) => h.scope);
      if (grantedAll.length > 0 && files.every((f) => grantedAll.includes(f))) {
        continue;
      }
      return { type: "edit", itemId: claim.item, instruction: `Implement: ${claim.objective}` };
    }
    // A codemod pushed the mechanical part across several files: grant the
    // second half of the hand pass to a helper (once).
    const myHelp = (d.help?.mine ?? []).filter((h) => h.item === claim.item);
    const files = filesOf(input, claim.intent.write);
    const asked = decisions.some((h) => h.action.type === "message" && h.action.kind === "help" && h.action.payload.itemId === claim.item);
    const byCodemod = decisions.some(
      (h) =>
        h.action.type === "use_tool" &&
        h.action.itemId === claim.item &&
        h.outcome === "posted" &&
        Number(h.note?.changed ?? 0) >= 2 &&
        (input.board.tools ?? []).some((t) => t.kind === "codemod" && t.capability === (h.action as { capability: string }).capability),
    );
    if (!claim.doneProposed && byCodemod && files.length >= 2 && myHelp.length === 0 && !asked && claim.fix === undefined) {
      const scope = files.slice(Math.ceil(files.length / 2));
      return {
        type: "message",
        kind: "help",
        payload: { itemId: claim.item, need: "parallel-edit", scope },
        rationale: `a codemod pushed ${claim.item}'s mechanical change (${claim.lastPush.commit.slice(0, 10)}); a helper who forks my repo can do the hand pass on ${scope.join(", ")} in parallel`,
      };
    }
    // Work a helper has taken is part of the item: never propose done before pulling it.
    if (myHelp.some((h) => h.live && !h.pulled && h.grantee !== undefined)) {
      continue;
    }
    // An untaken grant blocks nothing: give a helper two of my turns to take it, then go on.
    const askedAt = decisions.map((h) => h.action.type === "message" && h.action.kind === "help" && h.action.payload.itemId === claim.item).lastIndexOf(true);
    if (myHelp.some((h) => h.live && h.grantee === undefined) && askedAt >= 0 && decisions.length - 1 - askedAt < 2) {
      return { type: "wait", reason: `waiting for a helper to take my grant on ${claim.item} (then I go on without it)` };
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
    // Idle with no open item: volunteer to an owner whose item is going badly (once per item).
    if (d.openItems.length === 0) {
      for (const busy of d.busyOwners ?? []) {
        if (!decisions.some((h) => h.action.type === "offer_help" && h.action.itemId === busy.item)) {
          return {
            type: "offer_help",
            itemId: busy.item,
            toAgent: busy.agent,
            why: `I hold nothing and ${busy.item} is going badly (${busy.reason}${busy.lastFailure ? `: ${busy.lastFailure.slice(0, 80)}` : ""}); I can fork your repo and take part of it`,
          };
        }
      }
    }
    // Take a help request that grants a scope (the runtime forks the requester's repo).
    for (const wanted of d.help?.wanted ?? []) {
      const offered = decisions.some((h) => h.action.type === "message" && h.action.kind === "reply" && h.action.payload.requestId === wanted.request);
      if (!offered) {
        return {
          type: "message",
          kind: "reply",
          payload: { requestId: wanted.request },
          rationale: `taking ${wanted.by}'s ${wanted.need} on ${wanted.item}: I fork its repo and finish ${wanted.scope.join(", ")}`,
        };
      }
    }
    // A worker's tool item is claimed by whoever proposed it (another agent's is left to it).
    const seeded = new Set((input.board.items ?? []).filter((i) => i.tool !== undefined && i.planned === true).map((i) => i.item));
    const otherTools = new Set((input.board.tools ?? []).filter((t) => t.proposedBy !== me && !seeded.has(t.item)).map((t) => t.item));
    // A sub-lead leaves its children to other agents; after waiting twice it may take one.
    const led = new Set((d.subLead ?? []).map((s) => s.item));
    const splitAt = decisions.map((h) => h.action.type === "split" && h.outcome === "posted").lastIndexOf(true);
    const waitedSinceSplit = splitAt < 0 ? 0 : decisions.slice(splitAt + 1).filter((h) => h.action.type === "wait").length;
    const mine = (i: { readonly parent?: string }) => i.parent !== undefined && led.has(i.parent) && waitedSinceSplit < 2;
    // Seam-changing items first; items waiting for one are left until it lands.
    // At the claim cap only open seam items (exempt) may be claimed.
    const openSeamItems = new Set((d.openSeams ?? []).map((o) => o.item));
    // An item whose claim of mine lapsed goes to another agent first.
    const lapsedMine = (i: (typeof d.openItems)[number]) => i.wait?.reason.kind === "lease-lapsed" && i.wait.reason.agent === me;
    const claimable = d.openItems
      .filter((i) => i.scopeHint.length > 0 && !otherTools.has(i.item) && !mine(i) && (i.waitsFor ?? []).length === 0 && !lapsedMine(i))
      .filter((i) => d.claimCap === undefined || openSeamItems.has(i.item))
      // Seam items first; then items whose scope overlaps no other holder's (fewer collisions).
      .sort(
        (a, b) =>
          Number(b.seam === true) - Number(a.seam === true) ||
          (options.preferNonOverlapping === false ? 0 : (a.overlapsClaimed?.length ?? 0) - (b.overlapsClaimed?.length ?? 0)),
      );
    for (const open of claimable) {
      const claims = decisions.filter((h) => h.action.type === "claim" && h.action.itemId === open.item);
      const last = claims.at(-1);
      // A claim refused at the cap is tried again once the agent has room.
      if (last === undefined || last.outcome === "posted" || last.code === "CLAIM_CAP") {
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
      // The acceptance gate is never contract-changeable: go straight to a new test file.
      const gateOnly = hits.length > 0 && hits.every((p) => (d.immutable ?? []).includes(p) || hasWildcard(p));
      // A human already said no for this item (the board refuses repeat
      // proposals with CONTRACT_REJECTED): go straight to a new test file.
      const contractRefused = decisions.some(
        (h) =>
          h.action.type === "message" && h.action.kind === "contract" && h.action.payload.itemId === open.item && (h.code === "CONTRACT_REJECTED" || h.code === "IMMUTABLE"),
      );
      if (protectedRefusals === 2 || contractRefused || gateOnly) {
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
      const needed = hits.filter((p) => !proposed.includes(p) && !(d.immutable ?? []).includes(p));
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
export function createGenericBoardPolicy(options: GenericBoardPolicyOptions = {}): AgentTurnTransport<BoardDigest, BoardMessage> {
  return async (input): Promise<AgentTurnOutcome> => ({ action: decide(input, options), model: "generic-policy" });
}
